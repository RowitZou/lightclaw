import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { suggestMcpRules } from '../permission/suggestions.js'
import type { Tool } from '../tool.js'
import type { ToolResultContentBlock, UserToolResultBlock } from '../types.js'
import { buildMcpToolName } from './normalization.js'
import { callMcpTool } from './client.js'
import type { McpConnection, McpToolDescriptor } from './types.js'

export type McpToolOutput =
  | string
  | {
      kind: 'visual'
      toolResultContent: ToolResultContentBlock[]
    }

export function mcpToolToLightClawTool(input: {
  connection: Extract<McpConnection, { type: 'connected' }>
  descriptor: McpToolDescriptor
  callTimeoutMs: number
  maxOutputBytes: number
}): Tool<unknown, McpToolOutput> {
  const { connection, descriptor } = input
  const server = connection.config.normalizedName
  const fullName = buildMcpToolName(server, descriptor.name)

  return {
    name: fullName,
    description:
      descriptor.description ??
      `MCP tool ${descriptor.name} from server ${server}.`,
    source: 'mcp',
    domain: 'host',
    mcpServer: server,
    mcpToolName: descriptor.name,
    inputJSONSchema: descriptor.inputSchema,
    riskLevel: 'write',
    suggestPermissionRules: () => suggestMcpRules(server, descriptor.name),
    async call(rawInput, context) {
      const result = await callMcpTool({
        client: connection.client,
        name: descriptor.name,
        arguments: rawInput,
        signal: context.abortSignal,
        timeoutMs: input.callTimeoutMs,
      })

      return {
        output: convertCallToolResult(result, input.maxOutputBytes),
        isError: result.isError,
      }
    },
    formatResult(output, toolUseId, isError): UserToolResultBlock {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: typeof output === 'string' ? output : output.toolResultContent,
        ...(isError ? { is_error: true } : {}),
      }
    },
  }
}

export function convertCallToolResult(
  result: CallToolResult,
  maxOutputBytes: number,
): McpToolOutput {
  const content = 'content' in result && Array.isArray(result.content)
    ? result.content
    : []
  const hasImage = content.some(block => block.type === 'image')
  if (!hasImage) {
    return stringifyCallToolResult(result, maxOutputBytes)
  }

  // Combined byte budget for text AND image bytes — image base64 strings
  // can be very large; without this cap a buggy or malicious MCP server
  // returning gigabytes of image data would balloon the transcript and
  // the wire request. Once exceeded, remaining blocks degrade to text
  // placeholders (same shape as stringifyCallToolResult).
  const blocks: ToolResultContentBlock[] = []
  let usedBytes = 0
  for (const block of content) {
    if (block.type === 'text') {
      const text = truncateTextBlock(block.text, maxOutputBytes - usedBytes)
      usedBytes += Buffer.byteLength(text, 'utf8')
      if (text.length > 0) blocks.push({ type: 'text', text })
      continue
    }
    if (block.type === 'image') {
      const imgBytes = base64Bytes(block.data)
      if (usedBytes + imgBytes > maxOutputBytes) {
        const text = `[image: ${block.mimeType}, ${imgBytes} bytes, dropped: exceeds tool output cap ${maxOutputBytes} bytes]`
        usedBytes += Buffer.byteLength(text, 'utf8')
        blocks.push({ type: 'text', text })
        continue
      }
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          mediaType: block.mimeType,
          data: block.data,
        },
      })
      usedBytes += imgBytes
      continue
    }
    const text = stringifyCallToolResult({ ...result, content: [block] }, maxOutputBytes - usedBytes)
    usedBytes += Buffer.byteLength(text, 'utf8')
    if (text.length > 0) blocks.push({ type: 'text', text })
  }
  return {
    kind: 'visual',
    toolResultContent: blocks.length > 0 ? blocks : [{ type: 'text', text: '[MCP tool returned no supported content]' }],
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
  const byteLength = Buffer.byteLength(text, 'utf8')
  if (byteLength <= maxOutputBytes) {
    return text
  }

  const truncated = Buffer.from(text, 'utf8')
    .subarray(0, maxOutputBytes)
    .toString('utf8')
  return `${truncated}\n\n[output truncated: ${byteLength} bytes total]`
}

function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor((data.length * 3) / 4) - padding
}

function truncateTextBlock(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  const byteLength = Buffer.byteLength(text, 'utf8')
  if (byteLength <= maxBytes) return text
  return `${Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')}\n\n[output truncated: ${byteLength} bytes total]`
}
