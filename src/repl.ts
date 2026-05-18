import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

import chalk from 'chalk'

import { createBuiltinReplRegistry, RENAMED_COMMANDS } from './commands/builtin.js'
import { t } from './i18n/index.js'
import type { ReplContext } from './commands/registry.js'
import { type LightClawConfig } from './config.js'
import { isAdmin as checkIsAdmin } from './identity/store.js'
import { getCurrentUserId, getSessionId } from './state.js'
import type { Message } from './types.js'

type ReplParams = {
  config: LightClawConfig
}

/**
 * Terminal admin console.
 *
 * The terminal no longer drives the agent loop — it is a slash-only control
 * surface for the daemon's admin (pairing, ceiling, sandbox, auth, cost,
 * rules, model/mode preferences). The agent itself is reached exclusively
 * through channels (Feishu); the admin talks to the bot there like any other
 * paired identity. This loop's second job is simply to keep the daemon
 * process in the foreground — cli.ts owns channel startup and the shutdown
 * drains that run when this loop exits.
 */
export async function startRepl(params: ReplParams): Promise<void> {
  const sessionId = getSessionId()
  const createdAt = Date.now()

  const rl = createInterface({
    input,
    output,
    terminal: true,
    historySize: 200,
  })

  // includeChannelOnly: false drops /stop — it is an in-flight-turn command
  // with no meaning in a console that never runs a query.
  const registry = createBuiltinReplRegistry({ includeChannelOnly: false })
  const currentUserId = getCurrentUserId()
  const currentUserIsAdmin = currentUserId ? await checkIsAdmin(currentUserId) : false
  // The console has no transcript; `messages` stays empty and is only here
  // because the shared slash handlers (with the channel) read ctx.messages.
  const messages: Message[] = []
  const ctx: ReplContext = {
    config: params.config,
    sessionId,
    createdAt,
    messages,
    rl,
    output,
    userId: currentUserId,
    isAdmin: currentUserIsAdmin,
    isChannel: false,
    getActiveTools: () => [],
    setActiveTools: () => {},
    // No transcript / session meta to persist — /model and /mode already
    // write their durable state through setIdentityPreference. Kept on the
    // context only because the shared slash handlers expect the hook.
    persistMeta: async () => {},
  }

  output.write(chalk.cyan(
    `${currentUserId ? t('banner.greet', { name: currentUserId }) : t('banner.greetAnonymous')}\n`,
  ))
  output.write(chalk.gray(
    `${t('banner.commands', { list: registry.bannerLine(currentUserIsAdmin) })}\n\n`,
  ))

  while (true) {
    let line: string
    try {
      line = await rl.question(chalk.blue('console> '))
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

    if (!command.startsWith('/')) {
      output.write(chalk.gray(`${t('banner.slashOnly')}\n`))
      continue
    }

    await registry.dispatch(command, ctx, RENAMED_COMMANDS)
  }

  rl.close()
}
