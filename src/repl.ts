import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

import chalk from 'chalk'

import { scanMemoryFiles } from './memory/auto-memory.js'
import { parsePermissionMode, type LightClawConfig } from './config.js'
import { beginQuery } from './init.js'
import { createUserMessage, getLastUuid } from './messages.js'
import { cleanupMcp, getMcpRegistrySnapshot, reloadMcp } from './mcp/index.js'
import { formatRule, parseRule } from './permission/rules.js'
import { getProvider } from './provider/index.js'
import { query } from './query.js'
import { compactConversation } from './session/compact.js'
import {
  formatSessionList,
  listSessions,
} from './session/listing.js'
import {
  appendMessage,
  loadMeta,
  loadTranscript,
  rewriteTranscript,
  saveMeta,
  touchMeta,
} from './session/storage.js'
import {
  buildRegisteredSkillInvocation,
  listRegisteredSkills,
  refreshSkillRegistry,
} from './skill/registry.js'
import {
  awaitBackgroundTasks,
  getCompactionCount,
  getCwd,
  getLastExtractedAt,
  getMemoryDir,
  getModel,
  getPermissionMode,
  getResumedFrom,
  getSessionId,
  getAllPermissionRules,
  getTodos,
  getUsageTotals,
  incrementCompactionCount,
  addSessionRule,
  clearSessionRules,
  setPermissionMode,
} from './state.js'
import { formatTodosForPrompt } from './todos/store.js'
import { estimateMessagesTokens } from './token-estimate.js'
import { getAllTools, getEnabledTools } from './tools.js'
import type { Message, SessionMeta } from './types.js'
import type { Tool } from './tool.js'

type ReplParams = {
  config: LightClawConfig
  tools: Tool[]
  initialPrompt?: string
  resumeSessionId?: string
}

