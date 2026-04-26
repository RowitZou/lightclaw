import path from 'node:path'

import { runHook } from '../hooks/index.js'
import { initializeHooks } from '../hooks/index.js'
import { initializeMcp } from '../mcp/index.js'
import { initializeApp, beginQuery, resetSessionContext } from '../init.js'
import { generateOrReusePending } from '../identity/pairing.js'
import { lookupBySender, rebuildReverseIndex } from '../identity/store.js'
import type { ChannelKind, SenderKey } from '../identity/types.js'
import { createUserMessage, getLastUuid } from '../messages.js'
import type { PermissionMode } from '../permission/types.js'
import { getProvider } from '../provider/index.js'
import { query } from '../query.js'
import {
  appendMessage,
  loadMeta,
  loadTranscript,
  rewriteTranscript,
  saveMeta,
} from '../session/storage.js'
import { refreshSkillRegistry } from '../skill/registry.js'
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
} from '../state.js'
import { getAllTools, getEnabledTools } from '../tools.js'
import type { SessionMeta } from '../types.js'

import { SessionLock } from './session-lock.js'
import type { ChannelId, NormalizedChannelMessage } from './types.js'

/**
 * Per-channel strategy: everything that varies between feishu / wechat /
 * ide-bridge. The shared orchestration (session lock, transcript load /
 * append / compact, hook lifecycle, runQuery with mode='channel') lives in
 * ChannelRunner and never needs channel-specific branching.
 */
export type ChannelRunnerStrategy = {
  channelId: ChannelId
  cwd: string
  permissionMode: PermissionMode
  isMessageAllowed(message: NormalizedChannelMessage): boolean
  resolveSessionId(message: NormalizedChannelMessage, userId: string): string
  buildChannelPrompt(message: NormalizedChannelMessage): string
  sendReply(
    message: NormalizedChannelMessage,
    text: string,
  ): Promise<void>
}

/**
 * Generic, channel-agnostic message runner. Holds the per-session serial
 * lock, wires a message through resetSessionContext() + query({ mode:
 * 'channel' }), persists the transcript, and delegates the reply back to
 * the strategy's sender.
 */
export class ChannelRunner {
  private locks = new SessionLock()
  private initialized = false

  constructor(private readonly strategy: ChannelRunnerStrategy) {}

  /**
   * One-shot bootstrap of app-level singletons (agents registry, signal
   * handlers, hook loader, MCP connections, skill registry). Per-message
   * state (sessionId, cwd, permissionMode) is refreshed on each message
   * via resetSessionContext() inside handleMessage().
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return
    }

    const appConfig = initializeApp({
      cwd: this.strategy.cwd,
      permissionMode: this.strategy.permissionMode,
    })
    await initializeHooks(appConfig)
    await initializeMcp(appConfig)
    await refreshSkillRegistry(getCwd())
    this.initialized = true
  }

  async handleMessage(message: NormalizedChannelMessage): Promise<void> {
    if (!this.strategy.isMessageAllowed(message)) {
      return
    }

    const userId = await this.resolveMessageUser(message)
    if (!userId) {
      return
    }
    const sessionId = this.strategy.resolveSessionId(message, userId)
    await this.locks.runExclusive(sessionId, async () => {
      const meta = await loadMeta(sessionId)
      const messages = await loadTranscript(sessionId)
      const appConfig = resetSessionContext({
        cwd: meta?.cwd ?? this.strategy.cwd,
        model: meta?.model,
        sessionId,
        resumedFrom: meta ? sessionId : null,
        compactionCount: meta?.compactionCount,
        lastExtractedAt: meta?.lastExtractedAt,
        todos: meta?.todos,
        permissionMode: this.strategy.permissionMode,
        currentUserId: userId,
      })
      await refreshSkillRegistry(getCwd())
      if (!meta) {
        await runHook('onSessionStart', {
          sessionId,
          cwd: getCwd(),
          trigger: 'channel',
          channelId: this.strategy.channelId,
        })
      }

      beginQuery()
      const userText = formatChannelUserText(message)
      const userMessage = createUserMessage(userText, getLastUuid(messages))
      messages.push(userMessage)
      await appendMessage(sessionId, userMessage)
      const messageCountBeforeQuery = messages.length
      const provider = getProvider(appConfig)
      const channelId = this.strategy.channelId

      const result = await query({
        config: appConfig,
        messages,
        tools: getEnabledTools(provider, getAllTools()),
        mode: 'channel',
        channelContext: this.strategy.buildChannelPrompt(message),
        onToolUse(event) {
          process.stderr.write(`${channelId}: tool ${event.name}\n`)
        },
      })

      const previousTail = messages[messageCountBeforeQuery - 1]
      const nextTail = result.messages[messageCountBeforeQuery - 1]
      const didMutateExistingHistory =
        JSON.stringify(previousTail) !== JSON.stringify(nextTail)
      const newlyAddedMessages = result.messages.slice(messageCountBeforeQuery)
      if (result.didCompact || didMutateExistingHistory) {
        await rewriteTranscript(sessionId, result.messages)
      } else {
        for (const item of newlyAddedMessages) {
          await appendMessage(sessionId, item)
        }
      }

      await persistMeta(Date.now(), result.messages.length)
      await awaitBackgroundTasks()
      await this.strategy.sendReply(message, result.lastAssistantText || '(no response)')
    })
  }

  private async resolveMessageUser(message: NormalizedChannelMessage): Promise<string | null> {
    const channel = this.strategy.channelId
    if (!isPairableChannel(channel)) {
      return null
    }

    await rebuildReverseIndex()
    const senderKey = (message.senderKey ?? `${channel}:${message.senderOpenId}`) as SenderKey
    const approvedUser = lookupBySender(senderKey)
    if (approvedUser) {
      return approvedUser
    }

    try {
      const result = await generateOrReusePending(
        channel,
        message.senderOpenId,
        message.senderDisplayName ?? '',
      )
      const freshness = result.created ? 'created' : 'reused'
      await this.strategy.sendReply(
        message,
        [
          'Welcome to LightClaw bot.',
          `To use this bot, ask the LightClaw operator to approve this pairing code: ${result.code}`,
          `Operator command: lightclaw identity approve ${result.code} --as <name>`,
          `(${freshness} pairing request; code expires in 1 hour)`,
        ].join('\n'),
      )
    } catch (error) {
      if (error instanceof Error && error.message === 'rate-limited') {
        await this.strategy.sendReply(
          message,
          'Pairing request is rate limited. Ask the LightClaw operator to check `lightclaw identity pending`.',
        )
        return null
      }
      throw error
    }

    return null
  }
}

function isPairableChannel(channel: string): channel is ChannelKind {
  return channel === 'feishu' || channel === 'wechat'
}

function formatChannelUserText(message: NormalizedChannelMessage): string {
  if (!message.mediaPath) {
    return message.text
  }
  return [
    message.text || '(no text)',
    '',
    '[媒体附件]',
    `- type: ${message.mediaType ?? 'unknown'}`,
    `- path: ${message.mediaPath}`,
  ].join('\n')
}

async function persistMeta(createdAt: number, messageCount: number): Promise<void> {
  const sessionId = getSessionId()
  const existingMeta = await loadMeta(sessionId)
  const meta: SessionMeta = {
    sessionId,
    model: getModel(),
    cwd: path.resolve(getCwd()),
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
