import type { LightClawConfig } from '../config.js'
import { streamChat } from '../api.js'
import { readSessionMemory } from '../memory/session-memory.js'
import {
  createSystemCompactMessage,
  getLastUuid,
} from '../messages.js'
import { resolveToolModuleModel } from '../model-resolution.js'
import { getCurrentSessionContext } from '../session-context.js'
import { estimateTokens } from '../token-estimate.js'
import {
  toolResultContentToText,
  type Message,
  type UsageStats,
  type UserToolResultBlock,
} from '../types.js'

type CompactParams = {
  messages: Message[]
  keepRecent: number
  config: LightClawConfig
  /** When set, current SessionMemory is read and prepended to the
   *  compact boundary summary so it survives compaction. */
  sessionId?: string
}

export type CompactResult = {
  messages: Message[]
  summaryTokens: number
  removedCount: number
  usage: UsageStats
}

function serializeMessage(message: Message): string {
  if (message.type === 'system') {
    return `[Compact Summary]\n${message.message.summary}`
  }

  if (message.type === 'user') {
    if (typeof message.message.content === 'string') {
      return `[User]\n${message.message.content}`
    }

    const blocks = message.message.content
      .map(block => {
        if (block.type === 'text') {
          return `[User Text]\n${block.text}`
        }
        if (block.type === 'image') {
          return `[Inline Image: ${block.source.mediaType}]`
        }
        if (block.type === 'document') {
          return `[Inline Document: ${block.source.mediaType}]`
        }
        return `[Tool Result: ${block.tool_use_id}${block.is_error ? ' error' : ''}]\n${toolResultContentToText(block.content)}`
      })
      .join('\n')
    return `[User]\n${blocks}`
  }

  const assistantBlocks = message.message.content
    .map(block => {
      if (block.type === 'text') return block.text
      if (block.type === 'tool_use') {
        return `[Tool Use: ${block.name}]\n${JSON.stringify(block.input, null, 2)}`
      }
      // Drop thinking / redacted_thinking from the compaction prompt — the
      // summarizer doesn't need the chain-of-thought, and the redacted
      // payload would only inflate the prompt with opaque bytes.
      return ''
    })
    .filter(Boolean)
    .join('\n')
  return `[Assistant]\n${assistantBlocks}`
}

function withParentUuid(message: Message, parentUuid: string | null): Message {
  return {
    ...message,
    parentUuid,
  }
}

/**
 * Walk the proposed split boundary leftward (i.e. compress more, keep more)
 * until `messages[splitIndex]` does not start with a `user` message that
 * carries `tool_result` blocks whose matching `tool_use` lives in the
 * to-be-compressed prefix. Pulling the boundary left re-includes the
 * preceding assistant message (which holds the `tool_use`) into `toKeep` so
 * the pair stays together.
 *
 * OpenAI Responses API rejects orphan `function_call_output` items with a
 * 400 (`No tool call found for function call output with call_id ...`).
 * Anthropic Messages API is lenient about this, so the bug only surfaces
 * when an OpenAI-schema model picks up a transcript that was compacted
 * mid-pair.
 */
export function findSafeSplitIndex(
  messages: Message[],
  initial: number,
): number {
  let split = Math.max(0, Math.min(initial, messages.length))
  // Cap the rewind so a pathologically long unbroken tool_use/tool_result
  // chain at the boundary cannot drag the entire prefix into toKeep.
  const maxRewind = 32
  let rewinds = 0
  while (split > 0 && rewinds < maxRewind) {
    const first = messages[split]
    if (!first || first.type !== 'user') break
    const content = first.message.content
    if (typeof content === 'string') break
    const hasToolResult = content.some(
      (block): block is UserToolResultBlock => block.type === 'tool_result',
    )
    if (!hasToolResult) break
    // toKeep[0] is a user message containing tool_result(s). Since toKeep
    // starts with this user message, the matching assistant tool_use cannot
    // live inside toKeep — it must be in the compressed prefix. Pull the
    // boundary left so the preceding assistant message (holding tool_use)
    // joins toKeep, then re-evaluate.
    split--
    rewinds++
  }
  return split
}

