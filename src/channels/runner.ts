import path from 'node:path'

import { dispatchChannelSlash } from '../commands/dispatch-channel.js'
import { runHook } from '../hooks/index.js'
import { initializeHooks } from '../hooks/index.js'
import { workspaceFor } from '../identity/paths.js'
import { initializeMcp } from '../mcp/index.js'
import { initializeApp, beginQuery, resetSessionContext } from '../init.js'
import { generateOrReusePending, updatePendingDisplayName } from '../identity/pairing.js'
import { isAdmin, lookupBySender, rebuildReverseIndex } from '../identity/store.js'
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
  /**
   * Best-effort lookup of a human-readable display name for a sender (for
   * the `lightclaw identity pending` table). Channel-specific because the
   * underlying API differs (lark contact.user.get vs no-op for wechat).
   * Called only when a NEW pairing code is generated, not on every message;
   * fired and forgotten so the inbound message itself is never blocked.
   */
  fetchSenderName?(peerId: string): Promise<string | undefined>
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
    // User lookup runs FIRST (and pairing falls out of unknown sender).
    // The Phase 8 allowlist gate runs after — otherwise a tight allowlist
    // (e.g. allowUsers=["ou_alice"]) would silently drop unknown senders
    // BEFORE they could even receive a pairing code, making the whole
    // pairing flow unreachable unless the allowlist is wide-open ["*"].
    const userId = await this.resolveMessageUser(message)
    if (!userId) {
      return
    }
    if (!this.strategy.isMessageAllowed(message)) {
      return
    }
    const sessionId = this.strategy.resolveSessionId(message, userId)
    await this.locks.runExclusive(sessionId, async () => {
      const meta = await loadMeta(sessionId)
      const messages = await loadTranscript(sessionId)
      const workspace = workspaceFor(userId)
      const appConfig = resetSessionContext({
        cwd: workspace,
        model: meta?.model,
        sessionId,
        resumedFrom: meta ? sessionId : null,
        compactionCount: meta?.compactionCount,
        lastExtractedAt: meta?.lastExtractedAt,
        todos: meta?.todos,
        // Prefer the persisted session mode so an in-channel `/mode <m>`
        // survives across messages. The channels.json default only applies
        // for the first message of a session (when meta does not exist
        // yet); after that the user-driven mode change is the source of
        // truth, mirroring how the REPL resumes mode from meta.
        permissionMode: meta?.permissionMode ?? this.strategy.permissionMode,
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
      const slash = await dispatchChannelSlash(userText, {
        config: appConfig,
        sessionId,
        createdAt: meta?.createdAt ?? Date.now(),
        messages,
        userId,
        isAdmin: await isAdmin(userId),
        getActiveTools: () => getEnabledTools(getProvider(appConfig), getAllTools()),
        setActiveTools() {},
        persistMeta: count => persistMeta(Date.now(), count),
      })
      if (slash.handled) {
        await persistMeta(Date.now(), messages.length)
        await this.strategy.sendReply(message, slash.output.trim() || 'ok')
        return
      }

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
      const result = await generateOrReusePending(channel, message.senderOpenId)
      // Display name is fetched async via the strategy's optional fetcher and
      // patched into pending.json after the fact, so the inbound message is
      // never blocked by a platform user.get round-trip. Only fired for new
      // pending entries — reused codes already have whatever name we managed
      // to capture before.
      if (result.created && this.strategy.fetchSenderName) {
        void this.strategy.fetchSenderName(message.senderOpenId).then(
          async name => {
            if (name) {
              await updatePendingDisplayName(result.code, name)
            }
          },
          error => {
            const text = error instanceof Error ? error.message : String(error)
            process.stderr.write(`${this.strategy.channelId}: name fetch failed: ${text}\n`)
          },
        )
      }
      const freshness = result.created ? 'created' : 'reused'
      await this.strategy.sendReply(
        message,
        [
          'Welcome to LightClaw bot.',
          `To use this bot, ask the LightClaw operator to approve this pairing code: ${result.code}`,
          `Operator command: /identity approve ${result.code} --as <name>`,
          `(${freshness} pairing request; code expires in 1 hour)`,
        ].join('\n'),
      )
    } catch (error) {
      if (error instanceof Error && error.message === 'rate-limited') {
        await this.strategy.sendReply(
          message,
          'Pairing request is rate limited. Ask the LightClaw operator to check `/identity pending`.',
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
