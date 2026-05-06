// Welcome / startup-failure cards pushed to a freshly approved user. Distinct
// from the existing pairing welcome (sent BEFORE approval, asking the user to
// hand a code to admin) — this one is sent AFTER /user approve, once the
// per-user sandbox runtime (docker container or rlaunch worker) is ready to
// serve tool calls. The user has been silent up to this point; this is the
// first proactive push from the bot.

import { t } from '../../i18n/index.js'
import { buildSystemNoticeCard } from './system-notice.js'

export function buildApprovalWelcomeCard(): Record<string, unknown> {
  // Header is wathet (info) so it visually reads as a friendly notice rather
  // than a warning. Body bundles the welcome line + a short list of user-side
  // slash commands; admin-only commands (/user, /sandbox, /cost, /ceiling)
  // are intentionally omitted because the recipient is a non-admin channel
  // user and seeing them would be misleading.
  const lines = [
    t('channel.welcome.intro'),
    '',
    t('channel.welcome.cmdHeader'),
    `- ${t('channel.welcome.cmd.help')}`,
    `- ${t('channel.welcome.cmd.status')}`,
    `- ${t('channel.welcome.cmd.fresh')}`,
    `- ${t('channel.welcome.cmd.feedback')}`,
    `- ${t('channel.welcome.cmd.stop')}`,
    '',
    t('channel.welcome.tip'),
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
        reason: input.reason,
      })
  return buildSystemNoticeCard({
    kind: 'error',
    title: t('channel.welcome.startup.failedTitle'),
    content: body,
  })
}
