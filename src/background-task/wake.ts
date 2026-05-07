import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import { createMainAgentCanUseTool } from '../agents/main-agent-can-use-tool.js'
import { channelSessionLock } from '../channels/session-lock.js'
import { getFeishuSender } from '../channels/feishu/sender-registry.js'
import { getConfig } from '../config.js'
import { getMemoryDir } from '../memory/auto-memory.js'
import { createUserMessage } from '../messages.js'
import { getProvider } from '../provider/index.js'
import { loadFileRules, loadIdentityRules } from '../permission/storage.js'
import { loadIdentityPreferences } from '../identity/preferences.js'
import { workspaceFor } from '../identity/paths.js'
import { query } from '../query.js'
import { getImageReadiness, getRuntimePool } from '../state.js'
import {
  createSessionContext,
  runWithSessionContext,
} from '../session-context.js'
import {
  appendMessage,
  loadMeta,
  loadTranscript,
  saveMeta,
} from '../session/storage.js'
import { getAllTools, getEnabledTools } from '../tools.js'
import type { BackgroundTaskEntry, FireOutcome, WakeNotifyResult } from './types.js'

export async function wakeMainAgent(input: {
  canonicalUser: string
  task: BackgroundTaskEntry
  outcome: FireOutcome
}): Promise<WakeNotifyResult> {
  const mainSessionId = `feishu-${input.canonicalUser}`
  return channelSessionLock.runExclusive(mainSessionId, async () => {
    const config = getConfig()
    const prefs = loadIdentityPreferences(input.canonicalUser)
    const model = prefs.model ?? config.model
    const permissionMode = prefs.permissionMode ?? config.permissionMode
    const cwd = path.resolve(workspaceFor(input.canonicalUser))
    await mkdir(cwd, { recursive: true, mode: 0o700 })
    const runtime = getRuntimePool().acquire(
      input.canonicalUser,
      config,
      cwd,
      config.runtime.backend === 'docker' ? getImageReadiness() : undefined,
    )
    const ctx = createSessionContext({
      cwd,
      model,
      sessionsDir: config.sessionsDir,
      memoryDir: getMemoryDir(input.canonicalUser, config),
      currentUserId: input.canonicalUser,
      sessionId: mainSessionId,
      permissionMode,
      runtime,
      fileRules: loadFileRules({
        cwd,
        userPath: config.permissionRuleFiles.user,
        projectPath: config.permissionRuleFiles.project,
        localPath: config.permissionRuleFiles.local,
      }),
      identityRules: loadIdentityRules(input.canonicalUser),
    })

    return runWithSessionContext(ctx, async () => {
      const messages = await loadTranscript(mainSessionId)
      const userMessage = {
        ...createUserMessage(buildWakePrompt(input.task, input.outcome), lastUuid(messages)),
        origin: 'bg-task-wake' as const,
      }
      messages.push(userMessage)
      await appendMessage(mainSessionId, userMessage)
      const provider = getProvider(config)
      const wakeNotifications: WakeNotifyResult[] = []
      const { notifyUserTool, staySilentTool } = await import('../tools/background-task.js')
      const result = await query({
        config: {
          ...config,
          model,
          routing: { ...config.routing, main: model },
        },
        messages,
        tools: [
          ...getEnabledTools(provider, getAllTools()),
          notifyUserTool,
          staySilentTool,
        ],
        mode: 'channel',
        canUseTool: createMainAgentCanUseTool('wake'),
        wakeNotifications,
      })
      const newMessages = result.messages.slice(messages.length)
      for (const item of newMessages) {
        await appendMessage(mainSessionId, item)
      }
      const meta = await loadMeta(mainSessionId)
      await saveMeta(mainSessionId, {
        sessionId: mainSessionId,
        model,
        cwd,
        createdAt: meta?.createdAt ?? Date.now(),
        lastActiveAt: Date.now(),
        messageCount: result.messages.length,
        compactionCount: meta?.compactionCount ?? 0,
        lastExtractedAt: meta?.lastExtractedAt,
        sessionMemoryUpdatedAt: meta?.sessionMemoryUpdatedAt,
        todos: meta?.todos,
        permissionMode,
        userId: input.canonicalUser,
      })
      return wakeNotifications.find(item => item.kind === 'notify') ??
        wakeNotifications.find(item => item.kind === 'silent') ??
        { kind: 'no-decision' }
    })
  })
}

export async function deliverWakeNotification(input: {
  ownerOpenId: string
  taskLabel: string
  result: WakeNotifyResult
}): Promise<void> {
  if (input.result.kind !== 'notify') {
    return
  }
  const sender = getFeishuSender()
  if (!sender) {
    process.stderr.write('[background-task] no Feishu sender registered; wake notification skipped\n')
    return
  }
  await sender.sendMarkdownTextToOpenId(
    input.ownerOpenId,
    `🔔 ${input.taskLabel}\n\n${input.result.text}`,
  )
}

function buildWakePrompt(task: BackgroundTaskEntry, outcome: FireOutcome): string {
  const resultText = outcome.kind === 'success'
    ? outcome.summary
    : `FAILED: ${outcome.reason}`
  return [
    '<background-task-fire>',
    `<label>${task.label}</label>`,
    `<task-id>${task.id}</task-id>`,
    `<outcome>${resultText}</outcome>`,
    '</background-task-fire>',
    '',
    'This is a wake from a scheduled BackgroundTask.',
    'Decide whether to disturb the user.',
    'Use notify_user({text}) to send a message, or stay_silent({reason}) to end without notifying.',
  ].join('\n')
}

function lastUuid(messages: Array<{ uuid: string }>): string | null {
  return messages.length > 0 ? messages[messages.length - 1]?.uuid ?? null : null
}
