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
  listFolder,
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
    try {
      await listFolder({ client, folderToken: existing.folderToken, maxItems: 1 })
      process.stderr.write(`[feishu-workspace] root folder loaded from disk token=${existing.folderToken}\n`)
      return existing
    } catch (error) {
      process.stderr.write(
        `[feishu-workspace] root folder probe failed (${error instanceof Error ? error.message : String(error)}); recreating\n`,
      )
    }
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
    try {
      await listFolder({ client, folderToken: existing.folderToken, maxItems: 1 })
      return existing
    } catch (error) {
      process.stderr.write(
        `[feishu-workspace] user folder probe failed for ${canonical} (${error instanceof Error ? error.message : String(error)}); recreating\n`,
      )
    }
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
