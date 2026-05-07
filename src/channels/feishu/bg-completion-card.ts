import type { PendingCardAction } from '../../background-task/types.js'

export function buildBackgroundTaskSuccessCard(pending: PendingCardAction): Record<string, unknown> {
  return buildCard({
    template: 'green',
    title: `BackgroundTask completed: ${pending.task.label}`,
    body: [
      `Task: ${pending.task.id}`,
      `Fired at: ${pending.firedAt}`,
      '',
      truncate(pending.outcome.kind === 'success' ? pending.outcome.summary : '', 800),
    ].join('\n'),
  })
}

export function buildBackgroundTaskFailureCard(pending: PendingCardAction): Record<string, unknown> {
  const reason = pending.outcome.kind === 'failure' ? pending.outcome.reason : 'unknown failure'
  return buildCard({
    template: pending.autopaused ? 'yellow' : 'red',
    title: pending.autopaused
      ? `BackgroundTask auto-paused: ${pending.task.label}`
      : `BackgroundTask failed: ${pending.task.label}`,
    body: [
      `Task: ${pending.task.id}`,
      `Fired at: ${pending.firedAt}`,
      `Attempts: ${pending.outcome.kind === 'failure' ? pending.outcome.attempt : 1}`,
      '',
      truncate(reason, 800),
    ].join('\n'),
    button: pending.autopaused
      ? undefined
      : {
          text: 'Retry now',
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
    title: `Retry started: ${pending.task.label}`,
    body: `Task: ${pending.task.id}\nA new fire has been queued.`,
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
