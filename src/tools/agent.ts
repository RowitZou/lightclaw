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

  for (const agent of getAllAgents()) {
    lines.push(`- ${agent.agentType}: ${agent.whenToUse}`)
  }

  lines.push(
    '',
    'Do not use this for trivial tasks. Each subagent starts a fresh context and is relatively expensive.',
    '',
    'When you launch multiple agents for independent work, send them in a single assistant message with multiple AgentTool tool_use blocks so they run concurrently.',
    'Only dispatch in parallel when the tasks operate on disjoint files, branches, working directories, or external resources — the runtime does not isolate subagent file systems or shared state, so concurrent writes to the same path will race. If two tasks could touch the same resource, run them serially in successive turns instead.',
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