// ----------------------------------------------------------------------------
// Compact prompt — ported from Claude Code's
// claude-code-main/src/services/compact/prompt.ts (Bug 5 in 2026-05-10 audit).
// The pre-port prompt was 4 generic preserve points + an 81-char system
// message and routinely produced single-entity summaries that conflated two
// distinct files / papers / topics, plus stripped failure-cause from errors
// so retries repeated the same failed approach.
//
// Notable additions over the Claude Code original (kept intentionally; tied
// to lightclaw bugs surfaced in 2026-05-10 dogfood):
//   - Section 4 (Errors and fixes) explicitly demands a "Why it failed"
//     line per error, not just "How fixed". Without this gpt-5-4-mini drops
//     the failure cause and the next turn re-tries the same Grep-on-PDF.
//   - Section 6 (All user messages) keeps the verbatim quoting requirement
//     so entity tracking has explicit anchors.
//   - The continuation header in formatCompactBoundaryText() tells the
//     resumed agent NOT to retry steps marked failed in section 4.
// ----------------------------------------------------------------------------

const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`

const ANALYSIS_INSTRUCTION_BASE = `Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts, and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and **why each failed approach failed**, not just what eventually worked
   - Pay special attention to user feedback, especially redirections
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.`

const ANALYSIS_INSTRUCTION_PARTIAL = `Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts. In your analysis process:

1. Analyze the recent messages chronologically (those after the earlier compact boundary). For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts, and code patterns
   - Specific details: file names, full code snippets, function signatures, file edits
   - Errors that you ran into and **why each failed approach failed**, not just what eventually worked
   - User feedback, especially redirections
2. Double-check for technical accuracy and completeness.`

const SECTIONS_BASE = `Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail.
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable, plus a one-line summary of why this file read or edit matters. Distinct files / artifacts / papers MUST be enumerated as separate entries; do NOT collapse them under a single heading even when they were discussed in the same turn.
4. Errors and fixes: List ALL errors that you ran into. For EACH error, give: (a) what failed, (b) **why this approach failed** (binary file rejected by ripgrep, model lacks vision capability, schema mismatch, missing dependency, etc), (c) how you eventually fixed it (or noted as still-open if unresolved), (d) any user feedback received about the error. The "why it failed" is critical — without it, the resumed agent will re-try the identical failed approach.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results, verbatim or close to it. These are critical for understanding the user's feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take, DIRECTLY in line with the user's most recent explicit request and the task you were working on immediately before this summary. If the last task was concluded, only list next steps if they are explicitly in line with the user's request. Include verbatim quotes from the most recent conversation showing exactly what task you were working on and where you left off — this prevents drift in task interpretation.`

const SECTIONS_PARTIAL = `Your summary should include the following sections:

1. Primary Request and Intent: Capture the user's explicit requests and intents from the recent messages.
2. Key Technical Concepts: List important technical concepts, technologies, and frameworks discussed recently.
3. Files and Code Sections: Enumerate specific files and code sections from the recent portion. Distinct files / artifacts MUST be enumerated as separate entries — do NOT collapse two different files into one entry just because they were discussed close together.
4. Errors and fixes: For each error, list (a) what failed, (b) **why this approach failed**, (c) how it was fixed (or marked unresolved), (d) user feedback if any. The "why it failed" line prevents repeated identical retries.
5. Problem Solving: Problems solved and ongoing troubleshooting.
6. All user messages: List ALL user messages from the recent portion that are not tool results.
7. Pending Tasks: Pending tasks from the recent messages.
8. Current Work: Precisely what was being worked on immediately before this summary.
9. Optional Next Step: Next step related to the most recent work. Include verbatim quotes showing where you left off.`

const EXAMPLE_BLOCK = `Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]

3. Files and Code Sections:
   - [File Name 1]
     - [Why this file matters]
     - [Important code snippet]
   - [File Name 2]
     - [Why this file matters]

4. Errors and fixes:
   - [Error 1]:
     - Why it failed: [root cause]
     - How fixed: [actual fix or "still open"]
     - User feedback: [any]
   - [Error 2]:
     - Why it failed: ...

5. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]

6. All user messages:
   - [Detailed non-tool-use user message]

7. Pending Tasks:
   - [Task 1]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Verbatim quote: "..."]

</summary>
</example>`

const NO_TOOLS_TRAILER =
  '\n\nREMINDER: Do NOT call any tools. Respond with plain text only — '
  + 'an <analysis> block followed by a <summary> block. '
  + 'Tool calls will be rejected and you will fail the task.'

const BASE_COMPACT_PROMPT =
  `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions. This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing the work without losing context.\n\n`
  + ANALYSIS_INSTRUCTION_BASE
  + '\n\n'
  + SECTIONS_BASE
  + '\n\n'
  + EXAMPLE_BLOCK
  + '\n\nPlease provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.'

