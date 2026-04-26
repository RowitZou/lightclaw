import chalk from 'chalk'

import { parsePermissionMode, type LightClawConfig } from '../config.js'
import { getHookSummary, reloadHooks } from '../hooks/index.js'
import { scanMemoryFiles } from '../memory/auto-memory.js'
import { getMcpRegistrySnapshot, reloadMcp } from '../mcp/index.js'
import { formatRule, parseRule } from '../permission/rules.js'
import { getProvider } from '../provider/index.js'
import { compactConversation } from '../session/compact.js'
import {
  formatSessionList,
  listSessions,
} from '../session/listing.js'
import { rewriteTranscript } from '../session/storage.js'
import {
  buildRegisteredSkillInvocation,
  listRegisteredSkills,
  refreshSkillRegistry,
} from '../skill/registry.js'
import {
  addSessionRule,
  clearSessionRules,
  getAllPermissionRules,
  getCompactionCount,
  getCurrentUserId,
  getCwd,
  getLastExtractedAt,
  getMemoryDir,
  getModel,
  getPermissionMode,
  getResumedFrom,
  getTodos,
  incrementCompactionCount,
  setPermissionMode,
} from '../state.js'
import { formatTodosForPrompt } from '../todos/store.js'
import { estimateMessagesTokens } from '../token-estimate.js'
import { getAllTools, getEnabledTools } from '../tools.js'
import type { Message } from '../types.js'

import type { ReplCommand, ReplContext } from './registry.js'
import { ReplCommandRegistry } from './registry.js'

export function createBuiltinReplRegistry(): ReplCommandRegistry {
  const registry = new ReplCommandRegistry()
  for (const command of BUILTIN_COMMANDS) {
    registry.register(command)
  }
  return registry
}

const BUILTIN_COMMANDS: ReplCommand[] = [
  {
    name: '/exit',
    usage: '/exit',
    description: 'Quit the REPL',
    async handler(): Promise<'exit'> {
      return 'exit'
    },
  },

  {
    name: '/whoami',
    usage: '/whoami',
    description: 'Show active LightClaw identity',
    async handler(_args, ctx) {
      ctx.output.write(chalk.gray(`user: ${getCurrentUserId() ?? '(none)'}\n`))
    },
  },

  {
    name: '/identity',
    usage: '/identity',
    description: 'Hint for identity CLI management',
    async handler(_args, ctx) {
      ctx.output.write(chalk.gray('Use `lightclaw identity list|pending|approve|reject|link|unlink|remove` in a terminal.\n'))
    },
  },

  {
    name: '/status',
    usage: '/status',
    description: 'Show session / cwd / model / permissions / MCP / hooks summary',
    async handler(_args, ctx) {
      ctx.output.write(chalk.gray(formatStatus(ctx)))
    },
  },

  {
    name: '/sessions',
    usage: '/sessions',
    description: 'List saved sessions for the active LightClaw user',
    async handler(_args, ctx) {
      const sessions = await listSessions(getCurrentUserId())
      ctx.output.write(chalk.gray(formatSessionList(sessions)))
    },
  },

  {
    name: '/compact',
    usage: '/compact',
    description: 'Compact transcript now (LLM summary)',
    async handler(_args, ctx) {
      await runManualCompact(ctx)
    },
  },

  {
    name: '/skills',
    usage: '/skills',
    description: 'List discovered skills',
    async handler(_args, ctx) {
      await refreshSkillRegistry(getCwd())
      ctx.output.write(chalk.gray(formatSkillList()))
    },
  },

  {
    name: '/skill',
    usage: '/skill <name> [args]',
    description: 'Invoke a skill as a prompt',
    async handler(args, ctx) {
      if (args.length === 0) {
        ctx.output.write(chalk.red('error> Usage: /skill <name> [args]\n'))
        return
      }
      const [name, ...rest] = args.split(/\s+/)
      await refreshSkillRegistry(getCwd())
      const skillPrompt = await buildRegisteredSkillInvocation(name, rest.join(' '))
      if (!skillPrompt) {
        ctx.output.write(chalk.red(`error> Unknown skill: ${name}\n`))
        return
      }
      ctx.output.write(chalk.cyan(`[skill] ${name}\n`))
      await ctx.runPrompt(skillPrompt)
    },
  },

  {
    name: '/memory',
    usage: '/memory',
    description: 'List memory files under the active memory dir',
    async handler(_args, ctx) {
      ctx.output.write(chalk.gray(await formatMemoryList()))
    },
  },

  {
    name: '/todos',
    usage: '/todos',
    description: 'Show current todos',
    async handler(_args, ctx) {
      const todos = getTodos()
      ctx.output.write(
        chalk.gray(
          todos.length > 0 ? `${formatTodosForPrompt(todos)}\n` : 'No todos.\n',
        ),
      )
    },
  },

  {
    name: '/mcp',
    usage: '/mcp [reload]',
    description: 'Show MCP server status or reload all connections',
    async handler(args, ctx) {
      if (args.length === 0) {
        ctx.output.write(chalk.gray(formatMcpStatus()))
        return
      }
      if (args === 'reload') {
        ctx.output.write(chalk.yellow('[mcp] Reloading servers...\n'))
        await reloadMcp()
        ctx.setActiveTools(getEnabledTools(getProvider(ctx.config), getAllTools()))
        ctx.output.write(chalk.green(`[mcp] ${formatMcpSummary()}\n`))
        return
      }
      ctx.output.write(chalk.red('error> Usage: /mcp [reload]\n'))
    },
  },

  {
    name: '/hooks',
    usage: '/hooks [reload]',
    description: 'Show loaded hooks or reload them from disk',
    async handler(args, ctx) {
      if (args.length === 0) {
        ctx.output.write(chalk.gray(formatHookList()))
        return
      }
      if (args === 'reload') {
        ctx.output.write(chalk.yellow('[hooks] Reloading hooks...\n'))
        await reloadHooks(ctx.config)
        ctx.output.write(chalk.green(`[hooks] ${getHookSummary().length} loaded\n`))
        return
      }
      ctx.output.write(chalk.red('error> Usage: /hooks [reload]\n'))
    },
  },

  {
    name: '/permissions',
    usage: '/permissions [clear]',
    description: 'Show permission rules or clear the session-scoped rules',
    async handler(args, ctx) {
      if (args.length === 0) {
        ctx.output.write(chalk.gray(formatPermissions()))
        return
      }
      if (args === 'clear') {
        clearSessionRules()
        ctx.output.write(chalk.gray('Session permission rules cleared.\n'))
        await ctx.persistMeta(ctx.messages.length)
        return
      }
      ctx.output.write(chalk.red('error> Usage: /permissions [clear]\n'))
    },
  },

  {
    name: '/mode',
    usage: '/mode <default|acceptEdits|bypassPermissions|plan>',
    description: 'Switch permission mode',
    async handler(args, ctx) {
      const mode = parsePermissionMode(args)
      if (!mode) {
        ctx.output.write(
          chalk.red('error> Usage: /mode default|acceptEdits|bypassPermissions|plan\n'),
        )
        return
      }
      setPermissionMode(mode)
      ctx.output.write(chalk.green(`Permission mode: ${mode}\n`))
      await ctx.persistMeta(ctx.messages.length)
    },
  },

  {
    name: '/allow',
    usage: '/allow <rule>',
    description: 'Add a session-scoped allow rule',
    async handler(args, ctx) {
      if (!addReplRule('allow', args, ctx.output)) {
        ctx.output.write(chalk.red('error> Usage: /allow ToolName(optional:*)\n'))
      }
    },
  },

  {
    name: '/deny',
    usage: '/deny <rule>',
    description: 'Add a session-scoped deny rule',
    async handler(args, ctx) {
      if (!addReplRule('deny', args, ctx.output)) {
        ctx.output.write(chalk.red('error> Usage: /deny ToolName(optional:*)\n'))
      }
    },
  },
]

