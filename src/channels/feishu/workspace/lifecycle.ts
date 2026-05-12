import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { FeishuClient } from '../client.js'
import { lightclawHome } from '../../../paths.js'
import { readJson, writeJsonSecure } from '../../../identity/store.js'
import { sanitizePathSegment } from '../../../identity/paths.js'
import { loadChannelConfig } from '../../config.js'
import {
  createFolder,
  grantFolderPermission,
} from '../resources/folder.js'

export type WorkspaceRoot = {
  folderToken: string
  createdAt: string
  lightclawVersion: string
}

export type UserWorkspace = {
  folderToken: string
  parentFolderToken: string
  createdAt: string
  ownerOpenId: string
}

export function workspaceRootPath(): string {
  return path.join(lightclawHome(), 'feishu-cloud-root.json')
}

export function userWorkspacePath(canonicalUser: string): string {
  return path.join(
    lightclawHome(),
    'identity',
    'per-user',
    sanitizePathSegment(canonicalUser),
    'feishu-workspace.json',
  )
}

export async function getOrCreateWorkspaceRoot(
  client: FeishuClient,
  options: { rootFolderTokenOverride?: string } = {},
): Promise<WorkspaceRoot> {
  const now = new Date().toISOString()
  const rootFolderTokenOverride = options.rootFolderTokenOverride ??
    loadChannelConfig().feishu.cloudSpace?.rootFolderToken
  const existing = await readJson<WorkspaceRoot | null>(workspaceRootPath(), null)
  if (rootFolderTokenOverride?.trim()) {
    const root = {
      folderToken: rootFolderTokenOverride.trim(),
      createdAt: existing?.createdAt ?? now,
      lightclawVersion: existing?.lightclawVersion ?? lightclawVersion(),
    }
    await writeJsonSecure(workspaceRootPath(), root)
    process.stderr.write(`[feishu-workspace] root folder override applied token=${root.folderToken}\n`)
    return root
  }

  if (existing?.folderToken) {
    // Trust the persisted token. Earlier versions probed via
    // `listFolder({maxItems:1})` and treated ANY 4xx as "folder gone, recreate",
    // which destroyed user data on a single transient 400 / rate-limit:
    // the recreated root orphaned the original folder along with every share
    // permission the user had granted to it. We now persist-or-warn instead:
    // if the folder is truly deleted, the next real `listFolder` call will
    // surface that to the agent / admin, and `/feishu-workspace status` can
    // confirm and let admin pick the right recovery (override config or
    // accept a new root deliberately). Auto-recreation is reserved for the
    // cold-start case (no on-disk record).
    process.stderr.write(`[feishu-workspace] root folder loaded from disk token=${existing.folderToken}\n`)
    return existing
  }

  const created = await createFolder({ client, parentFolderToken: '', name: 'LightClaw' })
  const root: WorkspaceRoot = {
    folderToken: created.folderToken,
    createdAt: now,
    lightclawVersion: lightclawVersion(),
  }
  await writeJsonSecure(workspaceRootPath(), root)
  process.stderr.write(`[feishu-workspace] root folder created token=${root.folderToken}\n`)
  return root
}

export async function getOrCreateUserWorkspace(
  client: FeishuClient,
  canonical: string,
  ownerOpenId: string,
  root: WorkspaceRoot,
): Promise<UserWorkspace> {
  const filePath = userWorkspacePath(canonical)
  const existing = await readJson<UserWorkspace | null>(filePath, null)
  if (existing?.folderToken) {
    // Same rationale as `getOrCreateWorkspaceRoot`: never auto-recreate a
    // user folder on probe failure. Transient 4xx would orphan the user's
    // private data + share grants. If the folder is truly gone, the next
    // real listFolder will report it cleanly and admin can use
    // `/feishu-workspace orphans` / `delete` for explicit recovery.
    return existing
  }

  const created = await createFolder({
    client,
    parentFolderToken: root.folderToken,
    name: canonical,
  })
  const workspace: UserWorkspace = {
    folderToken: created.folderToken,
    parentFolderToken: root.folderToken,
    createdAt: new Date().toISOString(),
    ownerOpenId,
  }
  const grant = await grantFolderPermission({
    client,
    folderToken: workspace.folderToken,
    openId: ownerOpenId,
    perm: 'full_access',
  })
  if (!grant.ok && !grant.alreadyExists) {
    process.stderr.write(`feishu-workspace user-folder grant failed: ${grant.error}\n`)
  }
  await writeJsonSecure(filePath, workspace)
  return workspace
}

let cachedVersion: string | null = null

function lightclawVersion(): string {
  if (cachedVersion !== null) {
    return cachedVersion
  }
  // src/channels/feishu/workspace/lifecycle.ts → ../../../../package.json
  // (works for both src/ tsx and dist/ bundled — dist is a single chunk so
  // import.meta.url is the dist file, and package.json sits one level up).
  const here = path.dirname(fileURLToPath(import.meta.url))
  for (const candidate of [
    path.resolve(here, '..', '..', '..', '..', 'package.json'),
    path.resolve(here, '..', 'package.json'),
  ]) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown }
      if (typeof parsed.version === 'string' && parsed.version.length > 0) {
        cachedVersion = parsed.version
        return cachedVersion
      }
    } catch {
      // Try the next candidate.
    }
  }
  cachedVersion = 'unknown'
  return cachedVersion
}
