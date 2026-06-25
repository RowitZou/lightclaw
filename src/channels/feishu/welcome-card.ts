// Welcome / startup-failure cards pushed to a freshly approved user. Distinct
// from the existing pairing welcome (sent BEFORE approval, asking the user to
// hand a code to admin) — this one is sent AFTER /admin pairing approve, once the
// per-user sandbox runtime (docker container or rlaunch worker) is ready to
// serve tool calls. The user has been silent up to this point; this is the
// first proactive push from the bot.

import { t } from '../../i18n/index.js'
import { classifyStartupReason } from './startup-reason.js'
import { buildSystemNoticeCard } from './system-notice.js'

export function buildApprovalWelcomeCard(opts: { isAdmin?: boolean } = {}): Record<string, unknown> {
  // Header is wathet (info) so it visually reads as a friendly notice rather
  // than a warning. Commands collapse to a single `/help` hint ("or just ask
  // me"), since a brand-new user gets no value from memorizing slash syntax up
  // front. Two variants by recipient role:
  //   - non-admin: greeting + one concrete example prompt.
  //   - admin: greeting, no example, and the /help hint also points at the
  //     admin management commands. The "shared identity across Feishu/terminal"
  //     line was dropped — the terminal is a slash-only console, not a second
  //     conversation surface.
  if (opts.isAdmin) {
    const lines = [
      t('channel.welcome.admin.intro'),
      '',
      t('channel.welcome.admin.helpHint'),
    ]
    return buildSystemNoticeCard({
      kind: 'info',
      title: t('channel.welcome.admin.title'),
      content: lines.join('\n'),
    })
  }
  const lines = [
    t('channel.welcome.intro'),
    '',
    t('channel.welcome.try.header'),
    t('channel.welcome.try.example'),
    '',
    t('channel.welcome.helpHint'),
  ]
  return buildSystemNoticeCard({
    kind: 'info',
    title: t('channel.welcome.title'),
    content: lines.join('\n'),
  })
}

export function buildStartupFailureCard(input: {
  reason: string
  elapsedSeconds: number
  timedOut: boolean
}): Record<string, unknown> {
  const body = input.timedOut
    ? t('channel.welcome.startup.timeoutBody', { seconds: String(input.elapsedSeconds) })
    : t('channel.welcome.startup.failedBody', {
        seconds: String(input.elapsedSeconds),
        // Fold raw stderr-flavored reason (Docker / Rlaunch / image-readiness
        // strings carrying ECONNREFUSED, brainctl exec failed, manifest
        // unknown, etc.) into a product-language category before the user
        // sees it. Raw reason still goes to stderr + admin diagnostics.
        reason: classifyStartupReason(input.reason),
      })
  return buildSystemNoticeCard({
    // Sandbox-start failure is a degraded/usually-recoverable condition (next
    // turn often recovers), not a genuine hard failure — orange, not red (D14).
    kind: 'warning',
    title: t('channel.welcome.startup.failedTitle'),
    content: body,
  })
}
