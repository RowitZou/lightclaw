// Welcome / startup-failure cards pushed to a freshly approved user. Distinct
// from the existing pairing welcome (sent BEFORE approval, asking the user to
// hand a code to admin) — this one is sent AFTER /user approve, once the
// per-user sandbox runtime (docker container or rlaunch worker) is ready to
// serve tool calls. The user has been silent up to this point; this is the
// first proactive push from the bot.

import { t } from '../../i18n/index.js'
import { classifyStartupReason } from './startup-reason.js'
import { buildSystemNoticeCard } from './system-notice.js'

export function buildApprovalWelcomeCard(opts: { isAdmin?: boolean } = {}): Record<string, unknown> {
  // Header is wathet (info) so it visually reads as a friendly notice rather
  // than a warning. Two variants by recipient role:
  //   - non-admin: welcome + user-side slashes only. Admin-only commands
  //     (/user, /sandbox, /cost, /ceiling) are intentionally omitted because
  //     showing them to a non-admin would be misleading and produce
  //     "admin-only" rejections at dispatch.
  //   - admin: a dedicated "admin identity bound" body listing admin
  //     management commands. /feedback is dropped because admin is the
  //     recipient of feedback, not the sender.
  if (opts.isAdmin) {
    const lines = [
      t('channel.welcome.admin.intro'),
      '',
      t('channel.welcome.cmdHeader'),
      `- ${t('channel.welcome.cmd.help')}`,
      `- ${t('channel.welcome.cmd.status')}`,
      `- ${t('channel.welcome.cmd.stop')}`,
      '',
      t('channel.welcome.admin.cmdHeader'),
      `- ${t('channel.welcome.admin.cmd.user')}`,
      `- ${t('channel.welcome.admin.cmd.ceiling')}`,
      `- ${t('channel.welcome.admin.cmd.cost')}`,
      `- ${t('channel.welcome.admin.cmd.sandbox')}`,
      '',
      t('channel.welcome.tip'),
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
    t('channel.welcome.cmdHeader'),
    `- ${t('channel.welcome.cmd.help')}`,
    `- ${t('channel.welcome.cmd.status')}`,
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
        // Fold raw stderr-flavored reason (Docker / Rlaunch / image-readiness
        // strings carrying ECONNREFUSED, brainctl exec failed, manifest
        // unknown, etc.) into a product-language category before the user
        // sees it. Raw reason still goes to stderr + admin diagnostics.
        reason: classifyStartupReason(input.reason),
      })
  return buildSystemNoticeCard({
    kind: 'error',
    title: t('channel.welcome.startup.failedTitle'),
    content: body,
  })
}
