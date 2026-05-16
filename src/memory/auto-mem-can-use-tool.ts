import type { CanUseToolFn, Tool } from '../tool.js'

const AUTO_MEMORY_ALLOWED_TOOLS = new Set([
  'MemoryWrite',
  'MemoryRead',
  'Read',
  'Grep',
  'Glob',
])

const AUTO_DREAM_ALLOWED_TOOLS = new Set([
  'MemoryRead',
  'MemoryWriteAt',
  'MemoryMove',
  'MemoryDelete',
  'Read',
  'Grep',
  'Glob',
])

const READ_ONLY_BASH_HEADS = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'find',
  'grep',
  'stat',
  'file',
  'pwd',
  'echo',
  'which',
])

export function getBashHead(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean)
  while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
    tokens.shift()
  }
  const head = tokens[0]
  return head?.split('/').pop() ?? ''
}

export function isReadOnlyBash(input: unknown): boolean {
  if (!input || typeof input !== 'object') {
    return false
  }
  const command = (input as Record<string, unknown>).command
  if (typeof command !== 'string' || command.trim().length === 0) {
    return false
  }
  return READ_ONLY_BASH_HEADS.has(getBashHead(command))
}

export function createAutoMemCanUseTool(_memoryDir: string): CanUseToolFn {
  return async (tool: Tool, input: unknown) => {
    if (AUTO_MEMORY_ALLOWED_TOOLS.has(tool.name)) {
      return { behavior: 'allow' }
    }
    if (tool.name === 'Bash' && isReadOnlyBash(input)) {
      return { behavior: 'allow' }
    }
    if (tool.name === 'Bash') {
      return {
        behavior: 'deny',
        reason: 'Memory extraction subagent may only run read-only shell commands.',
      }
    }
    return {
      behavior: 'deny',
      reason: `Memory extraction subagent cannot use ${tool.name}.`,
    }
  }
}

export function createAutoDreamCanUseTool(_memoryDir: string): CanUseToolFn {
  return async (tool: Tool) => {
    if (AUTO_DREAM_ALLOWED_TOOLS.has(tool.name)) {
      return { behavior: 'allow' }
    }
    if (tool.name === 'Bash') {
      return {
        behavior: 'deny',
        reason: 'autoDream may not run shell commands.',
      }
    }
    return {
      behavior: 'deny',
      reason: `autoDream cannot use ${tool.name}.`,
    }
  }
}
