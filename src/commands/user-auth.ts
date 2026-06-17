import { AuthError } from '../auth/index.js'
import {
  deleteUserCodexAuth,
  importUserCodexAuth,
  listUserCodexAuth,
  normalizeCodexAuthName,
  readUserCodexAuth,
  refreshUserCodexAuth,
} from '../auth/codex/user-store.js'

export async function runUserAuthCommand(args: string, userId: string | undefined): Promise<string> {
  if (!userId) {
    return 'No active LightClaw identity; /auth codex requires a paired user.\n'
  }
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const family = (parts.shift() ?? '').toLowerCase()
  if (family !== 'codex') {
    return userAuthUsage()
  }
  const action = (parts.shift() ?? 'list').toLowerCase()
  try {
    switch (action) {
      case 'list':
        return formatCodexList(userId)
      case 'status':
        return formatCodexStatus(userId, parts[0])
      case 'import':
        return runCodexImport(userId, parts)
      case 'refresh':
        return await runCodexRefresh(userId, parts)
      case 'logout':
        return runCodexLogout(userId, parts)
      default:
        return userAuthUsage()
    }
  } catch (error) {
    if (error instanceof AuthError) {
      return `Error: ${error.message}\n`
    }
    return `Error: ${error instanceof Error ? error.message : String(error)}\n`
  }
}

function userAuthUsage(): string {
  return [
    'Usage:',
    '  /auth codex list',
    '  /auth codex status [name]',
    '  /auth codex import --from <daemon-readable-auth.json> [--name default]',
    '  /auth codex refresh [name]',
    '  /auth codex logout [name]',
    '',
  ].join('\n')
}

function runCodexImport(userId: string, parts: string[]): string {
  const from = flagValue(parts, '--from')
  if (!from) {
    return 'Usage: /auth codex import --from <daemon-readable-auth.json> [--name default]\n'
  }
  const name = flagValue(parts, '--name') ?? 'default'
  const summary = importUserCodexAuth({ canonicalUser: userId, name, fromPath: from })
  return [
    `Imported Codex auth "${summary.name}" for ${userId}.`,
    `account=${maskAccountId(summary.accountId || '?')} expires=${formatRelative(summary.expiresAt - Date.now())}`,
    `Use authRef=codex:${summary.name} with /endpoint add-codex, then add a model with /model custom add.`,
    '',
  ].join('\n')
}

async function runCodexRefresh(userId: string, parts: string[]): Promise<string> {
  const name = normalizeCodexAuthName(parts[0] ?? 'default')
  const summary = await refreshUserCodexAuth({ canonicalUser: userId, name })
  return `Refreshed Codex auth "${summary.name}" for ${userId}; expires=${formatRelative(summary.expiresAt - Date.now())}.\n`
}

function runCodexLogout(userId: string, parts: string[]): string {
  const name = normalizeCodexAuthName(parts[0] ?? 'default')
  const removed = deleteUserCodexAuth(userId, name)
  return removed
    ? `Removed Codex auth "${name}" for ${userId}.\n`
    : `No Codex auth "${name}" stored for ${userId}.\n`
}

function formatCodexList(userId: string): string {
  const items = listUserCodexAuth(userId)
  if (items.length === 0) {
    return 'No per-user Codex auth stored.\n'
  }
  return `${[
    'Codex auth:',
    ...items.map(item =>
      `  ${item.name} account=${maskAccountId(item.accountId || '?')} expires=${formatRelative(item.expiresAt - Date.now())}`,
    ),
    '',
  ].join('\n')}`
}

function formatCodexStatus(userId: string, rawName: string | undefined): string {
  const name = normalizeCodexAuthName(rawName ?? 'default')
  const stored = readUserCodexAuth(userId, name)
  if (!stored) {
    return `Codex auth "${name}" stored=no\n`
  }
  return [
    `Codex auth "${name}" stored=yes`,
    `account=${maskAccountId(stored.account_id || '?')}`,
    `expires=${formatRelative(stored.tokens.expires_at - Date.now())}`,
    `source=${stored.source}`,
    ...(stored.imported_at ? [`importedAt=${stored.imported_at}`] : []),
    ...(stored.last_refresh ? [`lastRefresh=${stored.last_refresh}`] : []),
    '',
  ].join('\n')
}

function flagValue(parts: string[], flag: string): string | undefined {
  const index = parts.indexOf(flag)
  if (index < 0) return undefined
  return parts[index + 1]
}

function maskAccountId(id: string): string {
  if (id.length <= 8) return id
  return `${id.slice(0, 4)}...${id.slice(-4)}`
}

function formatRelative(deltaMs: number): string {
  if (deltaMs <= 0) return 'expired'
  const minutes = Math.round(deltaMs / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}
