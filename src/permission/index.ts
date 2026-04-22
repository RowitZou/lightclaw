import type { Interface } from 'node:readline/promises'

import { getConfig } from '../config.js'
import {
  getAllPermissionRules,
  getPermissionMode,
} from '../state.js'
import type { Tool } from '../tool.js'
import { recordAudit } from './audit.js'
import { evaluatePermission } from './policy.js'
import { askUserApproval } from './prompt.js'
import type { PermissionContext, PermissionDecision } from './types.js'

export async function requestPermission(input: {
  tool: Tool
  toolInput: unknown
  ctx: PermissionContext
  rl?: Interface
}): Promise<PermissionDecision> {
  const { tool, toolInput, ctx, rl } = input
  const config = getConfig()
  const mode = getPermissionMode()
  const verdict = evaluatePermission({
    toolName: tool.name,
    toolSource: tool.source,
    mcpServer: tool.mcpServer,
    mcpToolName: tool.mcpToolName,
    input: toolInput,
    riskLevel: tool.riskLevel,
    mode,
    rules: getAllPermissionRules(),
  })

  let decision: PermissionDecision
  if (verdict.behavior === 'ask') {
    if (!ctx.isInteractive || ctx.isSubagent || !rl) {
      decision = {
        behavior: 'deny',
        reason: [
          `Permission denied: ${tool.name} requires confirmation in ${mode} mode.`,
          ctx.isSubagent ? 'Subagents are non-interactive.' : 'No interactive prompt is available.',
          'Add an explicit allow rule or switch permission mode before retrying.',
        ].join(' '),
      }
    } else {
      decision = await askUserApproval({
        rl,
        toolName: tool.name,
        riskLevel: tool.riskLevel,
        inputPreview: previewInput(tool.name, toolInput),
      })
    }
  } else {
    decision = verdict
  }

  recordAudit({
    path: config.permissionAuditLog,
    toolName: tool.name,
    mcpServer: tool.mcpServer,
    decision,
    mode,
    isSubagent: ctx.isSubagent,
  })

  return decision
}

function previewInput(toolName: string, input: unknown): string {
  const record = input as Record<string, unknown>
  if (toolName === 'Bash' && typeof record.command === 'string') {
    return `Command: ${truncate(record.command, 200)}`
  }

  if (toolName === 'WebFetch' && typeof record.url === 'string') {
    return `URL: ${record.url}`
  }

  if (
    (toolName === 'Read' || toolName === 'Write' || toolName === 'Edit') &&
    typeof record.file_path === 'string'
  ) {
    return `Path: ${record.file_path}`
  }

  if (toolName === 'AgentTool' && typeof record.subagent_type === 'string') {
    return `Subagent: ${record.subagent_type}`
  }

  if (toolName.startsWith('mcp__')) {
    return `MCP input: ${truncate(JSON.stringify(record), 200)}`
  }

  try {
    return `Input: ${truncate(JSON.stringify(record), 200)}`
  } catch {
    return 'Input: (unserializable)'
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value
}
