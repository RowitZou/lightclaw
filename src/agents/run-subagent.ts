import { getConfig } from '../config.js'
import { createUserMessage } from '../messages.js'
import { buildSubagentPrompt } from '../prompt.js'
import { getProvider, modelFor } from '../provider/index.js'
import { getRuntime } from '../state.js'
import type { CanUseToolFn, Tool } from '../tool.js'
import { getAllTools, getEnabledTools } from '../tools.js'
import type { AgentType } from './types.js'
import { getAgent } from './registry.js'
import {
  createCacheSafeParams,
  getLastCacheSafeParams,
} from './cache-safe-params.js'
import { runForkedAgent } from './forked-agent.js'

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

export function createSubagentCanUseTool(
  definitionTools: string[] | ['*'],
): CanUseToolFn {
  const allowedTools = definitionTools.includes('*')
    ? null
    : new Set(definitionTools)
  return async tool => {
    if (BLOCKED_SUBAGENT_TOOLS.has(tool.name)) {
      return {
        behavior: 'deny',
        reason: `${tool.name} is not available to subagents.`,
      }
    }
    if (allowedTools && !allowedTools.has(tool.name)) {
      return {
        behavior: 'deny',
        reason: `${tool.name} is not in this subagent's allowed tool set.`,
      }
    }
    return { behavior: 'allow' }
  }
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
  const existingCache = getLastCacheSafeParams()
  const cacheSafeParams = createCacheSafeParams({
    systemPrompt: buildSubagentPrompt(tools, getRuntime().workspaceRoot, agent),
    tools,
    messages: existingCache?.forkContextMessages ?? [],
    config: subagentConfig,
  })

  const result = await runForkedAgent({
    promptMessages: [createUserMessage(params.prompt)],
    cacheSafeParams,
    canUseTool: createSubagentCanUseTool(agent.tools),
    maxTurns: agent.maxTurns,
    label: `subagent_${params.agentType}`,
    signal: params.signal,
  })

  return {
    finalText: result.finalText,
    stopReason: result.stopReason,
  }
}
