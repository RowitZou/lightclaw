import { AuthError, getAuthProvider, listAuthProviderNames, readTokenFile } from '../auth/index.js'
import {
  autoRegisterCodex,
  purgeCodexFromConfig,
} from '../auth/codex/auto-register.js'
import { discoverDefaultCodexSlug } from '../auth/codex/models.js'
import { clearCredentialDegrade } from '../auth/codex/degrade-state.js'
import { getConfig, type LightClawConfig } from '../config.js'
import { t } from '../i18n/index.js'

// `/auth` admin-only slash command.
//
//   /auth list             — what's logged in (provider + expiry + masked id)
//   /auth import codex     — read ~/.codex/auth.json into <home>/auth/codex.json
//                            and auto-register endpoints.codex + models.gpt-5-codex
//   /auth logout codex     — drop the token file (config.json untouched)
//   /auth logout codex --purge
//                          — drop token + remove endpoint/model entries
//
// V1 only knows the `codex` provider name. Other args are rejected with a
// clear list of supported providers.

const SUPPORTED_PROVIDERS = ['codex'] as const
type SupportedProvider = typeof SUPPORTED_PROVIDERS[number]

export async function runAuthCommand(
  args: string,
  liveConfig?: LightClawConfig,
): Promise<string> {
  const trimmed = args.trim()
  const [head, ...rest] = trimmed.split(/\s+/).filter(Boolean)
  const sub = (head ?? 'list').toLowerCase()

  if (sub === 'list') {
    return runAuthList()
  }
  if (sub === 'import') {
    return runAuthImport(rest, liveConfig)
  }
  if (sub === 'logout') {
    return runAuthLogout(rest, liveConfig)
  }
  return `${t('common.error.prefix')}${t('auth.usage')}\n`
}

/**
 * Sync the live in-memory LightClawConfig with whatever auto-register just
 * wrote to disk. The /auth slash handler captures ctx.config at REPL boot,
 * but auto-register mutates the file — without this refresh, /model would
 * still see the pre-import model list.
 *
 * We mutate `endpoints` and `models` in place to preserve object identity
 * (other modules cache references to ctx.config). defaultModel is
 * intentionally left alone — admin owns it.
 */
function refreshConfigAfterDiskWrite(liveConfig: LightClawConfig | undefined): void {
  if (!liveConfig) return
  try {
    const fresh = getConfig()
    for (const k of Object.keys(liveConfig.endpoints)) {
      delete liveConfig.endpoints[k]
    }
    Object.assign(liveConfig.endpoints, fresh.endpoints)
    for (const k of Object.keys(liveConfig.models)) {
      delete liveConfig.models[k]
    }
    Object.assign(liveConfig.models, fresh.models)
  } catch {
    // getConfig() throws when the on-disk config is invalid; surface
    // the next /model call instead of breaking the import flow.
  }
}

function runAuthList(): string {
  const names = listAuthProviderNames()
  if (names.length === 0) {
    return `${t('auth.list.noProviders')}\n`
  }
  const lines: string[] = [t('auth.list.title')]
  for (const name of names) {
    lines.push(formatProviderListLine(name))
  }
  return `${lines.join('\n')}\n`
}

function formatProviderListLine(name: string): string {
  // Read the on-disk record directly — getCredentials() would refresh,
  // and we don't want a network call from a `list` operation.
  const stored = readTokenFile(name) as
    | {
        tokens?: { expires_at?: number }
        account_id?: string
        last_refresh?: string
      }
    | null
  if (!stored?.tokens) {
    return t('auth.list.entryEmpty', { name })
  }
  const expiresAt = stored.tokens.expires_at
  const expiresIn = typeof expiresAt === 'number'
    ? formatRelativeTime(expiresAt - Date.now())
    : '?'
  const accountId = typeof stored.account_id === 'string' ? stored.account_id : ''
  const masked = accountId ? maskAccountId(accountId) : '?'
  return t('auth.list.entry', {
    name,
    expiresIn,
    accountId: masked,
  })
}

function maskAccountId(id: string): string {
  if (id.length <= 8) return id
  return `${id.slice(0, 4)}…${id.slice(-4)}`
}

