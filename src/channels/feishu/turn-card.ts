// Turn card (collab-phase4 PR25): one live card per user-initiated turn
// that needed tools. Interim narration — the blocks the model emits between
// tool calls — collapses into a single panel that patches in place; the
// turn's final reply goes out as a normal message (it is the conversation,
// and a card patch fires no push notification). A turn that answers in one
// shot produces no card at all.

import { t } from '../../i18n/index.js'

export type TurnCardEntry = {
  at: number
  text: string
}

export const TURN_CARD_MAX_ENTRIES = 20
export const TURN_CARD_ENTRY_MAX_CHARS = 200

function formatClock(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function buildTurnCard(
  entries: TurnCardEntry[],
  opts: { interrupted?: boolean; finalized?: boolean } = {},
): Record<string, unknown> {
  const shown = entries.slice(-TURN_CARD_MAX_ENTRIES)
  const dropped = entries.length - shown.length
  const lines = shown.map(entry => `**${formatClock(entry.at)}** ${entry.text}`)
  if (dropped > 0) {
    lines.unshift(t('turncard.earlier', { count: String(dropped) }))
  }
  if (opts.interrupted) {
    lines.push(t('turncard.interrupted'))
  }
  const elements: Record<string, unknown>[] = []
  // While the turn is live (or ended interrupted) the newest entry stays
  // visible above the collapsed panel so the user can follow along without
  // opening it. A clean finalize folds it back in — the final reply lands
  // right after the card and a stale "latest" line would compete with it.
  const latest = entries[entries.length - 1]
  if (latest && (!opts.finalized || opts.interrupted)) {
    elements.push({
      tag: 'markdown',
      content: `**${t('turncard.latest')} ${formatClock(latest.at)}** ${latest.text}`,
    })
  }
  elements.push({
    tag: 'collapsible_panel',
    expanded: false,
    header: {
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
