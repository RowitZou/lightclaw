import { readFileSync } from 'node:fs'
import path from 'node:path'

import { appendSecretOpAudit, type SecretOp } from '../audit/secret-ops.js'
import {
  listUserSecretMetadata,
  loadUserSecrets,
  removeUserSecret,
  setEnabled,
  setUserSecret,
  validateSecretName,
} from '../secrets/store.js'

const USAGE = [
  'Usage:',
  '  /secret list',
  '  /secret status [NAME]',
  '  /secret set <NAME> <VALUE...>',
  '  /secret import-env <NAME>',
  '  /secret import-file <NAME> <ABS-PATH>',
  '  /secret enable <NAME>',
  '  /secret disable <NAME>',
  '  /secret remove <NAME>',
  '',
  'Secrets are per-user. Values are never echoed. Once a secret is enabled, it is injected as `$NAME` in Bash commands.',
].join('\n')

type SecretCommandContext = {
  userId?: string
}

export async function runSecretCommand(
  rawArgs: string,
  ctx: SecretCommandContext,
): Promise<string> {
  const trimmed = rawArgs.trim()
  const parts = trimmed.split(/\s+/).filter(Boolean)
  const action = (parts[0] ?? 'list').toLowerCase()

  if (['help', '--help', '-h'].includes(action)) return `${USAGE}\n`
  if (!ctx.userId) {
    return 'No active LightClaw identity; /secret requires a paired channel user.\n'
  }
  const userId = ctx.userId

  try {
    switch (action) {
      case 'list': {
        if (parts.length > 1) return `${USAGE}\n`
        return formatList(userId)
      }
      case 'status': {
        if (parts.length > 2) return `${USAGE}\n`
        if (parts[1]) return formatStatus(userId, parts[1])
        return formatList(userId)
      }
      case 'set': {
        const match = trimmed.match(/^set\s+(\S+)\s+([\s\S]+)$/i)
        if (!match) return `${USAGE}\n`
        const name = validateSecretName(match[1])
        const result = setUserSecret(userId, name, match[2])
        await auditSecretOp(userId, result.replaced ? 'set-replace' : 'set', name, 'chat')
        return `Secret ${result.name} saved (replaced=${result.replaced ? 'yes' : 'no'}, length=${result.metadata.length}). Use /secret enable ${result.name} to start injecting it.\n`
      }
      case 'import-env': {
        if (parts.length !== 2) return `${USAGE}\n`
        const name = validateSecretName(parts[1])
        const value = process.env[name]
        if (!value) return `error> $${name} not set in daemon environment\n`
        const result = setUserSecret(userId, name, value)
        await auditSecretOp(userId, 'import-env', name, 'env')
        return `Secret ${result.name} imported from daemon env (length=${result.metadata.length}). Use /secret enable ${result.name} to start injecting it.\n`
      }
      case 'import-file': {
        if (parts.length !== 3) return `${USAGE}\n`
        const name = validateSecretName(parts[1])
        const filePath = parts[2]
        if (!path.isAbsolute(filePath)) {
          return 'error> import-file path must be absolute\n'
        }
        const value = readFirstSecretLine(filePath)
        if (!value) return 'error> import-file first line is empty\n'
        const result = setUserSecret(userId, name, value)
        await auditSecretOp(userId, 'import-file', name, 'file')
        return `Secret ${result.name} imported from file (length=${result.metadata.length}). Use /secret enable ${result.name} to start injecting it.\n`
      }
      case 'enable': {
        if (parts.length !== 2) return `${USAGE}\n`
        const name = validateSecretName(parts[1])
        const result = setEnabled(userId, name, true)
        if (!result.stored) {
          return `Secret ${result.name} is not stored. Use /secret set ${result.name} <VALUE> first.\n`
        }
        await auditSecretOp(userId, 'enable', name, 'chat')
        return `Secret ${result.name} enabled. It will be injected as $${result.name} in Bash commands starting from your next message.\n`
      }
      case 'disable': {
        if (parts.length !== 2) return `${USAGE}\n`
        const name = validateSecretName(parts[1])
        const result = setEnabled(userId, name, false)
        if (!result.stored) return `Secret ${result.name} was not stored.\n`
        await auditSecretOp(userId, 'disable', name, 'chat')
        return `Secret ${result.name} disabled. Stored value retained — /secret enable ${result.name} to re-activate.\n`
      }
      case 'remove':
      case 'rm': {
        if (parts.length !== 2) return `${USAGE}\n`
        const name = validateSecretName(parts[1])
        const result = removeUserSecret(userId, name)
        if (!result.removed) return `Secret ${result.name} was not stored.\n`
        await auditSecretOp(userId, 'remove', name, 'chat')
        return `Secret ${result.name} removed.\n`
      }
      default:
        return `${USAGE}\n`
    }
  } catch (error) {
    return `error> ${error instanceof Error ? error.message : String(error)}\n`
  }
}

function readFirstSecretLine(filePath: string): string {
  const content = readFileSync(filePath, 'utf8')
  return (content.split(/\r?\n/, 1)[0] ?? '').trim()
}

async function auditSecretOp(
  user: string,
  op: SecretOp,
  name: string,
  source: 'chat' | 'env' | 'file',
): Promise<void> {
  await appendSecretOpAudit({
    ts: new Date().toISOString(),
    user,
    op,
    name,
    source,
  })
}

function formatList(userId: string): string {
  const items = listUserSecretMetadata(userId)
  if (items.length === 0) return 'No secrets stored for this user.\n'
  return [
    'Secrets:',
    ...items.map(item =>
      `- ${item.name} enabled=${item.enabled ? 'yes' : 'no'} length=${item.length} updated=${item.updatedAt || '-'}`,
    ),
    '',
  ].join('\n')
}

function formatStatus(userId: string, rawName: string): string {
  const name = validateSecretName(rawName)
  const entry = loadUserSecrets(userId)[name]
  if (!entry) return `${name} stored=no\n`
  return `${name} stored=yes enabled=${entry.enabled ? 'yes' : 'no'} length=${entry.value.length} updated=${entry.updatedAt || '-'}\n`
}
