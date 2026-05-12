import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'

import { getFeishuClient } from '../channels/feishu/client.js'
import { deleteFile, listFolder } from '../channels/feishu/resources/folder.js'
import {
  userWorkspacePath,
  workspaceRootPath,
  type UserWorkspace,
  type WorkspaceRoot,
} from '../channels/feishu/workspace/lifecycle.js'
import { lightclawHome } from '../paths.js'
import { readJson } from '../identity/store.js'
import { sanitizePathSegment } from '../identity/paths.js'
import { recordFeishuWriteAudit } from '../tools/feishu-collab.js'

const DELETE_TOKEN_TTL_MS = 5 * 60 * 1000
const pendingDeleteTokens = new Map<string, { token: string; expiresAt: number; folderToken: string; itemCount: number }>()

export async function runFeishuWorkspaceCommand(rawArgs: string): Promise<string> {
  const args = rawArgs.trim().split(/\s+/).filter(Boolean)
  const sub = args[0] ?? 'status'
  switch (sub) {
    case 'status':
      return statusCommand()
    case 'list':
      return listCommand()
    case 'orphans':
      return orphansCommand()
    case 'delete':
      return deleteCommand(args.slice(1))
    default:
      return 'Usage: /feishu-workspace [status|list|orphans|delete <canonical> [--confirm <token>]]\n'
  }
}

async function statusCommand(): Promise<string> {
  const root = await readJson<WorkspaceRoot | null>(workspaceRootPath(), null)
  const workspaces = await listWorkspaceFiles()
  return [
    'Feishu cloud workspace:',
    `  root: ${root?.folderToken ?? '(not initialized)'}`,
    `  user folders: ${workspaces.length}`,
    '',
  ].join('\n')
}

async function listCommand(): Promise<string> {
  const workspaces = await listWorkspaceFiles()
  if (workspaces.length === 0) {
    return 'No Feishu cloud workspace folders recorded.\n'
  }
  const lines = ['canonical               folderToken                 updated']
  for (const item of workspaces) {
    lines.push(`${item.canonical.padEnd(23)} ${item.workspace.folderToken.padEnd(27)} ${item.updated}`)
  }
  return `${lines.join('\n')}\n`
}

async function orphansCommand(): Promise<string> {
  const root = await readJson<WorkspaceRoot | null>(workspaceRootPath(), null)
  if (!root?.folderToken) {
    return 'Feishu cloud workspace root is not initialized.\n'
  }
  const known = new Set((await listWorkspaceFiles()).map(item => item.workspace.folderToken))
  const listed = await listFolder({ client: getFeishuClient(), folderToken: root.folderToken })
  const orphans = listed.items.filter(item => item.type === 'folder' && !known.has(item.token))
  if (orphans.length === 0) {
    return 'No orphan Feishu workspace folders.\n'
  }
  return `${['orphan folderToken              name', ...orphans.map(item => `${item.token.padEnd(29)} ${item.name}`)].join('\n')}\n`
}

async function deleteCommand(args: string[]): Promise<string> {
  const canonical = args[0]
  if (!canonical) {
    return 'Usage: /feishu-workspace delete <canonical> [--confirm <token>]\n'
  }
  const workspace = await readJson<UserWorkspace | null>(userWorkspacePath(canonical), null)
  if (!workspace?.folderToken) {
    return `No Feishu workspace folder recorded for "${canonical}".\n`
  }
  const confirmIdx = args.indexOf('--confirm')
  if (confirmIdx < 0) {
    const itemCount = await listFolder({ client: getFeishuClient(), folderToken: workspace.folderToken })
      .then(result => result.items.length)
      .catch(() => 0)
    const token = Math.random().toString(36).slice(2, 8).toUpperCase()
    pendingDeleteTokens.set(canonical, {
      token,
      expiresAt: Date.now() + DELETE_TOKEN_TTL_MS,
      folderToken: workspace.folderToken,
      itemCount,
    })
    return [
      `Preview delete Feishu workspace for "${canonical}":`,
      `  folderToken: ${workspace.folderToken}`,
      `  direct items: ${itemCount}`,
      `Confirm with: /feishu-workspace delete ${canonical} --confirm ${token}`,
      'Token expires in 5 minutes.',
      '',
    ].join('\n')
  }
  const token = args[confirmIdx + 1]
  const pending = pendingDeleteTokens.get(canonical)
  if (!pending || pending.token !== token || pending.expiresAt < Date.now()) {
    pendingDeleteTokens.delete(canonical)
    return `Confirmation token for "${canonical}" is missing or expired. Run /feishu-workspace delete ${canonical} again.\n`
  }
  await deleteFile({ client: getFeishuClient(), token: workspace.folderToken, type: 'folder' })
  await rm(userWorkspacePath(canonical), { force: true })
  pendingDeleteTokens.delete(canonical)
  await recordFeishuWriteAudit({
    at: new Date().toISOString(),
    userId: canonical,
    operation: 'admin-delete-workspace',
    resource: { folderToken: workspace.folderToken, itemCount: pending.itemCount },
    status: 'confirmed',
  })
  return `Deleted Feishu workspace for "${canonical}" (${pending.itemCount} direct items moved to Feishu trash).\n`
}

async function listWorkspaceFiles(): Promise<Array<{ canonical: string; workspace: UserWorkspace; updated: string }>> {
  const root = path.join(lightclawHome(), 'identity', 'per-user')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out: Array<{ canonical: string; workspace: UserWorkspace; updated: string }> = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const filePath = path.join(root, entry.name, 'feishu-workspace.json')
    const workspace = await readJson<UserWorkspace | null>(filePath, null)
    if (!workspace?.folderToken) continue
    const updated = await stat(filePath).then(s => s.mtime.toISOString()).catch(() => workspace.createdAt)
    out.push({ canonical: entry.name, workspace, updated })
  }
  return out.sort((a, b) => sanitizePathSegment(a.canonical).localeCompare(sanitizePathSegment(b.canonical)))
}
