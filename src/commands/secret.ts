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
        return `Secret ${result.name} saved (replaced=${result.replaced ? 'yes' : 'no'}, length=${result.metadata.length}). Use /secret enable ${result.name} to start injecting it.\n`
      }
      case 'enable': {
        if (parts.length !== 2) return `${USAGE}\n`
        const name = validateSecretName(parts[1])
        const result = setEnabled(userId, name, true)
        if (!result.stored) {
          return `Secret ${result.name} is not stored. Use /secret set ${result.name} <VALUE> first.\n`
        }
        return `Secret ${result.name} enabled. It will be injected as $${result.name} in Bash commands starting from your next message.\n`
      }
      case 'disable': {
        if (parts.length !== 2) return `${USAGE}\n`
        const name = validateSecretName(parts[1])
        const result = setEnabled(userId, name, false)
        return result.stored
          ? `Secret ${result.name} disabled. Stored value retained — /secret enable ${result.name} to re-activate.\n`
          : `Secret ${result.name} was not stored.\n`
      }
      case 'remove':
      case 'rm': {
        if (parts.length !== 2) return `${USAGE}\n`
        const name = validateSecretName(parts[1])
        const result = removeUserSecret(userId, name)
        return result.removed
          ? `Secret ${result.name} removed.\n`
          : `Secret ${result.name} was not stored.\n`
      }
      default:
        return `${USAGE}\n`
    }
  } catch (error) {
    return `error> ${error instanceof Error ? error.message : String(error)}\n`
  }
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
