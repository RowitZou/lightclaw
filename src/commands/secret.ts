import { appendSecretOpAudit, type SecretOp } from '../audit/secret-ops.js'
import { t } from '../i18n/index.js'
import {
  listUserSecretMetadata,
  loadUserSecrets,
  removeUserSecret,
  setEnabled,
  setUserSecret,
  validateSecretName,
} from '../secrets/store.js'

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

  if (['help', '--help', '-h'].includes(action)) return `${t('secret.usage')}\n`
  if (!ctx.userId) {
    return `${t('secret.noIdentity')}\n`
  }
  const userId = ctx.userId

  try {
    switch (action) {
      case 'list': {
        if (parts.length > 1) return `${t('secret.usage')}\n`
        return formatList(userId)
      }
      case 'status': {
        if (parts.length > 2) return `${t('secret.usage')}\n`
        if (parts[1]) return formatStatus(userId, parts[1])
        return formatList(userId)
      }
      case 'set': {
        const match = trimmed.match(/^set\s+(\S+)\s+([\s\S]+)$/i)
        if (!match) return `${t('secret.usage')}\n`
        const name = validateSecretName(match[1])
        const result = setUserSecret(userId, name, match[2])
        await auditSecretOp(userId, result.replaced ? 'set-replace' : 'set', name)
        return `${t('secret.saved', {
          name: result.name,
          replaced: result.replaced ? 'yes' : 'no',
          length: result.metadata.length,
        })}\n`
      }
      case 'enable': {
        if (parts.length !== 2) return `${t('secret.usage')}\n`
        const name = validateSecretName(parts[1])
        const result = setEnabled(userId, name, true)
        if (!result.stored) {
          return `${t('secret.enableNotStored', { name: result.name })}\n`
        }
        await auditSecretOp(userId, 'enable', name)
        return `${t('secret.enabled', { name: result.name })}\n`
      }
      case 'disable': {
        if (parts.length !== 2) return `${t('secret.usage')}\n`
        const name = validateSecretName(parts[1])
        const result = setEnabled(userId, name, false)
        if (!result.stored) return `${t('secret.notStored', { name: result.name })}\n`
        await auditSecretOp(userId, 'disable', name)
        return `${t('secret.disabled', { name: result.name })}\n`
      }
      case 'remove':
      case 'rm': {
        if (parts.length !== 2) return `${t('secret.usage')}\n`
        const name = validateSecretName(parts[1])
        const result = removeUserSecret(userId, name)
        if (!result.removed) return `${t('secret.notStored', { name: result.name })}\n`
        await auditSecretOp(userId, 'remove', name)
        return `${t('secret.removed', { name: result.name })}\n`
      }
      default:
        return `${t('secret.usage')}\n`
    }
  } catch (error) {
    return `${t('common.error.prefix')}${error instanceof Error ? error.message : String(error)}\n`
  }
}

async function auditSecretOp(
  user: string,
  op: SecretOp,
  name: string,
): Promise<void> {
  await appendSecretOpAudit({
    ts: new Date().toISOString(),
    user,
    op,
    name,
    source: 'chat',
  })
}

function formatList(userId: string): string {
  const items = listUserSecretMetadata(userId)
  if (items.length === 0) return `${t('secret.list.empty')}\n`
  return [
    t('secret.list.header'),
    ...items.map(item =>
      t('secret.list.row', {
        name: item.name,
        enabled: item.enabled ? t('secret.state.on') : t('secret.state.off'),
        length: item.length,
        updated: item.updatedAt || '-',
      }),
    ),
    '',
  ].join('\n')
}

function formatStatus(userId: string, rawName: string): string {
  const name = validateSecretName(rawName)
  const entry = loadUserSecrets(userId)[name]
  if (!entry) return `${t('secret.status.absent', { name })}\n`
  return `${t('secret.status.present', {
    name,
    enabled: entry.enabled ? t('secret.state.on') : t('secret.state.off'),
    length: entry.value.length,
    updated: entry.updatedAt || '-',
  })}\n`
}