// ---------- formatters & helpers (moved from repl.ts) ----------

function formatStatus(ctx: ReplContext): string {
  const lines = [
    `session: ${ctx.sessionId}`,
    `cwd: ${getCwd()}`,
    `model: ${getModel()}`,
    `provider: ${ctx.config.provider}`,
    `routing: ${formatRouting(ctx.config)}`,
    `permission mode: ${getPermissionMode()}`,
    `user: ${getCurrentUserId() ?? '(none)'}`,
    `memory dir: ${getMemoryDir()}`,
    `messages: ${ctx.messages.length}`,
    `estimated tokens: ${estimateMessagesTokens(ctx.messages)}`,
    `compactions: ${getCompactionCount()}`,
  ]
  if (getResumedFrom()) {
    lines.push(`resumed from: ${getResumedFrom()}`)
  }
  if (getLastExtractedAt() > 0) {
    lines.push(`last memory extract: ${new Date(getLastExtractedAt()).toISOString()}`)
  }
  lines.push(`skills: ${listRegisteredSkills().length}`)
  lines.push(`todos: ${getTodos().length}`)
  lines.push(`MCP: ${formatMcpSummary()}`)
  lines.push(`hooks: ${getHookSummary().length}`)
  return `${lines.join('\n')}\n`
}

function formatRouting(config: LightClawConfig): string {
  return [
    `main=${config.routing.main}`,
    `compact=${config.routing.compact ?? config.routing.main}`,
    `extract=${config.routing.extract ?? config.routing.main}`,
    `subagent=${config.routing.subagent ?? config.routing.main}`,
    `webSearch=${config.routing.webSearch ?? config.routing.main}`,
  ].join(', ')
}

function formatMcpSummary(): string {
  const snapshot = getMcpRegistrySnapshot()
  if (!snapshot.enabled) {
    return 'disabled'
  }
  return `${snapshot.connectedCount}/${snapshot.totalCount} servers, ${snapshot.totalToolCount} tools`
}

