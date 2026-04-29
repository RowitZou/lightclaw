// System-feedback notice cards. Distinct from LLM replies (plain text) and
// permission-request cards (yellow). Two flavors:
//   - 'info'  → wathet (淡青蓝): success / routine notification
//   - 'error' → red  (红): failure / warning / timeout / rate-limited
//
// Title is implicit by template color so the card stays compact (no header
// title bar required on a wathet/red card with just a body line).

export type SystemNoticeKind = 'info' | 'error'

const TEMPLATE_BY_KIND: Record<SystemNoticeKind, string> = {
  info: 'wathet',
  error: 'red',
}

const TITLE_BY_KIND: Record<SystemNoticeKind, string> = {
  info: 'LightClaw 提示',
  error: 'LightClaw 警告',
}

export function buildSystemNoticeCard(input: {
  kind: SystemNoticeKind
  content: string
  title?: string
}): Record<string, unknown> {
  return {
    config: {
      enable_forward: false,
      wide_screen_mode: true,
    },
    header: {
      template: TEMPLATE_BY_KIND[input.kind],
      title: {
        tag: 'plain_text',
        content: input.title ?? TITLE_BY_KIND[input.kind],
      },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: input.content,
        },
      },
    ],
  }
}
