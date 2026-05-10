import type { Dirent } from 'node:fs'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { createMainAgentCanUseTool } from '../agents/main-agent-can-use-tool.js'
import { channelSessionLock } from '../channels/session-lock.js'
import { getFeishuSender } from '../channels/feishu/sender-registry.js'
import { getConfig } from '../config.js'
import { getAdmin } from '../identity/store.js'
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

/**
 * Resolve the wake-target sessionId for a canonical user — the most-recently-
 * active feishu DM session belonging to that user. Returns null when no DM
 * session is on disk; caller must fall back to the user-card path rather than
 * fabricating a session id (the pre-Phase-26 `feishu-<canonical>` format
 * silently created an orphan transcript that did not lock against the user's
 * real DM session, breaking turn-level FIFO).
 *
 * Why DM, not group:
 *   - Privacy: BackgroundTask completion is a 1-on-1 reminder; surfacing it
 *     in a group leaks task content to other group members.
 *   - Continuity: DM is where the user is most likely to read agent output;
 *     Phase 26 group sessions are sender-specific and can be silent for days.
 *   - Phase 26 sessionId formula already gives us `feishu:dm:<chatId>`; meta
 *     `userId` ties each on-disk session back to its canonical user, so no
 *     new schema is needed.
 */
export async function resolveWakeSessionId(
  canonicalUser: string,
  sessionsDir: string,
): Promise<string | null> {
  let entries: Dirent[]
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
  let best: { sessionId: string; lastActiveAt: number } | null = null
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('feishu:dm:')) {
      continue
    }
    // Read meta.json directly via the caller-supplied sessionsDir rather than
    // through `loadMeta(sessionId)` (which resolves its own dir from config) —
    // tests construct an isolated tmp sessionsDir, and the resolver's contract
    // is "scan EXACTLY the directory you were given, ignore ambient config".
    const meta = await readMetaFromDir(sessionsDir, entry.name)
    if (!meta || meta.userId !== canonicalUser) {
      continue
    }
    if (!best || meta.lastActiveAt > best.lastActiveAt) {
      best = { sessionId: entry.name, lastActiveAt: meta.lastActiveAt }
    }
  }
  return best?.sessionId ?? null
}

async function readMetaFromDir(
  sessionsDir: string,
  sessionId: string,
): Promise<{ userId?: string; lastActiveAt: number } | null> {
  try {
    const raw = await readFile(path.join(sessionsDir, sessionId, 'meta.json'), 'utf8')
    const parsed = JSON.parse(raw) as { userId?: string; lastActiveAt?: number }
    if (typeof parsed.lastActiveAt !== 'number') {
      return null
    }
    return { userId: parsed.userId, lastActiveAt: parsed.lastActiveAt }
  } catch {
    return null
  }
}

export async function wakeMainAgent(input: {
  canonicalUser: string
  /** Resolved by caller via `resolveWakeSessionId`; must be a real on-disk
   *  session id (Phase 26 `feishu:dm:<chatId>`). The pre-Phase-26 hard-coded
   *  `feishu-<canonical>` form is rejected here as defense-in-depth. */
  mainSessionId: string
  task: BackgroundTaskEntry
  outcome: FireOutcome
}): Promise<WakeNotifyResult> {
  const { mainSessionId } = input
  if (!mainSessionId.startsWith('feishu:dm:')) {
    process.stderr.write(
      `[background-task] wake refused: mainSessionId "${mainSessionId}" is not a feishu DM session id (Phase 26 format)\n`,
    )
    return { kind: 'silent', reason: 'wake-refused-bad-session-id' }
  }
  return channelSessionLock.runExclusive(mainSessionId, async () => {
    const config = getConfig()

    // LocalRuntime is admin-only — defense-in-depth mirror of
    // `runner.ts:56-66`. Caller (scheduler) should already route non-admin
    // wakes to the user-card path, but a future caller bypassing that must
    // not silently acquire a LocalRuntime for a paired non-admin.
    if (config.runtime.backend === 'local') {
      const adminId = await getAdmin()
      if (adminId && adminId !== input.canonicalUser) {
        process.stderr.write(
          `[background-task] wake refused: LocalRuntime is admin-only; user "${input.canonicalUser}" is not admin\n`,
        )
        return { kind: 'silent', reason: 'wake-refused-admin-only' }
      }
    }

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
      channel: 'feishu',
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
          ...getEnabledTools(provider, getAllTools('feishu')),
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
      const decision = wakeNotifications.find(item => item.kind === 'notify') ??
        wakeNotifications.find(item => item.kind === 'silent') ??
        { kind: 'no-decision' }
      if (
        input.outcome.kind === 'failure' &&
        input.outcome.permissionDenials?.length &&
        decision.kind !== 'notify'
      ) {
        process.stderr.write(
          `[background-task] wake ended without user notification for permission_denied task ${input.task.id}; task may remain broken if allowedTools was not updated\n`,
        )
      }
      return decision
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

export function buildWakePrompt(task: BackgroundTaskEntry, outcome: FireOutcome): string {
  const resultText = outcome.kind === 'success'
    ? outcome.summary
    : `FAILED: ${outcome.reason}`
  if (outcome.kind === 'failure' && outcome.permissionDenials?.length) {
    return [
      '<background-task-fire>',
      `<label>${task.label}</label>`,
      `<task-id>${task.id}</task-id>`,
      '<outcome-kind>permission_denied</outcome-kind>',
      '<denials>',
      ...outcome.permissionDenials.flatMap(denial => [
        '  <denial>',
        `    <tool>${denial.toolName}</tool>`,
        `    <input>${denial.inputPreview}</input>`,
        `    <suggested>${denial.suggestedRules.join(', ')}</suggested>`,
        '  </denial>',
      ]),
      '</denials>',
      '</background-task-fire>',
      '',
      'This BackgroundTask fire was denied because the listed tools are not in the task allowed_tools.',
      'Decide now:',
      `  (a) If the suggested rules fit the task purpose, call UpdateBackgroundTask({ id: '${task.id}', allowed_tools: [the merged full list] }). For a oneshot that already fired, this will trigger an immediate retry. Then call stay_silent({reason}).`,
      `  (b) If the task is wrong or runaway, call CancelBackgroundTask({ id: '${task.id}' }) and notify_user({text}) with a brief explanation.`,
      '  (c) If the suggested rules look unrelated or suspicious, call notify_user({text}) and explain what you saw.',
      '',
      'If you call stay_silent without updating allowed_tools, the task remains broken and will likely fail again.',
      'High-risk patterns such as rm/dd/sudo are routed directly to the user approval card and should not appear in this wake.',
    ].join('\n')
  }
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
