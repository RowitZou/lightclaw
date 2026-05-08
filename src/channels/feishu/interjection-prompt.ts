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
    const from = entry.senderName ? ` (from ${entry.senderName})` : ''
    lines.push(`Interjection${from}: ${JSON.stringify(entry.text)}`)
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
    '  Step 2 - for off-topic, you choose execution order based on context:',
    '    - Short/quick items (a fact, a one-line read, an acknowledgement) -> handle inline, then resume the original.',
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
  const user = messages.find(message => message.type === 'user')
  if (!user) return ''
  return contentToText(user.message.content)
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
