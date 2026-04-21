import { platform } from 'node:process'

import type { AgentDefinition } from './agents/types.js'
import type { LightClawConfig } from './config.js'
import { loadMemoryIndex } from './memory/auto-memory.js'
import { loadProjectMemory } from './memory/discovery.js'
import { modelFor } from './provider/index.js'
import { getMemoryDir, getTodos } from './state.js'
import {
  listRegisteredSkills,
  refreshSkillRegistry,
} from './skill/registry.js'
import type { Tool } from './tool.js'
import { toolToAPISchema } from './tool.js'
import { formatTodosForPrompt } from './todos/store.js'

type PromptOptions = {
  autoMemory: boolean
  config: LightClawConfig
}

function formatSkillsSection(): string {
  const skills = listRegisteredSkills()
  if (skills.length === 0) {
    return 'None.'
  }

  return skills
    .map(skill => {
      const whenToUse = skill.whenToUse ?? 'Use when the task matches the skill.'
      return `- ${skill.name}: ${skill.description} | When to use: ${whenToUse}`
    })
    .join('\n')
}

export async function buildSystemPrompt(
  tools: Tool[],
  cwd: string,
  options: PromptOptions,
): Promise<string> {
  await refreshSkillRegistry(cwd)
  const [projectMemory, autoMemoryIndex] = await Promise.all([
    loadProjectMemory(cwd),
    options.autoMemory ? loadMemoryIndex(getMemoryDir()) : Promise.resolve(''),
  ])

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

  const sections = [
    'You are LightClaw, an interactive AI agent running in the user\'s terminal.',
    'You help users with coding tasks by reading, writing, and editing files, running shell commands, and searching codebases.',
    '',
    `Working directory: ${cwd}`,
    `Current date: ${new Date().toISOString()}`,
    `Platform: ${platform}`,
    `Provider: ${options.config.provider}`,
    `Model: ${modelFor('main', options.config)}`,
  ]

  if (projectMemory.trim().length > 0) {
    sections.push('', '## Project Memory', projectMemory)
  }

  if (options.autoMemory && autoMemoryIndex.trim().length > 0) {
    sections.push('', '## Auto Memory Index', autoMemoryIndex)
  }

  sections.push(
    '',
    '## Available Skills',
    formatSkillsSection(),
    'To use a skill, call the UseSkill tool with the skill name.',
    'To save durable notes for later sessions, use the MemoryWrite tool.',
  )

  const todos = getTodos()
  if (todos.length > 0) {
    sections.push(
      '',
      '## Current Todo List',
      formatTodosForPrompt(todos),
      'Use TodoWrite to keep this list current. Keep at most one item in_progress.',
    )
  }

  sections.push(
    '',
    'Tool usage rules:',
    '- Prefer direct answers when no tool is needed.',
    '- Use tools when the answer depends on filesystem or shell state.',
    '- When editing files, be precise and avoid unrelated changes.',
    '- If a tool fails, explain the failure and recover with a narrower step.',
    '- Memory may be stale; verify remembered details before acting on them.',
    '',
    'Available tools:',
    toolDescriptions,
  )

  return sections.join('\n')
}

export function buildSubagentPrompt(
  tools: Tool[],
  cwd: string,
  agent: AgentDefinition,
): string {
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
    'You are LightClaw running as an isolated subagent.',
    `Working directory: ${cwd}`,
    `Current date: ${new Date().toISOString()}`,
    `Platform: ${platform}`,
    '',
    agent.systemPrompt,
    '',
    'Tool usage rules:',
    '- Prefer direct answers when no tool is needed.',
    '- Use tools when the answer depends on filesystem or shell state.',
    '- Report concise findings to the parent agent.',
    '',
    'Available tools:',
    toolDescriptions,
  ].join('\n')
}
