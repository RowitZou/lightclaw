import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import { getConfig } from '../config.js'
import { resolveUserConfig } from '../config/user-override.js'
import { getMemoryDir } from '../memory/auto-memory.js'
import { loadFileRules, loadIdentityRules } from '../permission/storage.js'
import { getUserPermissionCeiling } from '../identity/store.js'
import { loadIdentityPreferences } from '../identity/preferences.js'
import { userSessionsRoot, workspaceFor } from '../identity/paths.js'
import { getChannelApproverFor } from '../channels/feishu/runner-registry.js'
import { getImageReadiness, getRuntimePool } from '../state.js'
import {
  createSessionContext,
  getCurrentSessionContext,
  runWithSessionContext,
  type SessionContext,
} from '../session-context.js'
import { resumeRunWithBlock, type ResumeRunBlock, type ResumeRunResult } from './resume.js'

type ResumeRunner = typeof resumeRunWithBlock

let resumeRunnerImpl: ResumeRunner = resumeRunWithBlock

export function setResumeRunnerForTest(impl: ResumeRunner | null): void {
  resumeRunnerImpl = impl ?? resumeRunWithBlock
}

// Per-run promise chain: a run's resumes execute strictly in arrival order,
// while different runs proceed independently. Detachment is the point — a
// shift can take minutes, and the scheduling caller (a tool call, a fire
// completion, a watchdog tick) must never sit inside it: an inline await
// would re-create the frozen-caller shape that retiring blocking dispatch
// just removed.
const chainByRun = new Map<string, Promise<void>>()
const pending = new Set<Promise<void>>()
const lastFailureByRun = new Map<string, string>()

export function getLastResumeFailure(runId: string): string | undefined {
  return lastFailureByRun.get(runId)
}

export function isResumePending(runId: string): boolean {
  return chainByRun.has(runId)
}

export function resetResumeScheduleForTest(): void {
  chainByRun.clear()
  pending.clear()
  lastFailureByRun.clear()
  resumeRunnerImpl = resumeRunWithBlock
}