function formatRelativeTime(deltaMs: number): string {
  if (deltaMs <= 0) return t('auth.list.expired')
  const minutes = Math.round(deltaMs / 60_000)
  if (minutes < 60) return t('auth.list.inMinutes', { n: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 48) return t('auth.list.inHours', { n: hours })
  const days = Math.round(hours / 24)
  return t('auth.list.inDays', { n: days })
}

async function runAuthImport(
  rest: string[],
  liveConfig: LightClawConfig | undefined,
): Promise<string> {
  const providerName = rest[0]
  if (!providerName) {
    return `${t('common.error.prefix')}${t('auth.import.usage')}\n`
  }
  if (!isSupportedProvider(providerName)) {
    return `${t('common.error.prefix')}${t('auth.unsupportedProvider', {
      name: providerName,
      list: SUPPORTED_PROVIDERS.join(', '),
    })}\n`
  }
  const provider = getAuthProviderSafe(providerName)
  if (!provider.import) {
    return `${t('common.error.prefix')}${t('auth.import.notSupported', {
      name: providerName,
    })}\n`
  }
  try {
    await provider.import()
  } catch (err) {
    return formatAuthError(err, 'import')
  }

  // codex is the only provider with an auto-register flow today; future
  // providers (copilot etc.) plug their own auto-register here.
  const lines: string[] = [t('auth.import.success', { name: providerName })]
  if (providerName === 'codex') {
    // Live model discovery: ask the Codex backend which slug is currently
    // the priority-0 default and use that for the auto-registered entry.
    // Failures fall back silently to the hardcoded default — discovery is
    // opportunistic, the user's Codex login already worked at this point.
    let upstreamModel: string | undefined
    try {
      const credentials = await provider.getCredentials()
      // First-time imports run before auto-register has written
      // endpoints.codex, so this proxy lookup is usually empty. Re-runs
      // (after the user has manually set endpoints.codex.proxy) pick it
      // up. Failures here just fall through to the static default.
      const codexEp = liveConfig?.endpoints['codex']
      const proxy = codexEp && 'proxy' in codexEp ? codexEp.proxy : undefined
      const discovered = await discoverDefaultCodexSlug(
        credentials,
        proxy ? { proxy } : {},
      )
      if (discovered) upstreamModel = discovered
    } catch {
      // ignore — fall through to autoRegisterCodex's static default
    }
    const reg = autoRegisterCodex(
      upstreamModel ? { upstreamModel } : {},
    )
    if (reg.endpointAdded || reg.modelsAdded.length > 0) {
      const tierList = reg.modelsAdded.length > 0
        ? reg.modelsAdded.join(', ')
        : 'none'
      lines.push(
        upstreamModel
          ? t('auth.codex.registeredWithDiscovery', {
              slug: upstreamModel,
              tiers: tierList,
            })
          : t('auth.codex.registered', { tiers: tierList }),
      )
    } else {
      lines.push(t('auth.codex.alreadyRegistered'))
    }
    // Refresh the running process's in-memory config so /model gpt-5-codex
    // works without a daemon restart. ctx.config is captured at REPL boot
    // and channels keep references to the same object.
    refreshConfigAfterDiskWrite(liveConfig)
    // Credentials just landed — lift any startup degrade so the previously
    // disabled Codex models are selectable again without a restart.
    clearCredentialDegrade()
  }
  lines.push('')
  lines.push(t('auth.codex.banRiskWarning'))
  lines.push('')
  return lines.join('\n')
}

async function runAuthLogout(
  rest: string[],
  liveConfig: LightClawConfig | undefined,
): Promise<string> {
  const providerName = rest[0]
  const purge = rest.includes('--purge')
  if (!providerName) {
    return `${t('common.error.prefix')}${t('auth.logout.usage')}\n`
  }
  if (!isSupportedProvider(providerName)) {
    return `${t('common.error.prefix')}${t('auth.unsupportedProvider', {
      name: providerName,
      list: SUPPORTED_PROVIDERS.join(', '),
    })}\n`
  }
  const provider = getAuthProviderSafe(providerName)
  await provider.logout()
  const lines: string[] = [t('auth.logout.success', { name: providerName })]
  if (purge && providerName === 'codex') {
    const purged = purgeCodexFromConfig()
    if (purged.endpointRemoved || purged.modelsRemoved.length > 0) {
      lines.push(
        t('auth.logout.purged', {
          endpoint: purged.endpointRemoved ? 'codex' : '-',
          models: purged.modelsRemoved.join(', ') || '-',
        }),
      )
    } else {
      lines.push(t('auth.logout.purgeNothing'))
    }
    refreshConfigAfterDiskWrite(liveConfig)
  }
  return `${lines.join('\n')}\n`
}

function isSupportedProvider(name: string): name is SupportedProvider {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(name)
}

function getAuthProviderSafe(name: string) {
  try {
    return getAuthProvider(name)
  } catch (err) {
    if (err instanceof AuthError && err.code === 'unknown_provider') {
      // Convert to a thrown-with-text fallback so the caller can format
      // it nicely. Should never happen for known SUPPORTED_PROVIDERS
      // since init.ts registers them at startup.
      throw err
    }
    throw err
  }
}

function formatAuthError(err: unknown, op: 'import' | 'logout'): string {
  if (err instanceof AuthError) {
    return `${t('common.error.prefix')}${err.message}\n`
  }
  if (err instanceof Error) {
    return `${t('common.error.prefix')}${op}: ${err.message}\n`
  }
  return `${t('common.error.prefix')}${op}: unknown failure.\n`
}
