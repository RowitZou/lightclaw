import { appendSecretOpAudit, type SecretOp } from '../audit/secret-ops.js'
import { findSecretReferences } from '../config/user-override.js'
import { t } from '../i18n/index.js'
import {
  listUserSecretMetadata,
  loadUserSecrets,
  removeUserSecret,
  setEnabled,
  setUserSecret,
  validateSecretName,
} from '../secrets/store.js'
import { requireConfirm } from './confirm.js'
import { canonicalizeFlagTokens } from './flag-normalize.js'

type SecretCommandContext = {
  userId?: string
}

export async function runSecretCommand(
  rawArgs: string,
  ctx: SecretCommandContext,
): Promise<string | null> {
  const trimmed = rawArgs.trim()
  const parts = trimmed.split(/\s+/).filter(Boolean)
  const action = (parts[0] ?? 'list').toLowerCase()

  if (['help', '--help', '-h'].includes(action)) return null
  if (!ctx.userId) {
    return `${t('secret.noIdentity')}\n`
  }
  const userId = ctx.userId

  try {
    switch (action) {
      case 'list': {
        if (parts.length > 1) return null
        return formatList(userId)
      }
      case 'status': {
        if (parts.length > 2) return null
        if (parts[1]) return formatStatus(userId, parts[1])
        return formatList(userId)
      }
      case 'set': {
        const match = trimmed.match(/^set\s+(\S+)\s+([\s\S]+)$/i)
        if (!match) return null
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
        if (parts.length !== 2) return null
        const name = validateSecretName(parts[1])
        const result = setEnabled(userId, name, true)
        if (!result.stored) {
          return `${t('secret.enableNotStored', { name: result.name })}\n`
        }
        await auditSecretOp(userId, 'enable', name)
        return `${t('secret.enabled', { name: result.name })}\n`
      }
      case 'disable': {
        if (parts.length !== 2) return null
        const name = validateSecretName(parts[1])
        const result = setEnabled(userId, name, false)
        if (!result.stored) return `${t('secret.notStored', { name: result.name })}\n`
        await auditSecretOp(userId, 'disable', name)
        return `${t('secret.disabled', { name: result.name })}\n`
      }
      case 'remove':
      case 'rm': {
        // Dash-canonicalized VIEW for the `--y` gate only; the name itself is
        // read from the positional token so a canonicalization never rewrites it.
        const flagged = canonicalizeFlagTokens(parts)
        const positional = flagged.filter(part => !part.startsWith('--'))
        if (positional.length !== 2) return null
        const name = validateSecretName(positional[1])
        // A secret that backs a BYO endpoint is load-bearing: removing it
        // disables that endpoint AND every model on it (2026-08-13 prod:
        // `/secret rm BYO_KEY_1` took four models offline with no warning).
        // The gate lives HERE, at the store-mutating chokepoint, so every
        // caller inherits it — `/system key rm` used to carry its own copy and
        // the plain `/secret rm` path had none.
        const refs = findSecretReferences(userId, name)
        if (refs.endpoints.length > 0) {
          const gate = requireConfirm(parts, {
            preview:
              refs.models.length > 0
                ? t('confirm.key.rmModels', {
                    name,
                    endpoints: refs.endpoints.join(', '),
                    models: refs.models.join(', '),
                  })
                : t('confirm.key.rm', { name, endpoints: refs.endpoints.join(', ') }),
          })
          if (!gate.confirmed) return gate.message
        }
        const result = removeUserSecret(userId, name)
        if (!result.removed) return `${t('secret.notStored', { name: result.name })}\n`
        await auditSecretOp(userId, 'remove', name)
        const disabled =
          refs.endpoints.length > 0
            ? `\n${t('secret.removedDisabled', {
                endpoints: refs.endpoints.join(', '),
                models: refs.models.length > 0 ? refs.models.join(', ') : '-',
              })}`
            : ''
        return `${t('secret.removed', { name: result.name })}${disabled}\n`
      }
      default:
        return null
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