export async function startRepl(params: ReplParams): Promise<void> {
  const messages: Message[] = []
  const sessionId = getSessionId()
  let createdAt = Date.now()
  let activeTools = params.tools

  if (params.resumeSessionId) {
    const loadedMessages = await loadTranscript(params.resumeSessionId)
    messages.push(...loadedMessages)
  }

  const existingMeta = await loadMeta(sessionId)
  createdAt = existingMeta?.createdAt ?? createdAt
  await refreshSkillRegistry(getCwd())
  await persistMeta(createdAt, messages.length)

  const rl = createInterface({
    input,
    output,
    terminal: true,
    historySize: 200,
  })

  const runPrompt = async (prompt: string, permissionInteractive = true) => {
    const trimmedPrompt = prompt.trim()
    if (trimmedPrompt.length === 0) {
      return
    }

    beginQuery()
    const userMessage = createUserMessage(trimmedPrompt, getLastUuid(messages))
    messages.push(userMessage)
    await appendMessage(sessionId, userMessage)
    await touchMeta(sessionId, messages.length)
    const messageCountBeforeQuery = messages.length

    let assistantLineOpen = false
    const openAssistantLine = () => {
      if (!assistantLineOpen) {
        output.write(chalk.green('assistant> '))
        assistantLineOpen = true
      }
    }

    try {
      const result = await query({
        config: params.config,
        messages,
        tools: activeTools,
        rl: permissionInteractive ? rl : undefined,
        isInteractive: permissionInteractive,
        onTextDelta(text) {
          openAssistantLine()
          output.write(text)
        },
        onToolUse(event) {
          if (assistantLineOpen) {
            output.write('\n')
            assistantLineOpen = false
          }
          output.write(
            chalk.yellow(
              `[tool] ${event.name} ${JSON.stringify(event.input)}\n`,
            ),
          )
        },
        onToolResult(event) {
          output.write(
            chalk.gray(
              `[tool-result] ${event.toolName}${event.isError ? ' error' : ''}\n`,
            ),
          )
        },
        onCompactStart() {
          if (assistantLineOpen) {
            output.write('\n')
            assistantLineOpen = false
          }
          output.write(chalk.yellow('[compact] Compacting context...\n'))
        },
        onCompactEnd(result) {
          output.write(
            chalk.green(
              `[compact] Removed ${result.removedCount} messages, summary ~${result.summaryTokens} tokens\n`,
            ),
          )
        },
        onCompactError(message) {
          output.write(chalk.red(`[compact] ${message}\n`))
        },
      })

      const newlyAddedMessages = result.messages.slice(messageCountBeforeQuery)
      messages.splice(0, messages.length, ...result.messages)
      if (result.didCompact) {
        await rewriteTranscript(sessionId, messages)
      } else {
        for (const message of newlyAddedMessages) {
          await appendMessage(sessionId, message)
        }
      }
      await persistMeta(createdAt, messages.length)

      if (assistantLineOpen) {
        output.write('\n')
      }
    } catch (error) {
      if (assistantLineOpen) {
        output.write('\n')
      }
      const message = error instanceof Error ? error.message : String(error)
      output.write(chalk.red(`error> ${message}\n`))
      await persistMeta(createdAt, messages.length)
    }
  }

  output.write(chalk.cyan(`LightClaw session ${getSessionId()}\n`))
  output.write(chalk.gray(`cwd: ${getCwd()}\n`))
  output.write(chalk.gray(`model: ${params.config.model}\n`))
  output.write(chalk.gray(`provider: ${params.config.provider}\n`))
  if (params.resumeSessionId) {
    output.write(
      chalk.gray(
        `resumed: ${params.resumeSessionId} (${messages.length} messages loaded)\n`,
      ),
    )
  }
  output.write(
    chalk.gray(
      'Type /exit to quit. Commands: /sessions /status /compact /skills /skill <name> [args] /memory /todos /mcp /mcp reload /permissions /mode <mode> /allow <rule> /deny <rule>\n\n',
    ),
  )

  if (params.initialPrompt) {
    await runPrompt(params.initialPrompt, false)
    await awaitBackgroundTasks()
    rl.close()
    await persistMeta(createdAt, messages.length)
    await cleanupMcp()
    printUsageSummary()
    return
  }

  while (true) {
    let line: string
    try {
      line = await rl.question(chalk.blue('you> '))
    } catch (error) {
      if (error instanceof Error && error.message === 'readline was closed') {
        break
      }

      throw error
    }

    const command = line.trim()
    if (command === '/exit') {
      break
    }

    if (command === '/compact') {
      await runManualCompact(messages, params.config, sessionId, createdAt)
      continue
    }

    if (command === '/sessions') {
      const sessions = await listSessions()
      output.write(chalk.gray(formatSessionList(sessions)))
      continue
    }

    if (command === '/status') {
      output.write(chalk.gray(`session: ${sessionId}\n`))
      output.write(chalk.gray(`cwd: ${getCwd()}\n`))
      output.write(chalk.gray(`model: ${getModel()}\n`))
      output.write(chalk.gray(`provider: ${params.config.provider}\n`))
      output.write(chalk.gray(`routing: ${formatRouting(params.config)}\n`))
      output.write(chalk.gray(`permission mode: ${getPermissionMode()}\n`))
      output.write(chalk.gray(`memory dir: ${getMemoryDir()}\n`))
      output.write(chalk.gray(`messages: ${messages.length}\n`))
      output.write(
        chalk.gray(`estimated tokens: ${estimateMessagesTokens(messages)}\n`),
      )
      output.write(
        chalk.gray(`compactions: ${getCompactionCount()}\n`),
      )
      if (getResumedFrom()) {
        output.write(chalk.gray(`resumed from: ${getResumedFrom()}\n`))
      }
      if (getLastExtractedAt() > 0) {
        output.write(
          chalk.gray(
            `last memory extract: ${new Date(getLastExtractedAt()).toISOString()}\n`,
          ),
        )
      }
      output.write(chalk.gray(`skills: ${listRegisteredSkills().length}\n`))
      output.write(chalk.gray(`todos: ${getTodos().length}\n`))
      output.write(chalk.gray(`MCP: ${formatMcpSummary()}\n`))
      continue
    }

    if (command === '/mcp') {
      output.write(chalk.gray(formatMcpStatus()))
      continue
    }

    if (command === '/mcp reload') {
      output.write(chalk.yellow('[mcp] Reloading servers...\n'))
      await reloadMcp()
      activeTools = getEnabledTools(getProvider(params.config), getAllTools())
      output.write(chalk.green(`[mcp] ${formatMcpSummary()}\n`))
      continue
    }

    if (command.startsWith('/mcp ')) {
      output.write(chalk.red('error> Usage: /mcp [reload]\n'))
      continue
    }

    if (command === '/permissions clear') {
      clearSessionRules()
      output.write(chalk.gray('Session permission rules cleared.\n'))
      await persistMeta(createdAt, messages.length)
      continue
    }

    if (command === '/permissions') {
      output.write(chalk.gray(formatPermissions()))
      continue
    }

    if (command === '/mode' || command.startsWith('/mode ')) {
      const rawMode = command.slice('/mode'.length).trim()
      const mode = parsePermissionMode(rawMode)
      if (!mode) {
        output.write(
          chalk.red('error> Usage: /mode default|acceptEdits|bypassPermissions|plan\n'),
        )
        continue
      }

      setPermissionMode(mode)
      output.write(chalk.green(`Permission mode: ${mode}\n`))
      await persistMeta(createdAt, messages.length)
      continue
    }

    if (command === '/allow' || command.startsWith('/allow ')) {
      const rawRule = command.slice('/allow'.length).trim()
      if (!addReplRule('allow', rawRule)) {
        output.write(chalk.red('error> Usage: /allow ToolName(optional:*)\n'))
      }
      continue
    }

    if (command === '/deny' || command.startsWith('/deny ')) {
      const rawRule = command.slice('/deny'.length).trim()
      if (!addReplRule('deny', rawRule)) {
        output.write(chalk.red('error> Usage: /deny ToolName(optional:*)\n'))
      }
      continue
    }

    if (command === '/todos') {
      const todos = getTodos()
      output.write(
        chalk.gray(
          todos.length > 0 ? `${formatTodosForPrompt(todos)}\n` : 'No todos.\n',
        ),
      )
      continue
    }

    if (command === '/skills') {
      await refreshSkillRegistry(getCwd())
      output.write(chalk.gray(formatSkillList()))
      continue
    }

    if (command === '/memory') {
      output.write(chalk.gray(await formatMemoryList()))
      continue
    }

    if (command === '/skill' || command.startsWith('/skill ')) {
      const rawArgs = command.slice('/skill'.length).trim()
      if (rawArgs.length === 0) {
        output.write(chalk.red('error> Usage: /skill <name> [args]\n'))
        continue
      }

      const [name, ...rest] = rawArgs.split(/\s+/)
      await refreshSkillRegistry(getCwd())
      const skillPrompt = await buildRegisteredSkillInvocation(
        name,
        rest.join(' '),
      )
      if (!skillPrompt) {
        output.write(chalk.red(`error> Unknown skill: ${name}\n`))
        continue
      }

      output.write(chalk.cyan(`[skill] ${name}\n`))
      await runPrompt(skillPrompt)
      continue
    }

    await runPrompt(line)
  }

  rl.close()
  await awaitBackgroundTasks()
  await persistMeta(createdAt, messages.length)
  await cleanupMcp()
  printUsageSummary()
}

