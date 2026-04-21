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
  )
  return lines.join('\n')
}

export const agentTool = buildTool({
  name: 'AgentTool',
  description: buildAgentToolDescription(),
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
