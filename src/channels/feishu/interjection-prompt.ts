import type { AssistantToolUseBlock, Message } from '../../types.js'
import type { InterjectionEntry } from './interjection-queue.js'

export type InterjectionContext = {
  interjections: InterjectionEntry[]
  originalUserText: string
  completedToolUses: Array<{ name: string; brief: string }>
}

export function buildInterjectionBlock(ctx: InterjectionContext): string {
  const lines: string[] = [
    '<user-interjection>',
    'The user sent the message(s) below while you were in the middle of executing their previous request.',
    'The previous request is NOT yet complete.',
    '',
  ]
  for (const entry of ctx.interjections) {
    if (entry.quotedSummary) {
      lines.push(entry.quotedSummary)
    }
    const from = entry.senderName ? ` (from ${entry.senderName})` : ''
    lines.push(`Interjection${from}: ${JSON.stringify(entry.text)}`)
    if (entry.attachmentPaths?.length) {
      // Path-only breadcrumb: the model opens the file via Read for
      // pixels. The "NEW input" framing matters — without it the model
      // tends to map "this image" / "translate it" onto inline blocks
      // already in conversation history rather than the just-attached
      // file (5/10 dogfood: agent translated turn-1's images instead of
      // the interjection's new image until the user complained).
      lines.push('  Newly attached file(s) — NOT yet seen by you. Call Read on each if the interjection refers to them:')
      for (const p of entry.attachmentPaths) {
        lines.push(`  - ${p}`)
      }
    }
  }
  lines.push(
    '',
    `Their original request: ${JSON.stringify(ctx.originalUserText)}`,
    'Tool calls completed so far:',
  )
  if (ctx.completedToolUses.length === 0) {
    lines.push('  (none - you have not yet executed any tools this turn)')
  } else {
    for (const toolUse of ctx.completedToolUses) {
      lines.push(`  - ${toolUse.name}: ${toolUse.brief}`)
    }
  }
  lines.push(
    '',
    'The previous request must still be completed UNLESS the user\'s interjection EXPLICITLY says to stop or cancel that specific task - e.g. "don\'t do that", "never mind that", "stop that", "abort it", "算了不要做了", "取消上面那个".',
    'Vague disinterest, course corrections, off-topic questions, or acknowledgements do NOT count as cancellation - only an unambiguous instruction to abandon the previous task counts.',
    '',
    'If the interjection IS such an explicit cancellation:',
    '  - Briefly acknowledge ("Got it, dropping <one-line summary of original>.")',
    '  - Stop work on the original task.',
    '  - If the interjection also contains a new request, start it; otherwise just wait for the user\'s next message.',
    '',
    'Otherwise:',
    '  Step 1 - classify by topic:',
    '    - On-topic: the interjection refines, comments on, or asks about the current task -> fold it into your existing plan.',
    '    - Off-topic: the interjection introduces a separate request -> treat it as an additional task that ALSO must be completed.',
    '',
    '  Step 2 - for off-topic, decide how to fit it in:',
    '    - Short/quick items (a fact, a one-line read, an acknowledgement) -> handle inline, then resume the original.',
    '    - Substantial and self-contained -> Dispatch it to a background worker (mode:\'background\') so it runs in parallel while you stay on the original. Briefly tell the user you have kicked it off. Prefer this whenever the new request is a separable chunk of work - it is the manager move and spares the user a serial wait.',
    '    - The original task is at a natural pause (between major steps) -> handle the new task in line.',
    '    - Otherwise -> finish the original first, then handle the new request.',
  )
  if (ctx.interjections.some(entry => entry.triggeredAutoDeny)) {
    lines.push(
      '',
      'Note: a permission ASK awaiting click has been auto-denied because of this interjection. Re-issue when appropriate (skip if the cancellation path above applies).',
    )
  }
  lines.push('</user-interjection>')
  return lines.join('\n')
}

export function extractOriginalUserText(messages: Message[]): string {
  // The "original request" is the LAST real user input — what the model is
  // currently working on when the interjection arrives — NOT the first
  // user message ever in the conversation. A naive `messages.find` returns
  // turn-1 input even after dozens of turns, which makes the interjection
  // block point at stale (and after empty-mention replay, sometimes empty)
  // text and dilutes the "previous request must be completed" rule.
  //
  // Walk backward; skip system-injected user messages so we land on the
  // most recent natural input:
  //   - tool_result-only user messages (no text block) — internal turn
  //     plumbing, not a user utterance.
  //   - earlier <user-interjection> blocks (text starts with that tag) —
  //     also system-injected, never the "original request".
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m.type !== 'user') continue
    const text = contentToText(m.message.content)
    if (!text) continue
    if (text.startsWith('<user-interjection>')) continue
    return text
  }
  return ''
}

export function extractCompletedToolUses(messages: Message[]): Array<{ name: string; brief: string }> {
  const completed = new Set<string>()
  for (const message of messages) {
    if (message.type !== 'user' || !Array.isArray(message.message.content)) continue
    for (const block of message.message.content) {
      if (block.type === 'tool_result') {
        completed.add(block.tool_use_id)
      }
    }
  }
  const out: Array<{ name: string; brief: string }> = []
  for (const message of messages) {
    if (message.type !== 'assistant') continue
    for (const block of message.message.content) {
      if (block.type !== 'tool_use' || !completed.has(block.id)) continue
      out.push({
        name: block.name,
        brief: summarizeToolInput(block),
      })
    }
  }
  return out
}

function contentToText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      block.type === 'text' && typeof block.text === 'string',
    )
    .map(block => block.text)
    .join('\n')
}

function summarizeToolInput(block: AssistantToolUseBlock): string {
  const raw = JSON.stringify(block.input)
  if (raw.length <= 120) return raw
  return `${raw.slice(0, 117)}...`
}
