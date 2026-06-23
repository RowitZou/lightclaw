import { readdir, rm, stat } from 'node:fs/promises'

import { getFeishuClient } from '../channels/feishu/client.js'
import { feishuErrorMessage } from '../channels/feishu/resources/api.js'
import { deleteFile, listFolder } from '../channels/feishu/resources/folder.js'
import {
  userWorkspacePath,
  workspaceRootPath,
  type UserWorkspace,
  type WorkspaceRoot,
} from '../channels/feishu/workspace/lifecycle.js'
import { recordFeishuWriteAudit } from '../audit/feishu-writes.js'
import { t } from '../i18n/index.js'
import { readJson } from '../identity/store.js'
import {
  sanitizePathSegment,
  userFeishuWorkspacePath,
  usersRoot,
} from '../identity/paths.js'

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
      return `${t('feishuWs.usage')}\n`
  }
}

async function statusCommand(): Promise<string> {
  const root = await readJson<WorkspaceRoot | null>(workspaceRootPath(), null)
  const workspaces = await listWorkspaceFiles()
  const lines = [
    t('feishuWs.status.title'),
    t('feishuWs.status.root', { token: root?.folderToken ?? t('feishuWs.status.notInitialized') }),
    t('feishuWs.status.userFolders', { count: workspaces.length }),
  ]
  // Live drive API probe. Read-only, single listFolder with the smallest
  // page so we get either "ok" or a friendly scope-missing message. This
  // is the only place that proactively pings the drive API — the agent
  // tools never probe because doing so once spawned the
  // probe-then-recreate disaster of 2026-05-12 (see lifecycle.ts comment).
  // Status reads only, so it can't make that mistake.
  if (root?.folderToken) {
    try {
      await listFolder({ client: getFeishuClient(), folderToken: root.folderToken, maxItems: 1 })
      lines.push(t('feishuWs.status.driveOk'))
    } catch (error) {
      const scope = (error as { feishuScopeMissing?: { requiredScopes: string[] } })?.feishuScopeMissing
      if (scope) {
        lines.push(t('feishuWs.status.driveScopeMissing', {
          scopes: scope.requiredScopes.join(' or ') || t('feishuWs.status.scopeNone'),
        }))
      } else {
        lines.push(t('feishuWs.status.driveFailed', { detail: feishuErrorMessage(error) }))
      }
    }
  }
  lines.push('')
  return lines.join('\n')
}

async function listCommand(): Promise<string> {
  const workspaces = await listWorkspaceFiles()
  if (workspaces.length === 0) {
    return `${t('feishuWs.list.empty')}\n`
  }
  const lines = [t('feishuWs.list.header')]
  for (const item of workspaces) {
    lines.push(`${item.canonical.padEnd(23)} ${item.workspace.folderToken.padEnd(27)} ${item.updated}`)
  }
  return `${lines.join('\n')}\n`
}

async function orphansCommand(): Promise<string> {
  const root = await readJson<WorkspaceRoot | null>(workspaceRootPath(), null)
  if (!root?.folderToken) {
    return `${t('feishuWs.orphans.notInitialized')}\n`
  }
  const known = new Set((await listWorkspaceFiles()).map(item => item.workspace.folderToken))
  const listed = await listFolder({ client: getFeishuClient(), folderToken: root.folderToken })
  const orphans = listed.items.filter(item => item.type === 'folder' && !known.has(item.token))
  if (orphans.length === 0) {
    return `${t('feishuWs.orphans.empty')}\n`
  }
  return `${[t('feishuWs.orphans.header'), ...orphans.map(item => `${item.token.padEnd(29)} ${item.name}`)].join('\n')}\n`
}

async function deleteCommand(args: string[]): Promise<string> {
  const canonical = args[0]
  if (!canonical) {
    return `${t('feishuWs.delete.usage')}\n`
  }
  const workspace = await readJson<UserWorkspace | null>(userWorkspacePath(canonical), null)
  if (!workspace?.folderToken) {
    return `${t('feishuWs.delete.noFolder', { canonical })}\n`
  }
  // B4: `/admin feishu-drive rm <canonical> --y` skips the token round-trip
  // (the `--y` gate is the confirmation; B5 polishes the printed preview).
  // The legacy `--confirm <token>` path is preserved below unchanged so the
  // old `/feishu-workspace delete` flow and its `admin-delete-workspace`
  // audit row keep working.
  if (args.includes('--y')) {
    const itemCount = await listFolder({ client: getFeishuClient(), folderToken: workspace.folderToken })
      .then(result => result.items.length)
      .catch(() => 0)
    return performWorkspaceDelete(canonical, workspace.folderToken, itemCount)
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
    return `${t('feishuWs.delete.preview', {
      canonical,
      token: workspace.folderToken,
      count: itemCount,
      confirmToken: token,
    })}\n`
  }
  const token = args[confirmIdx + 1]
  const pending = pendingDeleteTokens.get(canonical)
  if (!pending || pending.token !== token || pending.expiresAt < Date.now()) {
    pendingDeleteTokens.delete(canonical)
    return `${t('feishuWs.delete.tokenInvalid', { canonical })}\n`
  }
  pendingDeleteTokens.delete(canonical)
  return performWorkspaceDelete(canonical, workspace.folderToken, pending.itemCount)
}

/** Execute the actual folder delete + identity-binding removal + audit row.
 *  Shared by the legacy `--confirm <token>` path and the B4 `--y` path so the
 *  `admin-delete-workspace` audit row is written identically by both. */
async function performWorkspaceDelete(
  canonical: string,
  folderToken: string,
  itemCount: number,
): Promise<string> {
  const auditResource = { folderToken, itemCount }
  try {
    await deleteFile({ client: getFeishuClient(), token: folderToken, type: 'folder' })
  } catch (error) {
    // Feishu rejected the delete (folder gone / permission revoked / scope drift).
    // Keep the identity binding so admin can investigate before we abandon it,
    // and surface the failure in audit jsonl so a later /feishu-workspace orphans
    // sweep can correlate.
    await recordFeishuWriteAudit({
      at: new Date().toISOString(),
      userId: canonical,
      operation: 'admin-delete-workspace',
      resource: auditResource,
      status: 'failed',
      error: feishuErrorMessage(error),
    })
    return `${t('feishuWs.delete.failed', { canonical, detail: feishuErrorMessage(error) })}\n`
  }
  await rm(userWorkspacePath(canonical), { force: true })
  await recordFeishuWriteAudit({
    at: new Date().toISOString(),
    userId: canonical,
    operation: 'admin-delete-workspace',
    resource: auditResource,
    status: 'confirmed',
  })
  return `${t('feishuWs.delete.done', { canonical, count: itemCount })}\n`
}

async function listWorkspaceFiles(): Promise<Array<{ canonical: string; workspace: UserWorkspace; updated: string }>> {
  const root = usersRoot()
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out: Array<{ canonical: string; workspace: UserWorkspace; updated: string }> = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const filePath = userFeishuWorkspacePath(entry.name)
    const workspace = await readJson<UserWorkspace | null>(filePath, null)
    if (!workspace?.folderToken) continue
    const updated = await stat(filePath).then(s => s.mtime.toISOString()).catch(() => workspace.createdAt)
    out.push({ canonical: entry.name, workspace, updated })
  }
  return out.sort((a, b) => sanitizePathSegment(a.canonical).localeCompare(sanitizePathSegment(b.canonical)))
}
