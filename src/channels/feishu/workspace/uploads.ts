import path from 'node:path'

import type { FeishuClient } from '../client.js'
import { lightclawHome } from '../../../paths.js'
import { readJson, writeJsonSecure } from '../../../identity/store.js'
import { sanitizePathSegment } from '../../../identity/paths.js'
import { loadChannelConfig } from '../../config.js'
import { createFolder, grantFolderPermission } from '../resources/folder.js'
import { getWorkspaceParentCache } from './ancestry.js'
import type { UserWorkspace } from './lifecycle.js'

// Per-user subfolder that holds files SendFile pushed to drive when the IM
// 30 MB attachment ceiling would have rejected them. Same persistence /
// no-probe-recreate semantics as `feishu-workspace.json`: a single transient
// 4xx must not orphan the folder and the user's prior share grants.
export type UserUploadsFolder = {
  folderToken: string
  parentFolderToken: string
  name: string
  createdAt: string
  ownerOpenId: string
}

const inFlightByCanonical = new Map<string, Promise<UserUploadsFolder>>()

export function userUploadsFolderPath(canonicalUser: string): string {
  return path.join(
    lightclawHome(),
    'identity',
    'per-user',
    sanitizePathSegment(canonicalUser),
    'feishu-uploads.json',
  )
}

export async function getOrCreateUserUploadsFolder(
  client: FeishuClient,
  canonical: string,
  ownerOpenId: string,
  workspace: UserWorkspace,
): Promise<UserUploadsFolder> {
  const filePath = userUploadsFolderPath(canonical)
  const existing = await readJson<UserUploadsFolder | null>(filePath, null)
  if (existing?.folderToken) {
    // Same rationale as `getOrCreateUserWorkspace`: never auto-recreate on
    // probe failure. Persisted token is canonical; if the folder is truly
    // gone, the next real upload surfaces the error. Re-assert the owner
    // grant so a transient 4xx at birth doesn't permanently hide the
    // folder from the user.
    await ensureUploadsFolderGrant(client, existing.folderToken, ownerOpenId)
    getWorkspaceParentCache().observeChild(existing.folderToken, workspace.folderToken)
    return existing
  }
  const inFlight = inFlightByCanonical.get(canonical)
  if (inFlight) {
    return inFlight
  }
  const promise = createAndPersist(client, canonical, ownerOpenId, workspace, filePath)
    .finally(() => inFlightByCanonical.delete(canonical))
  inFlightByCanonical.set(canonical, promise)
  return promise
}

async function createAndPersist(
  client: FeishuClient,
  canonical: string,
  ownerOpenId: string,
  workspace: UserWorkspace,
  filePath: string,
): Promise<UserUploadsFolder> {
  const name = loadChannelConfig().feishu.cloudSpace?.uploadsFolderName?.trim() || 'LightClaw Uploads'
  const created = await createFolder({
    client,
    parentFolderToken: workspace.folderToken,
    name,
  })
  const record: UserUploadsFolder = {
    folderToken: created.folderToken,
    parentFolderToken: workspace.folderToken,
    name,
    createdAt: new Date().toISOString(),
    ownerOpenId,
  }
  await ensureUploadsFolderGrant(client, record.folderToken, ownerOpenId)
  await writeJsonSecure(filePath, record)
  getWorkspaceParentCache().observeChild(record.folderToken, workspace.folderToken)
  process.stderr.write(
    `[feishu-uploads] created folder canonical=${canonical} name="${name}" token=${record.folderToken}\n`,
  )
  return record
}

async function ensureUploadsFolderGrant(
  client: FeishuClient,
  folderToken: string,
  ownerOpenId: string,
): Promise<void> {
  // grantFolderPermission's catch arm logs non-already-exists failures
  // (see resources/folder.ts). Failure is non-fatal: a user who can see
  // the parent workspace folder will still typically see this subfolder
  // through inheritance, and the per-file grant SendFile applies to each
  // upload is the actual access path. The folder grant is belt-and-braces.
  await grantFolderPermission({
    client,
    folderToken,
    openId: ownerOpenId,
    perm: 'full_access',
  })
}

// Test helper. Clears the in-flight dedup map so unit tests can drive cold
// path on every call without sharing state.
export function _resetUploadsFolderInflightForTests(): void {
  inFlightByCanonical.clear()
}
