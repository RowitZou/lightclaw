// Turn card (collab-phase4 PR25): one live card per user-initiated turn
// that needed tools. Interim narration — the blocks the model emits between
// tool calls — collapses into a single panel that patches in place, with
// the newest entry pinned visible above the panel; the turn's final reply
// goes out as a normal message (it is the conversation, and a card patch
// fires no push notification). A turn that answers in one shot produces no
// card at all. The card is created on the FIRST tool-bearing response even
// before any narration text exists, so it lands in the chat timeline ahead
// of any card a tool creates (e.g. the task card).

import { t } from '../../i18n/index.js'
import { capStreamPreview, greyInline, TASK_CARD_STREAM_PREVIEW_MAX_LINES } from './task-card.js'

export type TurnCardEntry = {
  at: number
  text: string
}

export const TURN_CARD_MAX_ENTRIES = 20
export const TURN_CARD_ENTRY_MAX_CHARS = 200
// Feishu cardkit element_id must match ^[A-Za-z][A-Za-z0-9_]{0,19}$ (letter
// start, alnum/underscore, ≤20 chars; no colon — error 300301).
export const TURN_CARD_PROGRESS_ELEMENT_ID = 'turnprogress'

function formatClock(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function buildTurnCard(
  entries: TurnCardEntry[],
  opts: { interrupted?: boolean; finalized?: boolean } = {},
): Record<string, unknown> {
  const elements: Record<string, unknown>[] = []
  if (entries.length === 0) {
    // Eagerly-created card: the turn went straight to tool calls and no
    // narration has landed yet. One status line, no empty panel.
    const line = opts.interrupted
      ? t('turncard.interrupted')
      : opts.finalized
        ? t('turncard.empty')
        : t('turncard.starting')
    elements.push({ tag: 'markdown', content: line })
    return {
      schema: '2.0',
      config: { update_multi: true },
      body: { elements },
    }
  }
  const shown = entries.slice(-TURN_CARD_MAX_ENTRIES)
  const dropped = entries.length - shown.length
  const lines = shown.map(entry => `**${formatClock(entry.at)}** ${entry.text}`)
  if (dropped > 0) {
    lines.unshift(t('turncard.earlier', { count: String(dropped) }))
  }
  if (opts.interrupted) {
    lines.push(t('turncard.interrupted'))
  }
  // The newest entry stays pinned above the collapsed panel — live it
  // scrolls with each patch, and at rest the card still tells what
  // happened last without opening the panel.
  const latest = entries[entries.length - 1]!
  // Small grey "最新 HH:MM" label over the live line (grey markdown — schema 2.0
  // has no `note` element; the label is single-line so inline `<font>` is safe).
  elements.push({ tag: 'markdown', content: greyInline(`${t('turncard.latest')} ${formatClock(latest.at)}`) })
  elements.push({
    // Streaming target — a fixed-height 2-line plain_text glimpse, div-wrapped
    // (a bare top-level plain_text is rejected — 10002). plain_text renders
    // verbatim so partial markdown never flashes; capStreamPreview pads to 2
    // lines for constant height. Streaming targets the inner plain_text's
    // element_id. The full narration is in the collapsible panel below.
    tag: 'div',
    text: {
      tag: 'plain_text',
      element_id: TURN_CARD_PROGRESS_ELEMENT_ID,
      content: capStreamPreview(latest.text),
      lines: TASK_CARD_STREAM_PREVIEW_MAX_LINES,
    },
  })
  elements.push({
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      icon: {
        tag: 'standard_icon',
        token: 'right_outlined',
      },
      title: {
        tag: 'markdown',
        content: `**${t('turncard.panel.title', { count: String(entries.length) })}**`,
      },
    },
    // Blank line between entries — multi-line entries are hard to tell
    // apart in lark_md without a paragraph break.
    elements: [{ tag: 'markdown', content: lines.join('\n\n') }],
  })
  return {
    schema: '2.0',
    config: {
      update_multi: true,
    },
    body: { elements },
  }
}

export function truncateTurnCardEntry(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= TURN_CARD_ENTRY_MAX_CHARS) return oneLine
  return `${oneLine.slice(0, TURN_CARD_ENTRY_MAX_CHARS - 1)}…`
}
