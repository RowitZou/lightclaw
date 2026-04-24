import path from 'node:path'

import { initializeApp, beginQuery } from '../../init.js'
import { initializeHooks, runHook } from '../../hooks/index.js'
import { initializeMcp } from '../../mcp/index.js'
import { createUserMessage, getLastUuid } from '../../messages.js'
import { getProvider } from '../../provider/index.js'
import { query } from '../../query.js'
import {
  appendMessage,
  loadMeta,
  loadTranscript,
  rewriteTranscript,
  saveMeta,
} from '../../session/storage.js'
import { refreshSkillRegistry } from '../../skill/registry.js'
import {
  awaitBackgroundTasks,
  getCompactionCount,
  getCwd,
  getLastExtractedAt,
  getModel,
  getPermissionMode,
  getSessionId,
  getTodos,
} from '../../state.js'
import { getAllTools, getEnabledTools } from '../../tools.js'
import type { Message, SessionMeta } from '../../types.js'
import type { FeishuChannelConfig, NormalizedChannelMessage } from '../types.js'
import { isFeishuMessageAllowed, resolveFeishuSessionId } from './routing.js'
import { FeishuSender } from './sender.js'
import { SessionLock } from './session-lock.js'

export class FeishuRunner {
  private locks = new SessionLock()
  private initialized = false

  constructor(
    private config: FeishuChannelConfig,
    private sender: FeishuSender,
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) {
      return
    }

    const appConfig = initializeApp({
      cwd: this.config.cwd ?? process.cwd(),
      permissionMode: this.config.permissionMode,
    })
    await initializeHooks(appConfig)
    await initializeMcp(appConfig)
    await refreshSkillRegistry(getCwd())
    this.initialized = true
  }

  async handleMessage(message: NormalizedChannelMessage): Promise<void> {
    if (!isFeishuMessageAllowed(message, this.config)) {
      return
    }

    const sessionId = resolveFeishuSessionId(message, this.config)
    await this.locks.runExclusive(sessionId, async () => {
      const meta = await loadMeta(sessionId)
      const messages = await loadTranscript(sessionId)
      const appConfig = initializeApp({
        cwd: meta?.cwd ?? this.config.cwd ?? process.cwd(),
        model: meta?.model,
        sessionId,
        resumedFrom: meta ? sessionId : null,
        compactionCount: meta?.compactionCount,
        lastExtractedAt: meta?.lastExtractedAt,
        todos: meta?.todos,
        permissionMode: this.config.permissionMode,
      })
      await refreshSkillRegistry(getCwd())
      if (!meta) {
        await runHook('onSessionStart', {
          sessionId,
          cwd: getCwd(),
          trigger: 'feishu',
        })
      }

      beginQuery()
      const userMessage = createUserMessage(formatPrompt(message), getLastUuid(messages))
      messages.push(userMessage)
      await appendMessage(sessionId, userMessage)
      const messageCountBeforeQuery = messages.length
      const provider = getProvider(appConfig)

      const result = await query({
        config: appConfig,
        messages,
        tools: getEnabledTools(provider, getAllTools()),
        isInteractive: false,
        onToolUse(event) {
          process.stderr.write(`feishu: tool ${event.name}\n`)
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
      await this.sender.sendText(message, result.lastAssistantText || '(no response)')
    })
  }
}

function formatPrompt(message: NormalizedChannelMessage): string {
  return [
    '[Feishu message]',
    `chat_id: ${message.chatId}`,
    `sender_open_id: ${message.senderOpenId}`,
    '',
    message.text,
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
  }
  await saveMeta(sessionId, meta)
}