function formatMcpStatus(): string {
  const snapshot = getMcpRegistrySnapshot()
  if (!snapshot.enabled) {
    return 'MCP disabled.\n'
  }
  if (snapshot.connections.length === 0) {
    return 'No MCP servers configured.\n'
  }
  const lines = [
    `MCP: ${formatMcpSummary()}${snapshot.reloading ? ' (reloading)' : ''}`,
  ]
  for (const connection of snapshot.connections) {
    const name = connection.config.normalizedName.padEnd(18, ' ')
    const transport = (connection.config.type ?? 'stdio').padEnd(6, ' ')
    if (connection.type === 'connected') {
      const toolNames = connection.tools.slice(0, 8).map(tool => tool.name)
      const suffix =
        connection.tools.length > toolNames.length
          ? `, ... (${connection.tools.length} total)`
          : ''
      lines.push(
        `${name} connected  ${transport} tools=${connection.tools.length} ${toolNames.join(', ')}${suffix}`,
      )
      continue
    }
    if (connection.type === 'disabled') {
      lines.push(`${name} disabled   ${transport}`)
      continue
    }
    lines.push(`${name} failed     ${transport} ${connection.error}`)
  }
  return `${lines.join('\n')}\n`
}

function formatHookList(): string {
  const hooks = getHookSummary()
  if (hooks.length === 0) {
    return 'No hooks loaded.\n'
  }
  const lines = ['Hooks:']
  for (const hook of hooks) {
    lines.push(`${hook.name.padEnd(16, ' ')} ${hook.source.padEnd(7, ' ')} ${hook.file}`)
  }
  return `${lines.join('\n')}\n`
}

function formatPermissions(): string {
  const lines = [
    `Permission mode: ${getPermissionMode()}`,
    `Rules: ${getAllPermissionRules().length}`,
  ]
  const allRules = getAllPermissionRules()
  const groups = ['cliArg', 'session', 'local', 'project', 'user', 'builtin'] as const

  for (const source of groups) {
    const rules = allRules.filter(rule => rule.source === source)
    lines.push('', `[${source}]`)
    if (rules.length === 0) {
      lines.push('  (none)')
      continue
    }
    const sortedRules = [...rules].sort((a, b) => {
      if (a.behavior !== b.behavior) {
        return a.behavior === 'deny' ? -1 : 1
      }
      return a.source.localeCompare(b.source)
    })
    for (const rule of sortedRules) {
      lines.push(`  ${rule.behavior.padEnd(5, ' ')} ${rule.source.padEnd(7, ' ')} ${formatRule(rule.value)}`)
    }
  }
  return `${lines.join('\n')}\n`
}

function formatSkillList(): string {
  const skills = listRegisteredSkills()
  if (skills.length === 0) {
    return 'No skills found.\n'
  }
  return `${skills
    .map(skill => {
      const source = skill.source.padEnd(7, ' ')
      const whenToUse = skill.whenToUse ?? 'n/a'
      return `${skill.name}  [${source}]  ${skill.description}  (${whenToUse})`
    })
    .join('\n')}\n`
}

async function formatMemoryList(): Promise<string> {
  const entries = await scanMemoryFiles(getMemoryDir())
  if (entries.length === 0) {
    return 'No memory files found.\n'
  }
  return `${entries
    .map(entry => `[${entry.type}] ${entry.filename}: ${entry.description}`)
    .join('\n')}\n`
}

function addReplRule(
  behavior: 'allow' | 'deny',
  rawRule: string,
  output: ReplContext['output'],
): boolean {
  if (rawRule.length === 0) {
    return false
  }
  try {
    addSessionRule({
      source: 'session',
      behavior,
      value: parseRule(rawRule),
    })
    output.write(
      behavior === 'allow'
        ? chalk.green(`+ allow ${rawRule}\n`)
        : chalk.red(`+ deny ${rawRule}\n`),
    )
    return true
  } catch {
    return false
  }
}

async function runManualCompact(ctx: ReplContext): Promise<void> {
  ctx.output.write(chalk.yellow('[compact] Compacting context...\n'))
  try {
    const result = await compactConversation({
      messages: ctx.messages,
      keepRecent: ctx.config.compactKeepRecent,
      config: ctx.config,
    })
    if (result.removedCount === 0) {
      ctx.output.write(chalk.gray('[compact] Not enough history to compact.\n'))
      return
    }
    incrementCompactionCount()
    replaceMessages(ctx.messages, result.messages)
    await rewriteTranscript(ctx.sessionId, ctx.messages)
    await ctx.persistMeta(ctx.messages.length)
    ctx.output.write(
      chalk.green(
        `[compact] Removed ${result.removedCount} messages, summary ~${result.summaryTokens} tokens\n`,
      ),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.output.write(chalk.red(`[compact] ${message}\n`))
  }
}

function replaceMessages(target: Message[], next: Message[]): void {
  target.splice(0, target.length, ...next)
}
