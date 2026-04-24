import { getConfig } from '../config.js'
import { createUserMessage } from '../messages.js'
import { buildSubagentPrompt } from '../prompt.js'
import { getProvider, modelFor } from '../provider/index.js'
import { query } from '../query.js'
import { getCwd } from '../state.js'
import type { Tool } from '../tool.js'
import { getAllTools, getEnabledTools } from '../tools.js'
import type { AgentType } from './types.js'
import { getAgent } from './registry.js'

const BLOCKED_SUBAGENT_TOOLS = new Set([
  'AgentTool',
  'TodoWrite',
  'MemoryWrite',
])

function filterTools(definitionTools: string[] | ['*'], enabledTools: Tool[]): Tool[] {
  const names = definitionTools.includes('*') ? null : new Set(definitionTools)
  return enabledTools.filter(tool => {
    if (BLOCKED_SUBAGENT_TOOLS.has(tool.name)) {
      return false
    }

    return !names || names.has(tool.name)
  })
}

export async function runSubagent(params: {
  agentType: AgentType
  prompt: string
  signal?: AbortSignal
}): Promise<{ finalText: string; stopReason: string | null }> {
  const agent = getAgent(params.agentType)
  if (!agent) {
    throw new Error(`Unknown agent: ${params.agentType}`)
  }

  const config = getConfig()
  const provider = getProvider(config)
  const tools = filterTools(agent.tools, getEnabledTools(provider, getAllTools()))
  // Model routing for subagents is still overridden here; auto-compact /
  // auto-memory gating is now driven by `mode: 'subagent'` in query.ts.
  const subagentConfig = {
    ...config,
    model: modelFor('subagent', config),
    routing: {
      ...config.routing,
      main: modelFor('subagent', config),
    },
  }

  const result = await query({
    messages: [createUserMessage(params.prompt)],
    tools,
    config: subagentConfig,
    maxTurns: agent.maxTurns,
    systemPrompt: buildSubagentPrompt(tools, getCwd(), agent),
    mode: 'subagent',
  })

  return {
    finalText: result.lastAssistantText,
    stopReason: result.stopReason,
  }
}
