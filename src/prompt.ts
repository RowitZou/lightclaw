import { platform } from 'node:process'

import { loadMemoryIndex } from './memory/auto-memory.js'
import { loadProjectMemory } from './memory/discovery.js'
import { getMemoryDir } from './state.js'
import {
  listRegisteredSkills,
  refreshSkillRegistry,
} from './skill/registry.js'
import type { Tool } from './tool.js'
import { toolToAPISchema } from './tool.js'

type PromptOptions = {
  autoMemory: boolean
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