export function scheduleResumeRunWithBlock(
  ownerCanonicalUser: string,
  runId: string,
  block: ResumeRunBlock,
): void {
  const ambient = getCurrentSessionContext()
  const prior = chainByRun.get(runId) ?? Promise.resolve()
  const task = prior.then(async () => {
    try {
      // Only the real runner needs a SessionContext; a test stub must not
      // drag the full config/runtime resolution into unit tests.
      const result = ambient
        ? await runWithSessionContext(
            { ...ambient },
            async () => resumeRunnerImpl(runId, block, ownerCanonicalUser),
          )
        : resumeRunnerImpl === resumeRunWithBlock
          ? await runResumeWithOwnerContext(ownerCanonicalUser, runId, block)
          : await resumeRunnerImpl(runId, block, ownerCanonicalUser)
      if (result.ok) {
        lastFailureByRun.delete(runId)
      } else if (result.reason === 'terminal') {
        // The run settled between scheduling and execution — the wake had
        // nothing left to wake. Not a failure: recording it would raise a
        // dead-wake-source finding about a run nobody is waiting on, and the
        // finding's own remedy (settle it) already happened.
        process.stderr.write(
          `[taskrun-resume] scheduled resume skipped for ${runId}: ${result.message}\n`,
        )
      } else if (result.reason === 'model-quarantined') {
        // Not a resume failure — the owner's model is known-dead (quota /
        // auth) and the shift was deferred before touching the ledger.
        // Deliberately do NOT record it in lastFailureByRun: that map feeds
        // the watchdog's dead-wake-source findings, and a quarantine defer
        // must read as "no new information, retry on a later reconcile
        // tick", not as a dead wake that escalates to main.
        process.stderr.write(
          `[taskrun-resume] scheduled resume deferred for ${runId}: ${result.message}\n`,
        )
      } else {
        lastFailureByRun.set(runId, result.reason)
        process.stderr.write(
          `[taskrun-resume] scheduled resume failed for ${runId}: ${result.message}\n`,
        )
      }
    } catch (error) {
      lastFailureByRun.set(runId, 'query-failed')
      process.stderr.write(
        `[taskrun-resume] scheduled resume threw for ${runId}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      )
    }
  })
  chainByRun.set(runId, task)
  pending.add(task)
  void task.finally(() => {
    pending.delete(task)
    if (chainByRun.get(runId) === task) chainByRun.delete(runId)
  })
}

/** Arm the in-process half of a declared timer wake. Promptness only: the
 *  durable half is the watchdog's level-triggered due-wake sweep, which re-arms
 *  from the ledger after a daemon restart. */
export function armTaskRunTimerWake(owner: string, runId: string, at: number): void {
  const delay = Math.max(0, at - Date.now())
  setTimeout(() => {
    void fireTaskRunTimerWake(owner, runId, at)
  }, delay).unref?.()
}

/** Fire a timer wake IF it is still the run's live one. The armed timer is
 *  edge-triggered and cannot be cancelled (no handle is kept, and the ledger —
 *  not memory — owns the wait), so by fire time the wake it was armed for may
 *  have been superseded: consumed by an earlier message / answer / watchdog
 *  resume, replaced by a re-declared wait, or made moot by the run settling.
 *  Re-reading the ledger here makes the in-process path level-triggered like
 *  the watchdog's, which is what keeps a stale timer from starting a second
 *  shift on a run that already moved on (2026-08-14 prod: a wake armed at 08:07
 *  fired into a run that had been cancelled, restarting a zombie worker). */
export async function fireTaskRunTimerWake(
  owner: string,
  runId: string,
  at: number,
): Promise<'scheduled' | 'stale'> {
  const { getTaskRun } = await import('./store.js')
  const run = await getTaskRun(runId, owner)
  const wake = run?.wake
  const live = run !== null &&
    run.status === 'waiting' &&
    wake?.kind === 'timer' &&
    wake.at === at &&
    wake.consumed !== true
  if (!live) return 'stale'
  scheduleResumeRunWithBlock(owner, runId, {
    via: 'timer',
    reason: 'your declared timer fired',
    body: '<taskrun-timer-wake />\nYour timer wake fired. Check what you were waiting for; if it needs more time, declare a new wait — do not hold the turn open to watch it.',
  })
  return 'scheduled'
}

/** Test seam: await every resume scheduled so far (including ones scheduled
 *  by the awaited resumes themselves). */
export async function drainScheduledResumesForTest(): Promise<void> {
  while (pending.size > 0) {
    await Promise.all([...pending])
  }
}

async function runResumeWithOwnerContext(
  ownerCanonicalUser: string,
  runId: string,
  block: ResumeRunBlock,
): Promise<ResumeRunResult> {
  const ctx = await buildOwnerResumeContext(ownerCanonicalUser, runId)
  return runWithSessionContext(ctx, async () => resumeRunnerImpl(runId, block, ownerCanonicalUser))
}

/** Driver context for resumes scheduled outside any session (scheduler fire
 *  completions, watchdog re-arms after a daemon restart). Mirrors the
 *  resolution `runBackgroundTaskFire` does for a fire — resumed shifts are
 *  dispatched workers and get the same per-user cwd / runtime / permission
 *  surface. The resumed run forks its own child context on top of this. */
async function buildOwnerResumeContext(
  ownerCanonicalUser: string,
  runId: string,
): Promise<SessionContext> {
  // Fold the owner's per-user BYO registry onto the admin base — same as
  // runBackgroundTaskFire. Without it a BYO-only deployment resolves an empty
  // model here AND seeds the driver context with a config snapshot that has no
  // models, so every getSessionConfig()-driven sub-LLM (compaction /
  // session-memory / imageRead) in the resumed turn would fail to resolve a
  // model. resolveUserConfig is an idempotent union merge.
  const config = resolveUserConfig(ownerCanonicalUser, getConfig())
  const prefs = loadIdentityPreferences(ownerCanonicalUser)
  // Model comes straight from the resolved config: resolveUserConfig already
  // folds prefs.model (back-compat) INTO defaultModel with a registry-
  // membership guard, so re-applying the raw preference here would bypass
  // that guard AND shadow a config.json defaultModel choice — the bg fire
  // path (background-task/runner.ts) reads config.defaultModel the same way
  // (review §3.11d, the "resume 半接" family).
  const model = config.defaultModel
  const permissionMode = prefs.permissionMode ?? config.permissionMode
  const permissionCeiling = await getUserPermissionCeiling(ownerCanonicalUser)
  const cwd = path.resolve(workspaceFor(ownerCanonicalUser))
  await mkdir(cwd, { recursive: true, mode: 0o700 })
  const tracker = config.runtime.backend === 'docker' ? getImageReadiness() : undefined
  const runtime = getRuntimePool().acquire(ownerCanonicalUser, config, cwd, tracker)
  const sessionId = `taskrun-resume-driver-${runId}`
  const permissionApprover = await getChannelApproverFor(ownerCanonicalUser, sessionId)
  return createSessionContext({
    cwd,
    model,
    config,
    sessionsDir: userSessionsRoot(ownerCanonicalUser),
    memoryDir: getMemoryDir(ownerCanonicalUser),
    currentUserId: ownerCanonicalUser,
    sessionId,
    channel: 'feishu',
    permissionMode,
    permissionCeiling,
    runtime,
    fileRules: loadFileRules({
      cwd,
      userPath: config.paths.permissionRules.user,
      projectPath: config.paths.permissionRules.project,
      localPath: config.paths.permissionRules.local,
    }),
    identityRules: loadIdentityRules(ownerCanonicalUser),
    permissionApprover,
    isBackgroundTask: true,
  })
}
