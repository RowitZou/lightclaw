import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import type { Tool } from '../tool.js'
import type { UserToolResultBlock } from '../types.js'
import { buildMcpToolName } from './normalization.js'
import { callMcpTool } from './client.js'
import type { McpConnection, McpToolDescriptor } from './types.js'

export function mcpToolToLightClawTool(input: {
  connection: Extract<McpConnection, { type: 'connected' }>
  descriptor: McpToolDescriptor
  callTimeoutMs: number
  maxOutputBytes: number
}): Tool<unknown, string> {
  const { connection, descriptor } = input
  const server = connection.config.normalizedName
  const fullName = buildMcpToolName(server, descriptor.name)

  return {
    name: fullName,
    description:
      descriptor.description ??
      `MCP tool ${descriptor.name} from server ${server}.`,
    source: 'mcp',
    mcpServer: server,
    mcpToolName: descriptor.name,
    inputJSONSchema: descriptor.inputSchema,
    riskLevel: 'write',
    async call(rawInput, context) {
      const result = await callMcpTool({
        client: connection.client,
        name: descriptor.name,
        arguments: rawInput,
        signal: context.abortSignal,
        timeoutMs: input.callTimeoutMs,
      })

      return {
        output: stringifyCallToolResult(result, input.maxOutputBytes),
        isError: result.isError,
      }
    },
    formatResult(output, toolUseId, isError): UserToolResultBlock {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: output,
        ...(isError ? { is_error: true } : {}),
      }
    },
  }
}

export function stringifyCallToolResult(
  result: CallToolResult,
  maxOutputBytes: number,
): string {
  const content = 'content' in result && Array.isArray(result.content)
    ? result.content
    : []
  const blocks = content.map(block => {
    switch (block.type) {
      case 'text':
        return block.text
      case 'image':
        return `[image: ${block.mimeType}, ${base64Bytes(block.data)} bytes, base64 elided]`
      case 'audio':
        return `[audio: ${block.mimeType}, ${base64Bytes(block.data)} bytes]`
      case 'resource': {
        const resource = block.resource
        const mimeType = resource.mimeType ?? 'unknown'
        const details = [`[resource: ${resource.uri}, ${mimeType}]`]
        if ('text' in resource && typeof resource.text === 'string') {
          details.push(resource.text.slice(0, 500))
        }
        return details.join('\n')
      }
      case 'resource_link':
        return `[resource: ${block.uri}, ${block.mimeType ?? 'unknown'}]`
      default:
        return JSON.stringify(block)
    }
  })

  const text = blocks.join('\n\n---\n\n')
  if (text.length <= maxOutputBytes) {
    return text
  }

  return `${text.slice(0, maxOutputBytes)}\n\n[output truncated: ${text.length} chars total]`
}

function base64Bytes(data: string): number {
  return Math.ceil((data.length * 3) / 4)
}
