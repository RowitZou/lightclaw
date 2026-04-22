import { platform } from 'node:process'

import type { AgentDefinition } from './agents/types.js'
import type { LightClawConfig } from './config.js'
import { loadMemoryIndex } from './memory/auto-memory.js'
import { loadProjectMemory } from './memory/discovery.js'
import { getMcpRegistrySnapshot } from './mcp/index.js'
import { modelFor } from './provider/index.js'
import {
  getAllPermissionRules,
  getMemoryDir,
  getPermissionMode,
} from './state.js'
import {
  listRegisteredSkills,
  refreshSkillRegistry,
} from './skill/registry.js'
import type { Tool } from './tool.js'
import { toolToAPISchema } from './tool.js'
import { formatTodosForPrompt } from './todos/store.js'
import type { TodoItem } from './types.js'
import type { PermissionMode } from './permission/types.js'

type PromptOptions = {
  autoMemory: boolean
  config: LightClawConfig
}

export type SystemPromptTemplate = {
  preTodos: string
  postTodos: string
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

function formatTodoSection(todos: TodoItem[]): string {
  if (todos.length === 0) {
    return ''
  }

  return [
    '## Current Todo List',
    formatTodosForPrompt(todos),
    'Use TodoWrite to keep this list current. Keep at most one item in_progress.',
  ].join('\n')
}

const MODE_BLURBS: Record<PermissionMode, string> = {
  default:
    'Read/search tools run freely. Write, edit, execute, network fetch, and subagent tools require confirmation; in non-interactive mode they are denied.',
  acceptEdits:
    'Read, search, write, and edit tools run freely. Execute, network fetch, and subagent tools still require confirmation.',
  bypassPermissions: '',
  plan:
    'Read/search tools only. Write, edit, execute, network fetch, and subagent tools are denied unless an explicit allow rule matches.',
}

function formatPermissionSection(isSubagent = false): string {
  const mode = getPermissionMode()
  if (mode === 'bypassPermissions') {
    return ''
  }

  const rules = getAllPermissionRules()
  const allowCount = rules.filter(rule => rule.behavior === 'allow').length
  const denyCount = rules.filter(rule => rule.behavior === 'deny').length
  const lines = [
    '## Permission Mode',
    `Current mode: ${mode}`,
    isSubagent
      ? 'Subagent permission checks are non-interactive; confirmation requests are denied automatically.'
      : `Rule summary: ${allowCount} allow, ${denyCount} deny across all sources.`,
    `In this mode: ${MODE_BLURBS[mode]}`,
    'If a tool returns "Permission denied:", do not retry the same call. Choose a read-only alternative, explain the limitation, or ask the user to add an explicit allow rule/switch mode.',
  ]

  return lines.join('\n')
}

function formatMcpSection(): string {
  const snapshot = getMcpRegistrySnapshot()
  if (!snapshot.enabled || snapshot.connections.length === 0) {
    return ''
  }

  const lines = ['## MCP Servers']
  const listedConnections = snapshot.connections.slice(0, 5)
  for (const connection of listedConnections) {
    const name = connection.config.normalizedName
    if (connection.type === 'connected') {
      const toolNames = connection.tools.slice(0, 8).map(tool => tool.name)
      const suffix =
        connection.tools.length > toolNames.length
          ? `, ... (${connection.tools.length} tools total)`
          : ''
      lines.push(
        `- ${name} (connected, ${connection.tools.length} tools): ${toolNames.join(', ')}${suffix}`,
      )
      continue
    }

    if (connection.type === 'disabled') {
      lines.push(`- ${name} (disabled)`)
      continue
    }

    lines.push(`- ${name} (failed: ${connection.error})`)
  }

  if (snapshot.connections.length > listedConnections.length) {
    lines.push(`- ${snapshot.connections.length - listedConnections.length} more server(s) not shown.`)
  }

  lines.push(
    'MCP tool names are namespaced as mcp__<server>__<tool>. Treat them like any other tool; permission rules with MCP(<server>:*) apply.',
  )

  return lines.join('\n')
}

export async function buildSystemPromptTemplate(
  tools: Tool[],
  cwd: string,
  options: PromptOptions,
): Promise<SystemPromptTemplate> {
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

  const preTodoSections: string[] = [
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
    preTodoSections.push('', '## Project Memory', projectMemory)
  }

  if (options.autoMemory && autoMemoryIndex.trim().length > 0) {
    preTodoSections.push('', '## Auto Memory Index', autoMemoryIndex)
  }

  preTodoSections.push(
    '',
    '## Available Skills',
    formatSkillsSection(),
    'To use a skill, call the UseSkill tool with the skill name.',
    'To save durable notes for later sessions, use the MemoryWrite tool.',
  )

  const permissionSection = formatPermissionSection()
  if (permissionSection) {
    preTodoSections.push('', permissionSection)
  }

  const mcpSection = formatMcpSection()
  if (mcpSection) {
    preTodoSections.push('', mcpSection)
  }

  const postTodoSections: string[] = [
    'Tool usage rules:',
    '- Prefer direct answers when no tool is needed.',
    '- Use tools when the answer depends on filesystem or shell state.',
    '- When editing files, be precise and avoid unrelated changes.',
    '- If a tool fails, explain the failure and recover with a narrower step.',
    '- Memory may be stale; verify remembered details before acting on them.',
    '',
    'Available tools:',
    toolDescriptions,
  ]

  return {
    preTodos: preTodoSections.join('\n'),
    postTodos: postTodoSections.join('\n'),
  }
}

export function renderSystemPrompt(
  template: SystemPromptTemplate,
  todos: TodoItem[],
): string {
  const todoSection = formatTodoSection(todos)
  const middle = todoSection ? `\n\n${todoSection}` : ''
  return `${template.preTodos}${middle}\n\n${template.postTodos}`
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

  const permissionSection = formatPermissionSection(true)
  const sections: string[] = [
    'You are LightClaw running as an isolated subagent.',
    `Working directory: ${cwd}`,
    `Current date: ${new Date().toISOString()}`,
    `Platform: ${platform}`,
    '',
    agent.systemPrompt,
  ]

  if (permissionSection) {
    sections.push('', permissionSection)
  }

  sections.push(
    '',
    'Tool usage rules:',
    '- Prefer direct answers when no tool is needed.',
    '- Use tools when the answer depends on filesystem or shell state.',
    '- Report concise findings to the parent agent.',
    '',
    'Available tools:',
    toolDescriptions,
  )

  return sections.join('\n')
}