// Bug B in 2026-05-11 audit: in the partial path the conversation prompt
// the sub-LLM sees is shaped like
//
//   Conversation:
//   [Compact Summary]
//   <prior summary text>
//   [User]
//   [Tool Result: call_...]
//   ...
//
// Without explicit guidance the sub-LLM treated those bracket-markers as if
// they were user-said text and dumped them into section 6 "All user messages"
// before recovering to find the real query. The dumped wrapper text is noise
// in the summary; tighten the prompt to call out the framing markers
// explicitly so the sub-LLM knows to skip them.
const PARTIAL_MARKER_GUIDE =
  'When listing "All user messages", treat the following bracket-prefixed entries '
  + 'in the Conversation block as serialization framing, NOT as user-said text: '
  + '`[Compact Summary]`, `[Tool Result: ...]`, `[Tool Use: ...]`, `[Inline Image: ...]`, '
  + '`[Inline Document: ...]`. Only the text body inside an entry that starts with '
  + '`[User]` followed by `[User Text]` is an actual user message. If the recent '
  + 'portion contains no `[User Text]` blocks (e.g. the recent activity was tool-driven '
  + 'follow-up to a prior user message), state that explicitly: '
  + '"No new user messages in the recent portion; the user request is the one captured '
  + 'in the prior compact summary."'

const PARTIAL_COMPACT_PROMPT =
  `Your task is to create a detailed summary of the RECENT portion of the conversation — the messages that follow an earlier compact boundary. The earlier compact summary is shown to you for context but does NOT need to be re-summarized; focus your summary on what happened AFTER it.\n\n`
  + ANALYSIS_INSTRUCTION_PARTIAL
  + '\n\n'
  + SECTIONS_PARTIAL
  + '\n\n'
  + PARTIAL_MARKER_GUIDE
  + '\n\n'
  + EXAMPLE_BLOCK
  + '\n\nPlease provide your summary based on the RECENT messages only (after the retained compact boundary), following this structure and ensuring precision and thoroughness.'

function getCompactSystemPrompt(hasExistingCompactBoundary: boolean): string {
  const template = hasExistingCompactBoundary ? PARTIAL_COMPACT_PROMPT : BASE_COMPACT_PROMPT
  return NO_TOOLS_PREAMBLE + template + NO_TOOLS_TRAILER
}

export function buildCompactPrompt(messages: Message[]): string {
  const serializedMessages = messages.map(serializeMessage).join('\n\n')
  return ['Conversation:', serializedMessages].join('\n')
}

const SKILL_CONTENT_RE =
  /<skill-content name="([a-z0-9][a-z0-9-]{0,63})">[\s\S]*?<\/skill-content>/g

export function stripSkillContentForCompaction(text: string): { text: string; roster: string[] } {
  const seen = new Set<string>()
  const roster: string[] = []
  const stripped = text.replace(SKILL_CONTENT_RE, (_match, name: string) => {
    if (!seen.has(name)) {
      seen.add(name)
      roster.push(name)
    }
    return `[skill "${name}" was loaded here; its instructions are omitted from this summary and can be reloaded via UseSkill]`
  })

  return { text: stripped, roster }
}

/**
 * Strip the `<analysis>` drafting scratchpad and unwrap `<summary>` tags from
 * the model output, leaving the bare structured summary. Mirrors Claude
 * Code's `formatCompactSummary` so resumed sessions see the same shape they
 * would on Claude Code.
 */
export function formatCompactSummary(raw: string): string {
  let formatted = raw

  // Drop analysis scratchpad — improves summary quality at write time but
  // pure noise once the summary is written.
  formatted = formatted.replace(/<analysis>[\s\S]*?<\/analysis>/g, '')

  // Unwrap <summary>...</summary> if present (model usually emits both tags).
  const match = formatted.match(/<summary>([\s\S]*?)<\/summary>/)
  if (match) {
    formatted = (match[1] ?? '').trim()
  }

  return formatted.replace(/\n\n+/g, '\n\n').trim()
}

/**
 * Continuation header prepended to the compact summary text. Tells the
 * resumed agent (a) this is mid-conversation, (b) do not recap, (c) do not
 * retry steps marked failed in section 4. Inspired by Claude Code's
 * `getCompactUserSummaryMessage` — but inlined into the system summary
 * because lightclaw stores the compact boundary as a single `system`
 * message rather than a synthesized user message.
 */
function formatReloadableSkillsBlock(roster: string[]): string {
  return [
    '<reloadable-skills>',
    'The full instructions for these skills were loaded earlier in this conversation and elided from the summary above. If you need their exact steps again, call UseSkill with the skill name:',
    ...roster.map(name => `- ${name}`),
    '</reloadable-skills>',
  ].join('\n')
}

