import { platform } from 'node:process'

import type { Tool } from './tool.js'
import { toolToAPISchema } from './tool.js'

export function buildSystemPrompt(tools: Tool[], cwd: string): string {
  const toolDescriptions = tools
    .map(tool => {
      const schema = toolToAPISchema(tool)
      return [
        `Tool: ${tool.name}`,
        `Description: ${tool.description}`,
        `Input schema: ${JSON.stringify(schema.input_schema)}`,
      ].join('\n')
    })
    .join('\n\n')

  return [
    'You are LightClaw, an interactive AI agent running in the user\'s terminal.',
    'You help users with coding tasks by reading, writing, and editing files, running shell commands, and searching codebases.',
    '',
    `Working directory: ${cwd}`,
    `Current date: ${new Date().toISOString()}`,
    `Platform: ${platform}`,
    '',
    'Tool usage rules:',
    '- Prefer direct answers when no tool is needed.',
    '- Use tools when the answer depends on filesystem or shell state.',
    '- When editing files, be precise and avoid unrelated changes.',
    '- If a tool fails, explain the failure and recover with a narrower step.',
    '',
    'Available tools:',
    toolDescriptions,
  ].join('\n')
}