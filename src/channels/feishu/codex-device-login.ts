// Feishu wiring for the Codex device-login flow: builds the four lifecycle
// cards (init / success / expired / failed), resolves the user's DM open_id,
// and drives the channel-agnostic poller (`auth/codex/device-login-poller.ts`).
//
// The card / DM / open_id concerns live here so the auth layer stays Feishu-free
// (it only sees injected callbacks). Slash handlers (`/config endpoint add`,
// `/admin endpoint add`) call `beginCodexDeviceLogin` with a `persist` callback
// (per-user vs admin-global store) and an `onPersisted` hook that writes the
// endpoint config once the login actually completes.

import { t } from '../../i18n/index.js'
import { getIdentity } from '../../identity/store.js'
import type { ExchangedTokens } from '../../auth/codex/device-login.js'
import { startDeviceLogin } from '../../auth/codex/device-login-poller.js'
import { card2, markdown } from './card2.js'
import { buildSystemNoticeCard } from './system-notice.js'
import { getFeishuSender } from './sender-registry.js'

/** Init card (link + one-time code) pushed to the user's DM. The verify link is
 *  rendered as a clickable lark_md link rather than a callback button — a plain
 *  markdown link has no card-action schema risk and the user only needs to open
 *  a URL. The code sits in its own fenced block so it is easy to copy. */
export function buildDeviceLoginInitCard(info: { userCode: string; verifyUrl: string }): Record<string, unknown> {
  return card2({
    template: 'blue',
    title: t('card.codex.login.initTitle'),
    config: { enable_forward: false, wide_screen_mode: true },
    elements: [
      markdown(t('card.codex.login.initIntro')),
      markdown(`${t('card.codex.login.initStep1')}\n[${t('card.codex.login.openBtn')}](${info.verifyUrl})`),
      markdown(`${t('card.codex.login.initStep2')}\n\`\`\`\n${info.userCode}\n\`\`\``),
      markdown(t('card.codex.login.initWarn')),
    ],
  })
}

export function buildDeviceLoginSuccessCard(info: { alias: string; account: string }): Record<string, unknown> {
  return buildSystemNoticeCard({
    kind: 'info',
    title: t('card.codex.login.successTitle'),
    content: t('card.codex.login.successBody', { alias: info.alias, account: info.account || '—' }),
  })
}

export function buildDeviceLoginExpiredCard(info: { alias: string }): Record<string, unknown> {
  return buildSystemNoticeCard({
    kind: 'warning',
    title: t('card.codex.login.expiredTitle'),
    content: t('card.codex.login.expiredBody', { alias: info.alias }),
  })
}

export function buildDeviceLoginFailedCard(info: { alias: string; reason: string }): Record<string, unknown> {
  return buildSystemNoticeCard({
    kind: 'warning',
    title: t('card.codex.login.failedTitle'),
    content: t('card.codex.login.failedBody', { alias: info.alias, reason: info.reason }),
  })
}

/**
 * Begin a Codex web (device) login for `canonicalUser`, delivering the init /
 * terminal cards to that user's Feishu DM. Returns `{ ok:false, message }` when
 * the login cannot even be started (no Feishu binding — e.g. the terminal admin
 * console — or the usercode request failed), so the slash handler can echo an
 * inline error instead of the "started" notice. On `ok`, the detached poller
 * owns the rest of the lifecycle.
 *
 * `persist` writes the exchanged tokens into the appropriate store (per-user or
 * admin-global) and returns the account id. `onPersisted` (best-effort) writes
 * the endpoint config entry once the credential exists — matching the import
 * path's "persist only after it works" ordering.
 */
export async function beginCodexDeviceLogin(args: {
  canonicalUser: string
  alias: string
  proxy?: string
  issuer?: string
  persist: (tokens: ExchangedTokens) => { accountId: string } | Promise<{ accountId: string }>
  onPersisted?: () => void | Promise<void>
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const sender = getFeishuSender()
  const identity = await getIdentity(args.canonicalUser).catch(() => null)
  const openId = identity?.channels.feishu[0]
  if (!sender || !openId) {
    return { ok: false, message: t('config.codex.login.needsChannel') }
  }

  const pushCard = async (card: Record<string, unknown>): Promise<void> => {
    await sender.sendInteractiveCardToOpenId(openId, card, {
      purpose: 'notice',
      canonicalUser: args.canonicalUser,
    })
  }

  const started = await startDeviceLogin({
    canonicalUser: args.canonicalUser,
    ...(args.proxy ? { proxy: args.proxy } : {}),
    ...(args.issuer ? { issuer: args.issuer } : {}),
    persist: args.persist,
    handlers: {
      onStarted: info =>
        pushCard(buildDeviceLoginInitCard({ userCode: info.userCode, verifyUrl: info.verifyUrl })),
      onSuccess: async info => {
        try {
          await args.onPersisted?.()
        } catch (error) {
          await pushCard(
            buildDeviceLoginFailedCard({
              alias: args.alias,
              reason: error instanceof Error ? error.message : String(error),
            }),
          )
          return
        }
        await pushCard(buildDeviceLoginSuccessCard({ alias: args.alias, account: info.accountId }))
      },
      onExpired: () => pushCard(buildDeviceLoginExpiredCard({ alias: args.alias })),
      onFailed: reason => pushCard(buildDeviceLoginFailedCard({ alias: args.alias, reason })),
    },
  })

  if (!started.ok) {
    return { ok: false, message: t('config.endpoint.addFailedProbe', { detail: started.detail }) }
  }
  return { ok: true }
}
