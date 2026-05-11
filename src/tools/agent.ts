import { z } from 'zod'

import { getAllAgents } from '../agents/registry.js'
import { runSubagent } from '../agents/run-subagent.js'
import type { AgentType } from '../agents/types.js'
import { buildTool } from '../tool.js'

function buildAgentToolDescription(): string {
  const lines = [
    'Launch a subagent to handle a focused task with an isolated context.',
    '',
    'Available subagent types:',
  ]

  // Only surface user-facing agents to the main agent. Internal agents
  // (extract_memories, auto_dream) are framework-managed and not dispatchable
  // via AgentTool; including them would let the model invoke them by name.
  for (const agent of getAllAgents()) {
    if (agent.kind === 'internal') {
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
  description: buildAgentToolDescription(),
  domain: 'host',
  riskLevel: 'execute',
  // Multiple AgentTool tool_use blocks emitted in the same assistant message
  // run as a single Promise.all batch (query.ts dispatcher). Independence is
  // the dispatching model's responsibility — see the description above.
  concurrencySafe: true,
  inputSchema: z.object({
    subagent_type: z.enum(['general-purpose', 'explore']),
    description: z.string().min(3).max(80),
    prompt: z.string().min(10),
  }),
  async call(input, context) {
    const result = await runSubagent({
      agentType: input.subagent_type as AgentType,
      prompt: input.prompt,
      signal: context.abortSignal,
    })

    return {
      output: result.finalText || '(subagent returned empty text)',
    }
  },
})
