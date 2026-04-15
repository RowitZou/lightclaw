import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

import chalk from 'chalk'

import type { LightClawConfig } from './config.js'
import { beginQuery } from './init.js'
import { createUserMessage } from './messages.js'
import { query } from './query.js'
import { getCwd, getSessionId, getUsageTotals } from './state.js'
import type { Message } from './types.js'
import type { Tool } from './tool.js'

type ReplParams = {
  config: LightClawConfig
  tools: Tool[]
  initialPrompt?: string
}

export async function startRepl(params: ReplParams): Promise<void> {
  const messages: Message[] = []
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
    messages.push(createUserMessage(trimmedPrompt))

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
      })

      messages.splice(0, messages.length, ...result.messages)
      if (assistantLineOpen) {
        output.write('\n')
      }
    } catch (error) {
      if (assistantLineOpen) {
        output.write('\n')
      }
      const message = error instanceof Error ? error.message : String(error)
      output.write(chalk.red(`error> ${message}\n`))
    }
  }

  output.write(chalk.cyan(`LightClaw session ${getSessionId()}\n`))
  output.write(chalk.gray(`cwd: ${getCwd()}\n`))
  output.write(chalk.gray(`model: ${params.config.model}\n`))
  output.write(chalk.gray('Type /exit to quit.\n\n'))

  if (params.initialPrompt) {
    await runPrompt(params.initialPrompt)
    rl.close()
    printUsageSummary()
    return
  }

  while (true) {
    const line = await rl.question(chalk.blue('you> '))
    if (line.trim() === '/exit') {
      break
    }
    await runPrompt(line)
  }

  rl.close()
  printUsageSummary()
}

function printUsageSummary(): void {
  const totals = getUsageTotals()
  output.write(
    chalk.gray(
      `\nusage: input_tokens=${totals.inputTokens}, output_tokens=${totals.outputTokens}\n`,
    ),
  )
}