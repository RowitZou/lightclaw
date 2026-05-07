import type { PendingCardAction } from '../../background-task/types.js'
import { t } from '../../i18n/index.js'
import { isHighRiskRulePattern } from '../../permission/high-risk.js'

export function buildBackgroundTaskSuccessCard(pending: PendingCardAction): Record<string, unknown> {
  return buildCard({
    template: 'green',
    title: t('bg.card.success.title', { label: pending.task.label }),
    body: [
      `${t('bg.card.field.task')}: ${pending.task.id}`,
      `${t('bg.card.field.firedAt')}: ${pending.firedAt}`,
      '',
      truncate(pending.outcome.kind === 'success' ? pending.outcome.summary : '', 800),
    ].join('\n'),
  })
}

export function buildBackgroundTaskFailureCard(pending: PendingCardAction): Record<string, unknown> {
  const reason = pending.outcome.kind === 'failure'
    ? pending.outcome.reason
    : t('bg.card.failure.unknownReason')
  const attempts = pending.outcome.kind === 'failure' ? pending.outcome.attempt : 1
  return buildCard({
    template: pending.autopaused ? 'yellow' : 'red',
    title: pending.autopaused
      ? t('bg.card.autopaused.title', { label: pending.task.label })
      : t('bg.card.failure.title', { label: pending.task.label }),
    body: [
      `${t('bg.card.field.task')}: ${pending.task.id}`,
      `${t('bg.card.field.firedAt')}: ${pending.firedAt}`,
      `${t('bg.card.field.attempts')}: ${attempts}`,
      '',
      truncate(reason, 800),
    ].join('\n'),
    button: pending.autopaused
      ? undefined
      : {
          text: t('bg.card.btn.retry'),
          value: {
            kind: 'lightclaw_bg_task',
            action: 'retry_now',
            fireUuid: pending.fireUuid,
            taskId: pending.task.id,
            ownerCanonicalUser: pending.ownerCanonicalUser,
          },
        },
  })
}

export function buildBackgroundTaskRetryStartedCard(pending: PendingCardAction): Record<string, unknown> {
  return buildCard({
    template: 'wathet',
    title: t('bg.card.retryStarted.title', { label: pending.task.label }),
    body: [
      `${t('bg.card.field.task')}: ${pending.task.id}`,
      t('bg.card.field.queued'),
    ].join('\n'),
  })
}

export function buildPermissionFailureCard(pending: PendingCardAction): Record<string, unknown> {
  const denials = pending.outcome.kind === 'failure'
    ? pending.outcome.permissionDenials ?? []
    : []
  const suggestedRules = unique(denials.flatMap(denial => denial.suggestedRules))
  const hasHighRisk = suggestedRules.some(isHighRiskRulePattern)
  return buildCard({
    template: 'red',
    title: t('bg.card.permFail.title', { label: pending.task.label }),
    body: [
      `${t('bg.card.field.task')}: ${pending.task.id}`,
      `${t('bg.card.field.firedAt')}: ${pending.firedAt}`,
      '',
      ...denials.flatMap(denial => [
        `❌ ${denial.toolName} — ${denial.inputPreview}`,
        `${t('bg.card.permFail.suggest')}: ${denial.suggestedRules.map(rule => `\`${rule}\``).join(', ')}`,
        '',
      ]),
      ...(hasHighRisk ? [t('bg.card.permFail.highRiskWarn'), ''] : []),
      t('bg.card.permFail.scopeHint', { count: suggestedRules.length }),
    ].join('\n'),
    button: {
      text: t('bg.card.btn.approveRetry'),
      value: {
        kind: 'lightclaw_bg_task',
        action: 'approve_and_retry',
        fireUuid: pending.fireUuid,
        taskId: pending.task.id,
        ownerCanonicalUser: pending.ownerCanonicalUser,
      },
    },
  })
}

export function buildApproveRetryStartedCard(
  pending: PendingCardAction,
  approvedRules: string[],
): Record<string, unknown> {
  return buildCard({
    template: 'wathet',
    title: t('bg.card.approveRetryStarted.title', {
      label: pending.task.label,
      count: approvedRules.length,
    }),
    body: [
      `${t('bg.card.field.task')}: ${pending.task.id}`,
      t('bg.card.approveRetryStarted.body', {
        label: pending.task.label,
        count: approvedRules.length,
      }),
      approvedRules.map(rule => `\`${rule}\``).join(', '),
    ].join('\n'),
  })
}

function buildCard(input: {
  template: string
  title: string
  body: string
  button?: { text: string; value: Record<string, unknown> }
}): Record<string, unknown> {
  return {
    config: { enable_forward: false, wide_screen_mode: true },
    header: {
      template: input.template,
      title: { tag: 'plain_text', content: input.title },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: input.body } },
      ...(input.button
        ? [{
            tag: 'action',
            actions: [{
              tag: 'button',
              type: 'primary',
              text: { tag: 'plain_text', content: input.button.text },
              value: input.button.value,
            }],
          }]
        : []),
    ],
  }
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...`
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