async function runManualCompact(
  messages: Message[],
  config: LightClawConfig,
  sessionId: string,
  createdAt: number,
): Promise<void> {
  output.write(chalk.yellow('[compact] Compacting context...\n'))

  try {
    const result = await compactConversation({
      messages,
      keepRecent: config.compactKeepRecent,
      config,
    })

    if (result.removedCount === 0) {
      output.write(chalk.gray('[compact] Not enough history to compact.\n'))
      return
    }

    incrementCompactionCount()
    messages.splice(0, messages.length, ...result.messages)
    await rewriteTranscript(sessionId, messages)
    await persistMeta(createdAt, messages.length)
    output.write(
      chalk.green(
        `[compact] Removed ${result.removedCount} messages, summary ~${result.summaryTokens} tokens\n`,
      ),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    output.write(chalk.red(`[compact] ${message}\n`))
  }
}

async function persistMeta(createdAt: number, messageCount: number): Promise<void> {
  const sessionId = getSessionId()
  const existingMeta = await loadMeta(sessionId)
  const meta: SessionMeta = {
    sessionId,
    model: getModel(),
    cwd: getCwd(),
    createdAt: existingMeta?.createdAt ?? createdAt,
    lastActiveAt: Date.now(),
    messageCount,
    compactionCount: getCompactionCount(),
    lastExtractedAt: getLastExtractedAt(),
    todos: getTodos(),
    permissionMode: getPermissionMode(),
  }

  await saveMeta(sessionId, meta)
}

function addReplRule(behavior: 'allow' | 'deny', rawRule: string): boolean {
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

function formatPermissions(): string {
  const lines = [
    `Permission mode: ${getPermissionMode()}`,
    `Rules: ${getAllPermissionRules().length}`,
  ]

  const allRules = getAllPermissionRules()
  const groups = ['cliArg', 'session', 'local', 'project', 'user'] as const

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

function printUsageSummary(): void {
  const totals = getUsageTotals()
  output.write(
    chalk.gray(
      `\nusage: input_tokens=${totals.inputTokens}, output_tokens=${totals.outputTokens}\n`,
    ),
  )
}
