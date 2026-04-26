import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

import chalk from 'chalk'

import { createBuiltinReplRegistry } from './commands/builtin.js'
import type { ReplContext } from './commands/registry.js'
import { type LightClawConfig } from './config.js'
import { runHook } from './hooks/index.js'
import { beginQuery } from './init.js'
import { createUserMessage, getLastUuid } from './messages.js'
import { cleanupMcp } from './mcp/index.js'
import { query } from './query.js'
import {
  appendMessage,
  loadMeta,
  loadTranscript,
  rewriteTranscript,
  saveMeta,
  touchMeta,
} from './session/storage.js'
import { refreshSkillRegistry } from './skill/registry.js'
import {
  awaitBackgroundTasks,
  getCompactionCount,
  getCurrentUserId,
  getCwd,
  getLastExtractedAt,
  getModel,
  getPermissionMode,
  getSessionId,
  getTodos,
  getUsageTotals,
} from './state.js'
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
  await persistMeta(sessionId, createdAt, messages.length)
  await runHook('onSessionStart', {
    sessionId,
    cwd: getCwd(),
    trigger: params.resumeSessionId
      ? 'resume'
      : params.initialPrompt
        ? 'single'
        : 'repl',
  })

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
        mode: 'interactive',
        rl: permissionInteractive ? rl : undefined,
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

      const previousTail = messages[messageCountBeforeQuery - 1]
      const nextTail = result.messages[messageCountBeforeQuery - 1]
      const didMutateExistingHistory =
        JSON.stringify(previousTail) !== JSON.stringify(nextTail)
      const newlyAddedMessages = result.messages.slice(messageCountBeforeQuery)
      messages.splice(0, messages.length, ...result.messages)
      if (result.didCompact || didMutateExistingHistory) {
        await rewriteTranscript(sessionId, messages)
      } else {
        for (const message of newlyAddedMessages) {
          await appendMessage(sessionId, message)
        }
      }
      await persistMeta(sessionId, createdAt, messages.length)

      if (assistantLineOpen) {
        output.write('\n')
      }
    } catch (error) {
      if (assistantLineOpen) {
        output.write('\n')
      }
      const message = error instanceof Error ? error.message : String(error)
      output.write(chalk.red(`error> ${message}\n`))
      await persistMeta(sessionId, createdAt, messages.length)
    }
  }

  const registry = createBuiltinReplRegistry()
  const ctx: ReplContext = {
    config: params.config,
    sessionId,
    createdAt,
    messages,
    rl,
    output,
    getActiveTools: () => activeTools,
    setActiveTools: tools => { activeTools = tools },
    runPrompt,
    persistMeta: count => persistMeta(sessionId, createdAt, count),
  }

  output.write(chalk.cyan(`LightClaw session ${getSessionId()}\n`))
  output.write(chalk.gray(`cwd: ${getCwd()}\n`))
  output.write(chalk.gray(`model: ${params.config.model}\n`))
  output.write(chalk.gray(`provider: ${params.config.provider}\n`))
  if (getCurrentUserId()) {
    output.write(chalk.gray(`user: ${getCurrentUserId()}\n`))
  }
  if (params.resumeSessionId) {
    output.write(
      chalk.gray(
        `resumed: ${params.resumeSessionId} (${messages.length} messages loaded)\n`,
      ),
    )
  }
  output.write(chalk.gray(`Type /exit to quit. Commands: ${registry.bannerLine()}\n\n`))

  if (params.initialPrompt) {
    await runPrompt(params.initialPrompt, false)
    await awaitBackgroundTasks()
    rl.close()
    await persistMeta(sessionId, createdAt, messages.length)
    await runHook('onSessionEnd', { sessionId, reason: 'exit' })
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
    if (command.length === 0) {
      continue
    }

    const dispatched = await registry.dispatch(command, ctx)
    if (dispatched === 'exit') {
      break
    }
    if (dispatched === 'continue') {
      continue
    }

    await runPrompt(line)
  }

  rl.close()
  await awaitBackgroundTasks()
  await persistMeta(sessionId, createdAt, messages.length)
  await runHook('onSessionEnd', { sessionId, reason: 'exit' })
  await cleanupMcp()
  printUsageSummary()
}

async function persistMeta(
  sessionId: string,
  createdAt: number,
  messageCount: number,
): Promise<void> {
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
    userId: existingMeta?.userId ?? getCurrentUserId(),
  }
  await saveMeta(sessionId, meta)
}

function printUsageSummary(): void {
  const totals = getUsageTotals()
  output.write(
    chalk.gray(
      `\nusage: input_tokens=${totals.inputTokens}, output_tokens=${totals.outputTokens}\n`,
    ),
  )
}
