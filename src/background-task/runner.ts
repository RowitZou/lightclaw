import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import { getConfig } from '../config.js'
import { resolveUserConfig } from '../config/user-override.js'
import { t } from '../i18n/index.js'
import { getMemoryDir } from '../memory/auto-memory.js'
import { getProviderFor } from '../provider/index.js'
import { loadFileRules, loadIdentityRules } from '../permission/storage.js'
import { getAdmin, getUserPermissionCeiling } from '../identity/store.js'
import { loadIdentityPreferences } from '../identity/preferences.js'
import { userSessionsRoot, workspaceFor } from '../identity/paths.js'
import { query } from '../query.js'
import { getAgent, getMainRole } from '../agents/registry.js'
import { deriveCanUseTool, filterToolsByRoleVisibility } from '../agents/role-tool-gate.js'
import { runDispatchedAgent } from '../agents/dispatched-agent.js'
import { getChannelApproverFor } from '../channels/feishu/runner-registry.js'
import { getSignalRouter } from '../signal-bus/router.js'
import { getImageReadiness, getRuntimePool } from '../state.js'
import {
  RETRY_AFTER_CAP_MS,
  isBillingError,
  retryAfterMsOf,
} from '../transient-error.js'
import {
  createSessionContext,
  runWithSessionContext,
} from '../session-context.js'
import {
  appendMessages,
  getSessionDir,
  rewriteTranscript,
  touchMeta,
} from '../session/storage.js'
import { markStarted } from '../taskrun/store.js'
import { collectPartialArtifactPaths } from './partial-artifacts.js'
import type { BackgroundTaskEntry, FireOutcome, PermissionDenialDetail } from './types.js'

type QueryFn = typeof query
let queryImpl: QueryFn = query

export function setBackgroundTaskQueryForTest(impl: QueryFn | null): void {
  queryImpl = impl ?? query
}