function formatCompactBoundaryText(summary: string, roster: string[] = []): string {
  const header = [
    'This session continues from a previous conversation that was compacted to fit context.',
    'The structured summary below covers the earlier portion. Continue from where you left off — '
    + 'do NOT recap what is in the summary, do NOT acknowledge the summary, and do NOT retry '
    + 'steps marked failed in the "Errors and fixes" section.',
  ].join('\n')
  const body = roster.length > 0
    ? `${summary}\n\n${formatReloadableSkillsBlock(roster)}`
    : summary
  return `${header}\n\n${body}`
}

type SummaryRequester = (
  prompt: string,
  systemPrompt: string,
  config: LightClawConfig,
) => Promise<{ summary: string; usage: UsageStats }>

let compactSummaryRequesterForTest: SummaryRequester | null = null

export function setCompactSummaryRequesterForTest(requester: SummaryRequester | null): void {
  compactSummaryRequesterForTest = requester
}

async function requestSummary(
  prompt: string,
  systemPrompt: string,
  config: LightClawConfig,
): Promise<{ summary: string; usage: UsageStats }> {
  let summary = ''
  let usage: UsageStats = {}

  for await (const event of streamChat({
    config,
    model: resolveToolModuleModel('compact', config),
    maxTokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: prompt }],
    tools: [],
    apiLogContext: { kind: 'compact' },
  })) {
    if (event.type === 'text') {
      summary += event.text
      continue
    }

    if (event.type === 'stop') {
      usage = event.usage
    }
  }

  const trimmedSummary = summary.trim()
  if (trimmedSummary.length === 0) {
    throw new Error('Compaction returned an empty summary.')
  }

  return {
    summary: trimmedSummary,
    usage,
  }
}

export async function compactConversation(
  params: CompactParams,
): Promise<CompactResult> {
  const keepRecent = Math.max(0, params.keepRecent)
  const initialSplit = Math.max(0, params.messages.length - keepRecent)
  const splitIndex = findSafeSplitIndex(params.messages, initialSplit)
  const toCompress = params.messages.slice(0, splitIndex)
  const toKeep = params.messages.slice(splitIndex)

  if (toCompress.length < 4) {
    return {
      messages: [...params.messages],
      summaryTokens: 0,
      removedCount: 0,
      usage: {},
    }
  }

  // Detect whether the prefix already contains a `[Compact Summary]` system
  // message — i.e. this is a second-pass compact eating the output of an
  // earlier compact. In that case prefer the partial prompt (don't ask the
  // model to re-summarize the prior summary; ask it to summarize what
  // followed). Without this branch the second compact tends to over-collapse
  // the original summary and freeze any inaccuracies it carried in.
  const hasExistingCompactBoundary = toCompress.some(m => m.type === 'system')
  const systemPrompt = getCompactSystemPrompt(hasExistingCompactBoundary)
  const rawPrompt = buildCompactPrompt(toCompress)
  const { text: userPrompt, roster } = stripSkillContentForCompaction(rawPrompt)
  const summaryRequester = compactSummaryRequesterForTest ?? requestSummary
  const { summary: rawSummary, usage } = await summaryRequester(
    userPrompt,
    systemPrompt,
    params.config,
  )
  const summary = formatCompactBoundaryText(formatCompactSummary(rawSummary), roster)

  // P1: keep SessionMemory glued to the compact boundary so the next system
  // prompt build still sees the freshly-frozen task skeleton even before the
  // model has a chance to reference the session-memory.md file.
  let composedSummary = summary
  if (params.sessionId) {
    const sessionsDir = getCurrentSessionContext()?.sessionsDir ?? params.config.paths.sessions
    const sm = await readSessionMemory(params.sessionId, sessionsDir)
    const trimmedSm = sm.trim()
    if (trimmedSm.length > 0) {
      composedSummary = `## Session Working Memory (frozen at compact)\n${trimmedSm}\n\n---\n\n${summary}`
    }
  }

  const boundary = createSystemCompactMessage({
    summary: composedSummary,
    parentUuid: getLastUuid(toCompress),
  })

  const nextMessages = [
    boundary,
    ...toKeep.map((message, index) =>
      index === 0 ? withParentUuid(message, boundary.uuid) : message,
    ),
  ]

  return {
    messages: nextMessages,
    summaryTokens: estimateTokens(composedSummary),
    removedCount: toCompress.length,
    usage,
  }
}
