import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import { getConfig } from '../config.js'
import { resolveUserConfig } from '../config/user-override.js'
import { applyCredentialDegrade } from '../model-resolution.js'
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
  const baseConfig = getConfig()
  const prefs = loadIdentityPreferences(ownerCanonicalUser)
  const config = resolveUserConfig(ownerCanonicalUser, {
    ...baseConfig,
    ...(prefs.model ? { defaultModel: prefs.model } : {}),
    ...(prefs.permissionMode ? { permissionMode: prefs.permissionMode } : {}),
  })
  const model = applyCredentialDegrade(config.defaultModel, config)
  const permissionMode = config.permissionMode
  const permissionCeiling = await getUserPermissionCeiling(ownerCanonicalUser)
  const cwd = path.resolve(workspaceFor(ownerCanonicalUser))
  await mkdir(cwd, { recursive: true, mode: 0o700 })
  const tracker = config.runtime.backend === 'docker' ? getImageReadiness() : undefined
  const runtime = getRuntimePool().acquire(ownerCanonicalUser, config, cwd, tracker)
  const sessionId = `taskrun-resume-driver-${runId}`
  const permissionApprover = await getChannelApproverFor(ownerCanonicalUser, sessionId)
  return createSessionContext({
    config,
    cwd,
    model,
    sessionsDir: userSessionsRoot(ownerCanonicalUser),
    memoryDir: getMemoryDir(ownerCanonicalUser, config),
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