export async function runBackgroundTaskFire(input: {
  task: BackgroundTaskEntry
  fireUuid: string
  signal: AbortSignal
  taskRunId?: string
}): Promise<FireOutcome> {
  const sessionId = buildBackgroundTaskSessionId(input.task, input.fireUuid)
  let retryAfterCapMs = RETRY_AFTER_CAP_MS
  try {
    await markTaskRunStartedBestEffort(input.taskRunId, input.task.ownerCanonicalUser, sessionId)
    if (input.signal.aborted) {
      return {
        kind: 'failure',
        reason: 'aborted',
        transient: true,
        attempt: 1,
      }
    }

    const baseConfig = getConfig()
    retryAfterCapMs = baseConfig.provider.retryAfterCapMs
    // PR4 config merge layer: fold the owner's per-user config (config.json
    // defaultModel / lang, back-compat preferences.json model) onto the admin
    // base. defaultModel may resolve to '' when neither owner nor admin has a
    // usable model — gated below before provider lookup so the fire never
    // throws `Unknown model`.
    const config = resolveUserConfig(input.task.ownerCanonicalUser, baseConfig)
    const prefs = loadIdentityPreferences(input.task.ownerCanonicalUser)
    if (!config.defaultModel) {
      return {
        kind: 'failure',
        reason: t('model.none.noticeBody'),
        transient: false,
        attempt: 1,
      }
    }
    const model = config.defaultModel
    const permissionMode = prefs.permissionMode ?? config.permissionMode
    const permissionCeiling = await getUserPermissionCeiling(input.task.ownerCanonicalUser)
    const cwd = path.resolve(workspaceFor(input.task.ownerCanonicalUser))
    await mkdir(cwd, { recursive: true, mode: 0o700 })

    if (config.runtime.backend === 'local') {
      const adminId = await getAdmin()
      if (adminId && adminId !== input.task.ownerCanonicalUser) {
        return {
          kind: 'failure',
          reason: `LocalRuntime is admin-only; user "${input.task.ownerCanonicalUser}" cannot run BackgroundTask.`,
          transient: false,
          attempt: 1,
        }
      }
    }

    const provider = getProviderFor(config, model).provider
    const { getAllTools, getEnabledTools } = await import('../tools.js')
    // Resolve the real worker Role from registry so all the role-driven
    // gates (BLOCKED_WORKER_TOOLS, FEISHU_RESERVED_TOOLS, role's own
    // `tools` allowlist, currentRole-driven memory L3 routing) act on the
    // worker the user actually scheduled — not a frankenstein with main's
    // tool surface. Fallback to `generalist` mirrors the bg-tasks store
    // loader's pre-PR5 migration default.
    const role = getAgent(input.task.role) ?? getAgent('generalist') ?? getMainRole()
    const tools = filterToolsByRoleVisibility(
      role,
      getEnabledTools(provider, getAllTools('feishu', { runtimeDriver: config.runtime.driver })),
    )
    // Docker backend requires the tracker; local / rlaunch ignore it. Pass it
    // unconditionally so a task fire under any backend gets a valid runtime —
    // missing this caused DockerRuntime to throw at acquire() and every fire
    // to fail-transient-then-disable on docker hosts.
    const tracker = config.runtime.backend === 'docker' ? getImageReadiness() : undefined
    const runtime = getRuntimePool().acquire(input.task.ownerCanonicalUser, config, cwd, tracker)
    const permissionDenials: PermissionDenialDetail[] = []
    const permissionApprover = await getChannelApproverFor(
      input.task.ownerCanonicalUser,
      sessionId,
    )
    const ctx = createSessionContext({
      cwd,
      model,
      config,
      sessionsDir: userSessionsRoot(input.task.ownerCanonicalUser),
      memoryDir: getMemoryDir(input.task.ownerCanonicalUser),
      currentUserId: input.task.ownerCanonicalUser,
      // No enabledSecrets: a background fire is a dispatched worker, and
      // runDispatchedAgent's childCtx strips secrets for every dispatched
      // stack (secrets are main-only — see dispatched-agent.ts). Loading them
      // here would be dead weight that misleadingly implies bg fires can use
      // them, when the childCtx that actually runs the agent loop clears it.
      sessionId,
      channel: 'feishu',
      // Carry the originating group's chat-grant target (captured at Dispatch
      // time) so FeishuCreateFile inside this fire grants the group `view`
      // instead of falling to bot-only ("chat":"skipped-not-group"). Undefined
      // for DM / off-channel origins, which correctly skip the chat grant.
      resourceGrantTarget: input.task.resourceGrantTarget,
      permissionMode,
      permissionCeiling,
      runtime,
      fileRules: loadFileRules({
        cwd,
        userPath: config.paths.permissionRules.user,
        projectPath: config.paths.permissionRules.project,
        localPath: config.paths.permissionRules.local,
      }),
      identityRules: loadIdentityRules(input.task.ownerCanonicalUser),
      // Null is expected during daemon startup/shutdown gaps or for users
      // without an active channel binding; permission/index.ts keeps the
      // old bg fallback only for that degraded case.
      permissionApprover,
      isBackgroundTask: true,
      onPermissionDenial(detail) {
        permissionDenials.push(detail)
      },
      currentTaskRunId: input.taskRunId,
    })

    const router = getSignalRouter()
    const chainSessionId = input.task.chainState?.path.at(-1)?.sessionId ?? sessionId
    if (input.task.chainState) {
      router.registerChainSession(
        input.task.chainState.chainId,
        chainSessionId,
        input.task.chainState,
        input.task.ownerCanonicalUser,
      )
    }
    const result = await runWithSessionContext(ctx, async () => {
      // Start each fire attempt from an empty transcript. The scheduler
      // reuses the same fireUuid (→ same sessionId) across transient
      // retries, so a prior attempt's incrementally-flushed partial must be
      // cleared before this attempt appends.
      await rewriteTranscript(sessionId, [])
      const output = await runDispatchedAgent({
        mode: 'bg',
        dispatchPrompt: buildBackgroundTaskFirePrompt(input.task),
        role,
        tools,
        config: {
          ...config,
          defaultModel: model,
        },
        // `deriveCanUseTool(role)` is the same gate dispatched workers use,
        // so BLOCKED_WORKER_TOOLS and FEISHU_RESERVED_TOOLS cover bg-fire too.
        canUseToolOverride: deriveCanUseTool(role),
        queryImpl,
        label: 'background_task',
        signal: input.signal,
        chainState: input.task.chainState,
        currentTaskRunId: input.taskRunId,
        canonicalUser: input.task.ownerCanonicalUser,
        // Incremental transcript persistence: flush each completed tool
        // round-trip as it lands so a crash mid-fire leaves a partial
        // bg-session transcript on disk instead of nothing.
        persistMessages: async batch => {
          await appendMessages(sessionId, batch)
        },
        // Resync after a mid-fire compaction rewrote the message prefix;
        // query.ts then resumes incremental appends from this baseline.
        rewriteMessages: async msgs => {
          await rewriteTranscript(sessionId, msgs)
        },
      })
      // Success path: incremental flushes already wrote the turns; this
      // final rewrite is the source of truth — it folds in a mid-run
      // compaction that stopped incremental flushing. On a crash
      // runDispatchedAgent throws before here and the partial stays on disk.
      await rewriteTranscript(sessionId, output.messages)
      await touchMeta(sessionId, output.messages.length)
      await output.forkTranscriptPersisted
      return output
    }).finally(() => {
      if (input.task.chainState) {
        router.unregisterChainSession(input.task.chainState.chainId, chainSessionId)
      }
    })

    if (permissionDenials.length > 0) {
      return {
        kind: 'failure',
        reason: 'permission denied',
        transient: false,
        attempt: 1,
        permissionDenials: dedupePermissionDenials(permissionDenials),
      }
    }

    return {
      // Hand the requester the worker's final reply only — not the full
      // narration join (result.finalText) — so a delegated worker's progress
      // chatter stays out of the requester's context (the delegation
      // context-firewall). Falls back to the full text only when the run
      // produced no final reply at all, so an empty hand-off never delivers "".
      kind: 'success',
      summary: result.finalReplyText || result.finalText || '(background task returned empty text)',
      transcriptPath: path.join(getSessionDir(sessionId), 'transcript.jsonl'),
    }
  } catch (error) {
    // The fire crashed / was aborted mid-run. The incremental persist callback
    // above flushed every completed tool round-trip to the bg-session
    // transcript, so recover the files the worker had already written and hand
    // them to the manager — a TTFB / idle abort otherwise throws away the
    // partial work with nothing but the error string. Kept out of `reason` so
    // the scheduler's abort classifier (which pattern-matches `reason`) stays
    // exact; the scheduler folds these into the result text on the failure
    // path. Best-effort: a missing/torn transcript yields none.
    const partialArtifacts = await collectPartialArtifactPaths(sessionId).catch(
      () => [],
    )
    const retryAfterMs = retryAfterMsOf(error, retryAfterCapMs)
    return {
      kind: 'failure',
      reason: error instanceof Error ? error.message : String(error),
      transient: isTransientFireError(error),
      attempt: 1,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      ...(partialArtifacts.length ? { partialArtifacts } : {}),
    }
  }
}

