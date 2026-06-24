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

import type { CommandListCardSpec, CommandListCardSection } from '../../commands/registry.js'
import { t } from '../../i18n/index.js'
import { card2, markdown, type Card2Element } from './card2.js'

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
  const content = input.bodyFormat === 'plain_text'
    ? escapeMarkdown(input.content)
    : input.content
  return card2({
    template: TEMPLATE_BY_KIND[input.kind],
    title: input.title ?? defaultTitle(input.kind),
    config: {
      enable_forward: false,
      wide_screen_mode: true,
    },
    elements: [markdown(content)],
  })
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+\-.!|<>])/g, '\\$1')
}

// CJK / full-width glyphs render ~2× the width of a latin char, so a chip like
// `add <别名> [参数]` is far wider than its `.length`. Counting code points by
// East-Asian width keeps the chip column wide enough that such chips don't wrap.
function isWideChar(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals / Kangxi / symbols
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana … CJK compat
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compat forms
    (cp >= 0xff00 && cp <= 0xff60) || // full-width forms
    (cp >= 0xffe0 && cp <= 0xffe6)
  )
}

function displayWidth(value: string): number {
  let width = 0
  for (const ch of value) {
    width += isWideChar(ch.codePointAt(0)!) ? 2 : 1
  }
  return width
}

// 8.6px ≈ per (latin) display-column width of the monospace-ish chip glyphs;
// +12 is the slack between the longest chip and the description column. Keep it
// small so the gap reads tight on narrow / mobile cards.
function leftColumnWidthFor(rows: ReadonlyArray<readonly [string, string]>): string {
  const maxCols = rows.reduce((m, [cmd]) => Math.max(m, displayWidth(cmd)), 0)
  return `${Math.round(maxCols * 8.6) + 12}px`
}

// One `column_set` PER command row: left = inline-code command chip, right =
// description. No header row, no table borders. Crucially each row is its own
// self-contained two-column set — so when a description wraps (narrow cards /
// mobile DM) the chip stays pinned top-left of *that* row and the next row
// starts cleanly below. (A single column_set holding all chips in one block and
// all descriptions in another only *looks* aligned at wide width: the moment
// the right block wraps to more lines than the left, the two blocks desync.)
// `leftWidth` is sized PER SECTION (to that section's longest chip) so a verb
// group (`list` / `add`) and a flag group (`--base-url <url>`) each hug their
// own chips instead of one giant shared column.
function commandRows(
  rows: ReadonlyArray<readonly [string, string]>,
  leftWidth: string,
): Card2Element[] {
  return rows.map(([cmd, desc]) => ({
    tag: 'column_set',
    horizontal_spacing: 'small',
    columns: [
      {
        tag: 'column',
        width: leftWidth,
        vertical_align: 'top',
        elements: [markdown(`\`${cmd}\``)],
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        vertical_align: 'top',
        elements: [markdown(desc)],
      },
    ],
  }))
}

/** Build a command-list notice card: one `column_set` per section (with an
 *  optional bold heading line), then the footer as a markdown line. Same header
 *  chrome as `buildSystemNoticeCard`. */
export function buildCommandListCard(input: {
  kind: SystemNoticeKind
  spec: CommandListCardSpec
  title?: string
}): Record<string, unknown> {
  const elements: Card2Element[] = []
  for (const section of input.spec.sections as CommandListCardSection[]) {
    // Section headings render bold AND one size up (heading-4) — on mobile,
    // bold alone is too subtle to read as a heading.
    if (section.heading) elements.push(markdown(`**${section.heading}**`, 'heading-4'))
    if (section.rows && section.rows.length > 0) {
      elements.push(...commandRows(section.rows, leftColumnWidthFor(section.rows)))
    }
    if (section.markdown) elements.push(markdown(section.markdown))
    // One fenced code block per example so each stands alone (per the L2
    // "示例" convention).
    for (const example of section.codeExamples ?? []) {
      elements.push(markdown(`\`\`\`\n${example}\n\`\`\``))
    }
  }
  if (input.spec.footer) elements.push(markdown(input.spec.footer))
  return card2({
    template: TEMPLATE_BY_KIND[input.kind],
    title: input.spec.title ?? input.title ?? defaultTitle(input.kind),
    config: { enable_forward: false, wide_screen_mode: true },
    elements,
  })
}
