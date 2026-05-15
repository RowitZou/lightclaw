import type { Dirent } from 'node:fs'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { createMainAgentCanUseTool } from '../agents/main-agent-can-use-tool.js'
import { channelInvocationContext } from '../agents/invocation-context.js'
import { getMainRole } from '../agents/registry.js'
import { channelSessionLock } from '../channels/session-lock.js'
import { parseFeishuSessionId } from '../channels/feishu/routing.js'
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
 * Resolve the FALLBACK wake-target sessionId for a canonical user — the
 * most-recently-active feishu DM session belonging to that user. Returns null
 * when no DM session is on disk; caller falls back to the user-card path
 * rather than fabricating a session id (the pre-Phase-26 `feishu-<canonical>`
 * format silently created an orphan transcript that did not lock against the
 * user's real DM session, breaking turn-level FIFO).
 *
 * This is the FALLBACK only. Bug 15 (2026-05-12) added
 * `resolveOriginWakeSessionId` which is preferred when the task carries an
 * `originSessionId` pointing to a still-existing transcript — that path keeps
 * the wake agent in the chat the task was created from (group or DM) so the
 * model inherits the conversation that motivated the task.
 *
 * Why DM-only for the fallback:
 *   - When the task has no origin (legacy pre-Bug-15 entries) or the origin
 *     transcript has been deleted, "most-recent DM" is the safest landing
 *     because it's the user's stable channel.
 *   - Group sessions in Phase 26 are sender-specific; without an explicit
 *     origin link there's no principled way to pick a group, and the privacy
 *     boundary (do not leak task content into a group transcript that other
 *     members may share) defaults to DM.
 *   - This fallback only ever resolves to a DM session, so its
 *     `deliverWakeNotification` always lands in DM anyway. Origin-aware
 *     group delivery only happens when `resolveOriginWakeSessionId`
 *     supplied a group `wakeSessionId`.
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

/**
 * Resolve the origin-preference wake target. Returns the originSessionId iff:
 *   - it parses to a Feishu sessionId (`feishu:dm:` or `feishu:group:` prefix)
 *   - a transcript directory + readable meta.json exists at that path
 *
 * Returns null when origin is unusable, so the scheduler can fall back to the
 * legacy `resolveWakeSessionId` (most-recent DM). We do NOT require meta.userId
 * to match canonicalUser here: the sessionId formula already encodes ownership
 * (DM chat_id is per-user; group session id encodes senderOpenId which the
 * pairing pipeline ties to canonical user), and origin was captured under the
 * task owner's ALS scope at create time. Re-validating via meta would block
 * legitimate wakes on cosmetic meta drift (e.g. transcript moved between
 * canonical names during identity merge).
 *
 * Terminal-origin tasks (e.g. admin scheduled via REPL) return null here and
 * fall through to DM fallback — wake mode is Feishu-only because notify_user
 * delivery requires a feishu open_id. This matches the pre-Bug-15 behavior
 * for that subset of tasks.
 */
export async function resolveOriginWakeSessionId(
  originSessionId: string,
  sessionsDir: string,
): Promise<string | null> {
  if (!originSessionId.startsWith('feishu:dm:') && !originSessionId.startsWith('feishu:group:')) {
    return null
  }
  const meta = await readMetaFromDir(sessionsDir, originSessionId)
  if (!meta) {
    return null
  }
  return originSessionId
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
  /** Resolved by caller via `resolveOriginWakeSessionId` (preferred) or
   *  `resolveWakeSessionId` (fallback). Must be a real on-disk Feishu session
   *  id (`feishu:dm:<chatId>` or `feishu:group:<chatId>[:<threadId>]:<senderOpenId>`).
   *  Bug 15: group sessions are now accepted so notify_to:'agent' wakes land
   *  back in the chat the task was created from, inheriting that chat's
   *  conversation context. The pre-Phase-26 hard-coded `feishu-<canonical>`
   *  form is rejected here as defense-in-depth. `deliverWakeNotification`
   *  routes the user-facing notify_user output to the same chat this
   *  sessionId names — group-origin lands in the origin group, DM-origin
   *  lands in DM. */
  mainSessionId: string
  task: BackgroundTaskEntry
  outcome: FireOutcome
  /** Read-and-cleared by scheduler.deliverCompletion from
   *  task.pendingPriorPromptNotice. When present, the wake prompt surfaces
   *  the prior prompt once so the wake agent can sanity-check the new prompt
   *  before deciding whether to notify the user. Cleared on disk before this
   *  function runs, so subsequent fires won't re-display it. */
  priorPromptNotice?: string
}): Promise<WakeNotifyResult> {
  const { mainSessionId } = input
  if (!mainSessionId.startsWith('feishu:dm:') && !mainSessionId.startsWith('feishu:group:')) {
    process.stderr.write(
      `[background-task] wake refused: mainSessionId "${mainSessionId}" is not a Phase 26 Feishu session id (expected feishu:dm: or feishu:group: prefix)\n`,
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
        ...createUserMessage(
          buildWakePrompt(input.task, input.outcome, input.priorPromptNotice),
          lastUuid(messages),
        ),
        origin: 'bg-task-wake' as const,
      }
      messages.push(userMessage)
      await appendMessage(mainSessionId, userMessage)
      const provider = getProvider(config)
      const wakeNotifications: WakeNotifyResult[] = []
      const { notifyUserTool, staySilentTool } = await import('../tools/background-task.js')
      const result = await query({
        role: getMainRole(),
        invocation: channelInvocationContext({
          canUseTool: createMainAgentCanUseTool('wake', getMainRole()),
          wakeNotifications,
        }),
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

/**
 * Deliver a wake-mode `notify_user` decision back to the chat the
 * BackgroundTask was created from.
 *
 * Routing follows `wakeSessionId` — the session the wake `query()` actually
 * ran on (origin-preferred via `resolveOriginWakeSessionId`, else the
 * most-recent-DM fallback):
 *   - group-origin → push to the origin group's chat_id, so the result
 *     rejoins the conversation that motivated the task. `notify_to:'user'`
 *     tasks never reach the wake path (they go through the completion-card
 *     coordinator), so a group landing here is always a BackgroundTask the
 *     user explicitly scheduled in that group — delivering back to it is the
 *     expected behavior, not a privacy leak.
 *   - DM-origin, or `wakeSessionId` that does not parse to a Feishu session
 *     (terminal-origin task, or a deleted origin transcript that fell back to
 *     most-recent DM) → push to the owner's DM open_id.
 *
 * `notify_to:'user'` is the path that stays DM-only; that contract is
 * unchanged and lives in the completion-card coordinator, not here.
 */
export async function deliverWakeNotification(input: {
  wakeSessionId: string
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
  const text = `🔔 ${input.taskLabel}\n\n${input.result.text}`
  const parsed = parseFeishuSessionId(input.wakeSessionId)
  if (parsed?.kind === 'group') {
    // topic-group threadId is intentionally not addressed separately —
    // im.message.create cannot target a thread without a reply anchor, so
    // the notification lands in the parent group chat.
    await sender.sendMarkdownTextToChatId(parsed.chatId, text)
    return
  }
  await sender.sendMarkdownTextToOpenId(input.ownerOpenId, text)
}

export function buildWakePrompt(
  task: BackgroundTaskEntry,
  outcome: FireOutcome,
  priorPromptNotice?: string,
): string {
  const resultText = outcome.kind === 'success'
    ? outcome.summary
    : `FAILED: ${outcome.reason}`
  const promptChangeBlock = priorPromptNotice
    ? [
        '<prompt-change-notice>',
        '  The user updated this task\'s prompt before this fire. Prior prompt:',
        `  <prior>${priorPromptNotice}</prior>`,
        '  The current (executed) prompt is shown in <task-prompt> below.',
        `  <task-prompt>${task.prompt}</task-prompt>`,
        '</prompt-change-notice>',
        '',
      ]
    : []
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
      ...promptChangeBlock,
      'This BackgroundTask fire was denied because the listed tools are not in the task allowed_tools.',
      'Decide now:',
      `  (a) If the suggested rules fit the task purpose, call UpdateBackgroundTask({ id: '${task.id}', allowed_tools: [the merged full list] }). For a oneshot that already fired, this will trigger an immediate retry. Then call stay_silent({reason}).`,
      `  (b) If the task is wrong or runaway, call CancelBackgroundTask({ id: '${task.id}' }) and notify_user({text}) with a brief explanation.`,
      '  (c) If the suggested rules look unrelated or suspicious, call notify_user({text}) and explain what you saw.',
      '',
      'If you call stay_silent without updating allowed_tools, the task remains broken and will likely fail again.',
      'High-risk patterns such as rm/dd/sudo are routed directly to the user approval card and should not appear in this wake.',
      'notify_user delivery: your notify_user({text}) is delivered by the framework back to the chat this BackgroundTask was created from — the DM if it was scheduled in a DM, or the origin group if it was scheduled there. It is sent exactly once; do not also reply in this chat yourself after calling notify_user.',
    ].join('\n')
  }
  return [
    '<background-task-fire>',
    `<label>${task.label}</label>`,
    `<task-id>${task.id}</task-id>`,
    `<outcome>${resultText}</outcome>`,
    '</background-task-fire>',
    '',
    ...promptChangeBlock,
    'This is a wake from a scheduled BackgroundTask.',
    'Decide whether to disturb the user.',
    'Use notify_user({text}) to send a message, or stay_silent({reason}) to end without notifying.',
    'notify_user delivery: your notify_user({text}) is pushed to the user as a private DM markdown — it does NOT echo into the chat this wake is running in. So even if this wake is running in a group session for context, calling notify_user does not leak to the group; you do not need to "also reply in this chat" after notify_user.',
  ].join('\n')
}

function lastUuid(messages: Array<{ uuid: string }>): string | null {
  return messages.length > 0 ? messages[messages.length - 1]?.uuid ?? null : null
}
