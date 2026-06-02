import { z } from 'zod'

import { getCurrentSessionContext } from '../session-context.js'
import { buildTool } from '../tool.js'
import {
  askUserQuestionViaFeishu,
  type AskUserQuestionAnswer,
  type AskUserQuestionInput,
} from '../channels/feishu/askuser-card.js'

const AskUserQuestionInputSchema = z.object({
  questions: z.array(z.object({
    question: z.string().min(1),
    header: z.string().min(1).max(12),
    options: z.array(z.object({
      label: z.string().min(1),
      description: z.string().optional(),
    })).min(2).max(4),
    multiSelect: z.boolean().default(false),
    defaultOptionIndex: z.number().int().nonnegative(),
  }).superRefine((question, ctx) => {
    if (question.defaultOptionIndex >= question.options.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['defaultOptionIndex'],
        message: 'defaultOptionIndex must refer to an existing option.',
      })
    }
  })).min(1).max(4),
})

export type AskUserQuestionOutput = {
  answers: AskUserQuestionAnswer[]
}

const ASK_USER_DESCRIPTION = `Ask the user a structured question when their request leaves a real choice
unresolved. Use this when:
- The work could go in two or more reasonable directions and which one the user
  wants matters for the outcome (naming, scope, style, target audience, which
  dataset, which approach).
- You need a fact only the user knows before continuing usefully.

Each call: 1-4 questions, each with 2-4 options. Set \`multiSelect\` when more
than one option could apply. Always set \`defaultOptionIndex\` — pick the
safest, least destructive option for the case the user is away. The default
fires on timeout so long-running work keeps moving; pick deliberately rather
than guessing.

Each question has its own free-text slot for anything the options don't
cover. Answers come back as \`selectedLabels\` plus an optional per-question
\`otherText\`.

Decide first, ask second. Don't use this to confirm a choice you already know,
to ask permission to proceed, or to elicit something you can reasonably try
yourself.`

export const askUserQuestionTool = buildTool<AskUserQuestionInput, AskUserQuestionOutput>({
  name: 'AskUserQuestion',
  whenToUse: 'Ask the user to choose among real unresolved options or provide a missing user-only fact.',
  // Deferred (task-specific): a structured question is reached for only when a
  // real choice is unresolved, not every turn — the frequency criterion that
  // governs inline-vs-deferred. The earlier always-load was a misdiagnosis:
  // deferral was never the cause of plain-text questions (a dogfood transcript
  // showed the model plain-texting with the tool already inline). The real fix
  // is the skill/role prompt strengthening the "ask via the card" instruction;
  // the deferred-tool self-heal nudges a direct call to ToolSearch when needed.
  shouldDefer: true,
  channelOnly: true,
  channelScope: ['feishu'],
  description: ASK_USER_DESCRIPTION,
  searchHint: 'ask user question choose option clarify ambiguity structured card 问用户 选择 澄清',
  domain: 'host',
  riskLevel: 'safe',
  inputSchema: AskUserQuestionInputSchema,
  async call(input, context) {
    const session = getCurrentSessionContext()
    if (!session?.channel) {
      return {
        output: {
          answers: [],
        },
        isError: true,
      }
    }
    const answers = await askUserQuestionViaFeishu({
      questions: input.questions,
      sessionId: session.sessionId,
      turnId: context.toolCallId ?? `${session.sessionId}:ask-user`,
      abortSignal: context.abortSignal,
    })
    return { output: { answers } }
  },
  formatResult(output, toolUseId, isError) {
    const lines = ['AskUserQuestion answers:']
    for (const answer of output.answers) {
      const timeoutSuffix = answer.byTimeoutDefault
        ? ' (timeout default; user did not actively choose)'
        : ''
      lines.push(
        `- ${answer.header}: ${answer.selectedLabels.join(', ') || '(no selection)'}${timeoutSuffix}`,
      )
      if (answer.otherText) {
        lines.push(`  other: ${answer.otherText}`)
      }
    }
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: lines.join('\n'),
      ...(isError ? { is_error: true } : {}),
    }
  },
})

export const __askUserQuestionDescriptionForSnapshot = ASK_USER_DESCRIPTION
