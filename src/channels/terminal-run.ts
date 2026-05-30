import { userInfo } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { Writable } from 'node:stream'

import { getConfig } from '../config.js'
import { workspaceFor } from '../identity/paths.js'
import { resolveTerminalUserId } from '../init-wizard.js'
import type { PermissionMode } from '../permission/types.js'
import { ChannelRunner, type ChannelRunnerStrategy } from './runner.js'
import type { NormalizedChannelMessage } from './types.js'

const TERMINAL_RUN_CHANNEL_ID = 'terminal'
const DEFAULT_SESSION_ID = 'terminal-run'

export type RunPromptSource = 'argv' | 'stdin' | 'argv+stdin'

export type TerminalRunInput = {
  prompt: string
  source: RunPromptSource
  stdout?: Pick<Writable, 'write'>
}

export async function runTerminalOneShot(input: TerminalRunInput): Promise<void> {
  const prompt = input.prompt.trim()
  if (!prompt) {
    throw new Error('No prompt provided. Use `lightclaw run <prompt...>` or `lightclaw run --stdin`.')
  }

  const currentUserId = await resolveTerminalUserId()
  const osUser = userInfo().username || 'unknown'
  const runner = new ChannelRunner(createTerminalRunStrategy({
    currentUserId,
    stdout: input.stdout ?? process.stdout,
  }))
  await runner.initialize()
  await runner.handleMessage(createTerminalRunMessage({ prompt, osUser }))
}

export function createTerminalRunMessage(input: {
  prompt: string
  osUser?: string
  now?: number
  id?: string
}): NormalizedChannelMessage {
  const osUser = input.osUser ?? (userInfo().username || 'unknown')
  const id = input.id ?? randomUUID()
  const now = input.now ?? Date.now()
  return {
    channel: TERMINAL_RUN_CHANNEL_ID,
    eventId: `terminal-run-${now}-${id}`,
    chatId: DEFAULT_SESSION_ID,
    senderOpenId: osUser,
    senderKey: `terminal:${osUser}`,
    chatType: 'p2p',
    messageId: `terminal-run-${now}-${id}`,
    text: input.prompt,
    synthetic: true,
  }
}

export function createTerminalRunStrategy(input: {
  currentUserId: string
  stdout: Pick<Writable, 'write'>
}): ChannelRunnerStrategy {
  const config = getConfig()
  return {
    channelId: TERMINAL_RUN_CHANNEL_ID,
    cwd: workspaceFor(input.currentUserId),
    permissionMode: config.permissionMode as PermissionMode,
    isMessageAllowed: () => true,
    resolveSessionId: () => DEFAULT_SESSION_ID,
    buildChannelPrompt: () => [
      'You are responding to a one-shot LightClaw terminal dogfood run.',
      'Use the same behavior as normal channel turns, but write user-facing progress and final answers as plain terminal-friendly text.',
      'There is no rich chat UI; if you need user input, ask plainly and stop.',
    ].join('\n'),
    async sendReply(_message, text) {
      writeLine(input.stdout, text)
    },
    async sendNotice(_message, kind, text) {
      writeLine(input.stdout, kind === 'error' ? `ERROR: ${text}` : text)
    },
    async resolveSenderName() {
      return input.currentUserId
    },
  }
}

function writeLine(output: Pick<Writable, 'write'>, text: string): void {
  const normalized = text.endsWith('\n') ? text : `${text}\n`
  output.write(normalized)
}
