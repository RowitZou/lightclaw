import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

import chalk from 'chalk'

import type { LightClawConfig } from './config.js'
import { beginQuery } from './init.js'
import { createUserMessage, getLastUuid } from './messages.js'
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
  getCompactionCount,
  getCwd,
  getModel,
  getResumedFrom,
  getSessionId,
  getUsageTotals,
  incrementCompactionCount,
} from './state.js'
import { estimateMessagesTokens } from './token-estimate.js'
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

  if (params.resumeSessionId) {
    const loadedMessages = await loadTranscript(params.resumeSessionId)
    messages.push(...loadedMessages)
  }

  const existingMeta = await loadMeta(sessionId)
  createdAt = existingMeta?.createdAt ?? createdAt
  await persistMeta(createdAt, messages.length)

  const rl = createInterface({
    input,
    output,
    terminal: true,
    historySize: 200,
  })

  const runPrompt = async (prompt: string) => {
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
        tools: params.tools,
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
  if (params.resumeSessionId) {
    output.write(
      chalk.gray(
        `resumed: ${params.resumeSessionId} (${messages.length} messages loaded)\n`,
      ),
    )
  }
  output.write(chalk.gray('Type /exit to quit. Commands: /sessions /status /compact\n\n'))

  if (params.initialPrompt) {
    await runPrompt(params.initialPrompt)
    rl.close()
    await persistMeta(createdAt, messages.length)
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
      continue
    }

    await runPrompt(line)
  }

  rl.close()
  await persistMeta(createdAt, messages.length)
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