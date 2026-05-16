import { z } from 'zod'

import { getAllAgents } from '../agents/registry.js'
import { buildTool } from '../tool.js'

function buildAgentToolDescription(): string {
  const lines = [
    'Launch a subagent to handle a focused task with an isolated context.',
    '',
    'Available subagent types:',
  ]

  // Only surface worker agents to the main agent. Internal agents are
  // framework-managed, and the main orchestrator is not dispatchable through
  // AgentTool.
  for (const agent of getAllAgents()) {
    if (agent.kind !== 'worker') {
      continue
    }
    lines.push(`- ${agent.agentType}: ${agent.whenToUse}`)
  }

  lines.push(
    '',
    'When NOT to use AgentTool:',
    '- Reading a specific file → use Read.',
    '- Finding a specific symbol / class / function → use Grep.',
    '- Searching 2-3 known files → use Read in parallel.',
    '- Trivial questions answerable from your own context.',
    '- Work whose result you do NOT need in this turn (a reminder, a scheduled report, background monitoring) → use BackgroundTask, not AgentTool.',
    '',
    'AgentTool vs BackgroundTask — the dividing line is WHEN you need the result:',
    '- In THIS turn, and you can afford to wait for it → AgentTool. Forks now; the turn blocks until every forked agent returns its summary.',
    '- Later, on a schedule, or not at all unless something happens → BackgroundTask. Detached: returns immediately, the result lands later via a user card or a wake-up.',
    '',
    'Parallelism:',
    '- Launch independent agents as multiple AgentTool tool_use blocks in a SINGLE assistant message — they run concurrently.',
    '- Only parallelize tasks that touch disjoint files / branches / resources. The runtime does not isolate subagent file systems; concurrent writes to the same path will race. If two tasks could touch the same resource, run them serially in successive turns instead.',
    '',
    'Writing the prompt — the agent has NOT seen this conversation:',
    '- Explain what you\'re trying to accomplish and why.',
    '- Describe what you\'ve already learned or ruled out.',
    '- Give enough surrounding context that the agent can make judgment calls, not just follow a narrow instruction.',
    '- If you need a short response, say so ("report in under 200 words").',
    '- Lookups: hand over the exact pattern / path. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.',
    '- NEVER write "based on your findings, fix the bug" or "based on the research, implement it". That pushes synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.',
    '',
    'Trust but verify: the agent returns a single final-text summary. Tool results from inside the agent are NOT visible to you. If the agent reports writing code, check the actual changes before reporting the task as done.',
    '',
    'Each subagent starts a fresh context and is relatively expensive. Don\'t use it for trivial tasks.',
  )
  return lines.join('\n')
}

export const agentTool = buildTool({
  name: 'AgentTool',
  shouldDefer: true,
  description: buildAgentToolDescription(),
  searchHint: 'web search browse fetch url 查资料 查证 取网页 找链接 检索 fact-check verify research explore codebase',
  domain: 'host',
  riskLevel: 'execute',
  // Multiple AgentTool tool_use blocks emitted in the same assistant message
  // run as a single Promise.all batch (query.ts dispatcher). Independence is
  // the dispatching model's responsibility — see the description above.
  concurrencySafe: true,
  inputSchema: z.object({
    subagent_type: z.enum(['general-purpose', 'explore', 'web']),
    description: z.string().min(3).max(80),
    prompt: z.string().min(10),
  }),
  async call(input, context) {
    const { executeDispatch } = await import('./dispatch.js')
    return executeDispatch({
      role: input.subagent_type === 'general-purpose' ? 'general' : input.subagent_type,
      prompt: input.prompt,
      schedule: 'now',
      mode: 'blocking',
      label: input.description,
    }, context)
  },
})
