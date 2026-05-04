// System-feedback notice cards. Distinct from LLM replies (plain text) and
// permission-request cards (yellow). Two flavors:
//   - 'info'  → wathet: success / routine notification
//   - 'error' → red:    failure / warning / timeout / rate-limited
//
// Card title text is i18n-aware (LightClaw 提示 / LightClaw notice etc.) and
// resolved at render time via the active locale.

import { t } from '../../i18n/index.js'

export type SystemNoticeKind = 'info' | 'error'

const TEMPLATE_BY_KIND: Record<SystemNoticeKind, string> = {
  info: 'wathet',
  error: 'red',
}

function defaultTitle(kind: SystemNoticeKind): string {
  return kind === 'info'
    ? t('channel.system.title.info')
    : t('channel.system.title.error')
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
        content: input.title ?? defaultTitle(input.kind),
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
