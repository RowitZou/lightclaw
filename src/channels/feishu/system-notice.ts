// System-feedback notice cards. Distinct from LLM replies (plain text) and
// permission-request cards (yellow). Three flavors (red kept scarce — see the
// D14 color rationalization: red is only for genuine hard failure):
//   - 'info'    → wathet: success / routine / transient-will-self-heal
//   - 'warning' → orange: needs attention but recoverable / actionable
//                         (billing wall, model/endpoint config, auth)
//   - 'error'   → red:    genuine hard failure / unrecoverable / urgent
//
// Card title text is i18n-aware (LightClaw 提示 / LightClaw notice etc.) and
// resolved at render time via the active locale.
//
// Body format:
//   - 'lark_md'    (default): supports **bold**, code fences, etc — used by
//                  pairing welcome / failure card / permission-card notices
//                  where we want bold emphasis on a code or status word.
//   - 'plain_text' (opt-in):  feishu renders the content 100% literally —
//                  used by slash command output where lark_md would otherwise
//                  eat <prompt>/<n>/<rule> as HTML tags and [...|...] as
//                  markdown links. lark_md does NOT honor backtick fences,
//                  so wrapping in ``` doesn't help; flipping the tag to
//                  plain_text is the only mechanism that actually disables
//                  the parser.

import { t } from '../../i18n/index.js'

export type SystemNoticeKind = 'info' | 'warning' | 'error'
export type SystemNoticeBodyFormat = 'lark_md' | 'plain_text'

const TEMPLATE_BY_KIND: Record<SystemNoticeKind, string> = {
  info: 'wathet',
  warning: 'orange',
  error: 'red',
}

function defaultTitle(kind: SystemNoticeKind): string {
  if (kind === 'info') {
    return t('channel.system.title.info')
  }
  if (kind === 'warning') {
    return t('channel.system.title.warning')
  }
  return t('channel.system.title.error')
}

export function buildSystemNoticeCard(input: {
  kind: SystemNoticeKind
  content: string
  title?: string
  bodyFormat?: SystemNoticeBodyFormat
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
          tag: input.bodyFormat ?? 'lark_md',
          content: input.content,
        },
      },
    ],
  }
}