async function markTaskRunStartedBestEffort(
  taskRunId: string | undefined,
  ownerCanonicalUser: string,
  sessionId: string,
): Promise<void> {
  if (!taskRunId) return
  try {
    await markStarted(taskRunId, sessionId, Date.now(), ownerCanonicalUser)
  } catch (error) {
    process.stderr.write(
      `[taskrun] failed to mark background run ${taskRunId} started: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
  }
}

function dedupePermissionDenials(
  denials: PermissionDenialDetail[],
): PermissionDenialDetail[] {
  const seen = new Set<string>()
  const out: PermissionDenialDetail[] = []
  for (const denial of denials) {
    const key = `${denial.toolName}\n${denial.inputPreview}\n${denial.suggestedRules.join('\n')}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    out.push(denial)
  }
  return out
}

export function buildBackgroundTaskSessionId(
  task: BackgroundTaskEntry,
  fireUuid: string,
): string {
  const taskId = task.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)
  const fireId = fireUuid.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48)
  return `bg-${task.ownerCanonicalUser}-${taskId}-${fireId}`
}

// Wrap task.prompt in a fire envelope so the fresh subagent knows it is the
// scheduled execution agent and not a normal chat turn. Without this envelope,
// prompts phrased as "when the time comes do X" / "到时间后 X" leak the
// scheduling tense into the executor and the agent reads them as a request to
// schedule a future event instead of doing the work. The envelope's ONLY job
// is this scheduling-tense correction — it deliberately says nothing about
// whether to ask / escalate when blocked: that belongs to the skill, the
// dispatch_brief, and the role prompt, which encode "ask upward with a safe
// default". Do NOT re-add a blanket "do not ask the user / use reasonable
// defaults" line here — that wake-era wording (cloned from the deleted
// buildWakePrompt) overrode the escalation model and was removed 2026-06-26.
// Stays English on purpose because it is an LLM system instruction, not
// user-visible display.
export function buildBackgroundTaskFirePrompt(task: BackgroundTaskEntry): string {
  return [
    '<background-task-fire>',
    `<label>${task.label}</label>`,
    `<task-id>${task.id}</task-id>`,
    `<fired-at>${new Date().toISOString()}</fired-at>`,
    '<instruction>',
    task.prompt,
    '</instruction>',
    '</background-task-fire>',
    '',
    'The instruction above is firing now — its scheduled time has arrived, so carry it out immediately and produce the result.',
    'Do not read it as a future event or schedule a new task to carry it out later.',
  ].join('\n')
}

function isTransientFireError(error: unknown): boolean {
  if (isBillingError(error)) {
    return false
  }
  const detail = error instanceof Error ? error.message : String(error)
  return /ECONNRESET|ECONNABORTED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|network|rate.?limit|429|timeout/i
    .test(detail)
}
