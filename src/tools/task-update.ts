import { z } from 'zod'

import {
  appendCompletedTaskRecord,
  getBackgroundTask,
  getCompletedTaskRecord,
  loadBackgroundTasks,
  removeBackgroundTask,
} from '../background-task/store.js'
import { notifyBackgroundTaskChanged } from '../background-task/scheduler.js'
import type { BackgroundTaskEntry } from '../background-task/types.js'
import {
  appendCheckpoint,
  acceptTaskRun,
  closeRootTaskRun,
  getTaskRun,
  markCancelled,
  markDelivered,
  markPaused,
  rejectTaskRun,
} from '../taskrun/store.js'
import { wakeParentForChildJoinBestEffort } from '../taskrun/resume.js'
import { scheduleResumeRunWithBlock } from '../taskrun/resume-schedule.js'
import { abortInFlightForSession, getCurrentRole, getCurrentTaskRunId, getSessionId, requireCurrentUserId } from '../state.js'
import { buildTool } from '../tool.js'
import type { TaskRunMeta } from '../taskrun/types.js'

const TASK_UPDATE_DESCRIPTION = [
  'Change a TaskRun state: deliver your own run, pause work, cancel work, or settle (accept / reject) a delivered child run.',
  '',
  "action='deliver' — conclude your own run. Without runId it targets your current run: records your outcome (ok + summary) and parks it at delivered, awaiting your requester's verdict. With a root runId (orchestrator) it declares the root delivered; the close is refused with an itemized list while the root still has open obligations — settle each, then retry.",
  "action='accept' — verdict on a delivered run you dispatched: closes it per its delivered outcome.",
  "action='reject' — requires feedback; records it and resumes the delivered run with that feedback.",
  "action='pause' — without runId, pause your own run with a checkpoint and wake rule; with runId, pause a running direct child.",
  "action='cancel' — cancel work you own by TaskRun runId. Orchestrator may cancel runs inside this user's rooted trees; workers may cancel direct children. Queued / paused runs are marked cancelled; running runs are hard-aborted before cancellation. A standing service root runId shuts down the whole service. A dispatch entry id is accepted for one compatibility window and is resolved to its backing run.",
].join('\n')

function describeObligationStatus(meta: TaskRunMeta): string {
  if (meta.status === 'delivered') return 'delivered, awaiting acceptance'
  if (meta.status === 'queued') return 'scheduled, not fired yet'
  return meta.status
}

/** If a standing-service entry is gone while one of its fires is parked at
 *  delivered, the verdict settling that child is the natural revisit: once no
 *  live dispatch entry backs the root, retry the gated close — it succeeds
 *  exactly when the last obligation settles. */
async function closeOrphanStandingRootBestEffort(
  owner: string,
  rootRunId: string,
): Promise<void> {
  try {
    const root = await getTaskRun(rootRunId, owner)
    if (root?.standing !== true) return
    if (root.status === 'done' || root.status === 'failed' || root.status === 'cancelled') return
    if (loadBackgroundTasks(owner).some(entry => entry.standingRootRunId === rootRunId)) return
    await closeRootTaskRun(rootRunId, owner)
  } catch (error) {
    process.stderr.write(
      `[taskrun] failed to close orphan standing root ${rootRunId}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
  }
}

function taskCallerSession(task: BackgroundTaskEntry): string | undefined {
  return task.callerSessionId ?? task.originSessionId
}

function taskCallerRole(task: BackgroundTaskEntry): string {
  return task.callerRole ?? 'main'
}

function currentCallerMayManageDispatch(task: BackgroundTaskEntry): boolean {
  const role = getCurrentRole()
  if (!role || role.kind === 'orchestrator') return true
  return taskCallerSession(task) === getSessionId()
}

function isTerminalTaskRun(meta: TaskRunMeta): boolean {
  return meta.status === 'done' || meta.status === 'failed' || meta.status === 'cancelled'
}

function findBackingDispatches(owner: string, runId: string): BackgroundTaskEntry[] {
  return loadBackgroundTasks(owner).filter(entry =>
    entry.taskRunId === runId || entry.standingRootRunId === runId,
  )
}

async function resolveCancelTarget(
  owner: string,
  runIdOrDispatchId: string,
): Promise<
  | { ok: true; run: TaskRunMeta; compatibilityDispatchId?: string }
  | { ok: false; output: string; isError?: true }
> {
  const direct = await getTaskRun(runIdOrDispatchId, owner)
  if (direct) return { ok: true, run: direct }

  const entry = getBackgroundTask(owner, runIdOrDispatchId)
  if (entry) {
    if (!currentCallerMayManageDispatch(entry)) {
      return {
        ok: false,
        output: `Dispatch ${runIdOrDispatchId} was created by ${taskCallerRole(entry)} in a different session and is outside your scope. Cancel only TaskRuns you own; report it back to your requester instead of retrying.`,
        isError: true,
      }
    }
    const targetRunId = entry.standingRootRunId ?? entry.taskRunId
    if (!targetRunId) {
      return {
        ok: false,
        output: `Dispatch ${runIdOrDispatchId} has no backing TaskRun to cancel.`,
        isError: true,
      }
    }
    const run = await getTaskRun(targetRunId, owner)
    if (!run) {
      return {
        ok: false,
        output: `Dispatch ${runIdOrDispatchId} points to missing TaskRun ${targetRunId}.`,
        isError: true,
      }
    }
    return { ok: true, run, compatibilityDispatchId: runIdOrDispatchId }
  }

  const prior = getCompletedTaskRecord(owner, runIdOrDispatchId)
  if (prior) {
    const verb = prior.outcome === 'cancelled' ? 'cancelled' : 'finished'
    return {
      ok: false,
      output: `Dispatch ${runIdOrDispatchId} already ${verb} at ${prior.completedAt}. Cancel is a no-op.`,
    }
  }

  return { ok: false, output: `TaskRun not found: ${runIdOrDispatchId}`, isError: true }
}

async function cancelDispatchEntry(owner: string, entry: BackgroundTaskEntry): Promise<void> {
  if (removeBackgroundTask(owner, entry.id)) {
    notifyBackgroundTaskChanged(owner, entry.id)
    appendCompletedTaskRecord(owner, {
      id: entry.id,
      outcome: 'cancelled',
      completedAt: new Date().toISOString(),
    })
  }
}

export const taskUpdateTool = buildTool({
  name: 'TaskUpdate',
  whenToUse: `Move a TaskRun through its state machine — deliver your own run, or accept / reject a delivered child run.`,
  shouldDefer: true,
  description: TASK_UPDATE_DESCRIPTION,
  searchHint: 'taskrun state deliver accept reject settle close verdict 交付 验收 打回 关单 工单',
  domain: 'host',
  riskLevel: 'safe',
  inputSchema: z.object({
    runId: z.string().min(1).optional(),
    action: z.enum(['deliver', 'accept', 'reject', 'cancel', 'pause']),
    ok: z.boolean().optional(),
    summary: z.string().min(1).optional(),
    feedback: z.string().min(1).optional(),
    checkpoint: z.string().min(1).max(8192).optional(),
    wake: z.union([
      z.object({
        kind: z.literal('child-join'),
        runId: z.string().min(1),
      }),
      z.object({
        kind: z.literal('timer'),
        afterMinutes: z.number().int().min(1).max(7 * 24 * 60),
      }),
    ]).optional(),
  }),
  async call(input) {
    const owner = requireCurrentUserId()
    const role = getCurrentRole()
    const byRole = role?.agentType ?? 'main'
    const isOrchestrator = role?.kind === 'orchestrator'

    if (input.action === 'deliver') {
      if (isOrchestrator) {
        // Orchestrator delivery targets a root: close-with-settled-ledger.
        if (!input.runId) {
          return {
            output: 'Delivering as orchestrator requires `runId` of the root TaskRun to close.',
            isError: true,
          }
        }
        const result = await closeRootTaskRun(input.runId, owner)
        if (result.closed) {
          return {
            output: JSON.stringify({ runId: result.meta.id, status: result.meta.status }),
          }
        }
        if (result.reason !== 'open-obligations') {
          if (result.reason === 'not-found') {
            return { output: `TaskRun not found: ${input.runId}`, isError: true }
          }
          if (result.reason === 'not-root') {
            return { output: `TaskRun ${input.runId} is not a root TaskRun.`, isError: true }
          }
          return { output: `Root TaskRun ${input.runId} is already closed.` }
        }
        const lines = [
          `Root TaskRun ${input.runId} still has unsettled obligations:`,
          ...result.obligations.openRuns.map(run =>
            `- ${run.id} [${describeObligationStatus(run)}] ${run.role} — ${run.title}`,
          ),
          ...result.obligations.pendingDispatchIds.map(id =>
            `- dispatch ${id} [scheduled, not fired yet]`,
          ),
          '',
          'Settle each first: TaskUpdate accept/reject delivered runs, TaskUpdate cancel scheduled/running work you no longer want, or wait for running work to deliver. Then retry.',
        ]
        return { output: lines.join('\n'), isError: true }
      }

      // Worker delivery targets its own current run only.
      const own = getCurrentTaskRunId()
      if (!own) {
        return { output: 'No current TaskRun to deliver.', isError: true }
      }
      if (input.runId && input.runId !== own) {
        return {
          output: `deliver applies to your own run only (${own}); it cannot target ${input.runId}.`,
          isError: true,
        }
      }
      const meta = await getTaskRun(own, owner)
      if (!meta) {
        return { output: `TaskRun not found: ${own}`, isError: true }
      }
      if (meta.status === 'delivered') {
        return { output: `TaskRun ${own} is already delivered.`, isError: true }
      }
      if (meta.status === 'done' || meta.status === 'failed' || meta.status === 'cancelled') {
        return { output: `TaskRun ${own} is already ${meta.status}.`, isError: true }
      }
      const delivered = await markDelivered(
        own,
        {
          ok: input.ok ?? true,
          ...(input.summary ? { summary: input.summary.slice(0, 500) } : {}),
        },
        Date.now(),
        owner,
      )
      if (!delivered) {
        return { output: `TaskRun ${own} could not be delivered.`, isError: true }
      }
      await wakeParentForChildJoinBestEffort(owner, delivered)
      return { output: JSON.stringify({ runId: delivered.id, status: delivered.status }) }
    }

    if (input.action === 'pause') {
      if (input.runId) {
        const target = await getTaskRun(input.runId, owner)
        if (!target) return { output: `TaskRun not found: ${input.runId}`, isError: true }
        if (target.status !== 'running' || !target.currentSessionId) {
          return { output: `TaskRun ${input.runId} is ${target.status}, not a running run.`, isError: true }
        }
        if (isOrchestrator) {
          const root = await getTaskRun(target.rootRunId, owner)
          if (!root || (root.kind ?? 'dispatch') !== 'root') {
            return { output: `TaskRun ${input.runId} is not inside one of your rooted task trees.`, isError: true }
          }
        } else {
          const own = getCurrentTaskRunId()
          if (!own || target.parentRunId !== own) {
            return { output: `TaskRun ${input.runId} is not a direct child of your current run.`, isError: true }
          }
        }
        abortInFlightForSession(target.currentSessionId)
        const paused = await markPaused(
          target.id,
          { reason: 'requester-pause', bySessionId: getSessionId() },
          Date.now(),
          owner,
        )
        return paused?.status === 'paused'
          ? { output: JSON.stringify({ runId: paused.id, status: paused.status, reason: paused.pauseReason }) }
          : { output: `TaskRun ${target.id} could not be paused.`, isError: true }
      }

      const own = getCurrentTaskRunId()
      if (!own) return { output: 'No current TaskRun to pause.', isError: true }
      const checkpoint = input.checkpoint?.trim()
      if (!checkpoint) return { output: 'pause requires `checkpoint` so the run can be resumed safely.', isError: true }
      if (!input.wake) return { output: 'pause requires `wake` (child-join or timer).', isError: true }
      const meta = await getTaskRun(own, owner)
      if (!meta) return { output: `TaskRun not found: ${own}`, isError: true }
      if (meta.status !== 'running') {
        return { output: `TaskRun ${own} is ${meta.status}, not running.`, isError: true }
      }
      await appendCheckpoint(own, checkpoint, Date.now(), owner)
      const wake = input.wake.kind === 'child-join'
        ? { kind: 'child-join' as const, runId: input.wake.runId }
        : { kind: 'timer' as const, at: Date.now() + input.wake.afterMinutes * 60_000 }
      const paused = await markPaused(
        own,
        {
          reason: input.wake.kind,
          wake,
        },
        Date.now(),
        owner,
      )
      if (paused?.status !== 'paused') {
        return { output: `TaskRun ${own} could not be paused.`, isError: true }
      }
      if (wake.kind === 'timer') {
        scheduleTaskRunTimerWake(owner, paused.id, wake.at)
      }
      return {
        output: `${JSON.stringify({ runId: paused.id, status: paused.status, wake })}\nPause recorded. End your turn now — the framework resumes this run when the wake fires, injecting what arrived.`,
      }
    }

    if (input.action === 'cancel') {
      if (!input.runId) {
        return { output: 'cancel requires `runId` of the TaskRun to cancel.', isError: true }
      }
      const resolved = await resolveCancelTarget(owner, input.runId)
      if (!resolved.ok) {
        return {
          output: resolved.output,
          ...(resolved.isError ? { isError: true } : {}),
        }
      }
      const target = resolved.run
      if (isTerminalTaskRun(target)) {
        return { output: `TaskRun ${target.id} is already ${target.status}. Cancel is a no-op.` }
      }
      if (target.status === 'delivered') {
        return {
          output: `TaskRun ${target.id} is delivered; accept or reject it with TaskUpdate instead of cancelling.`,
          isError: true,
        }
      }
      if (isOrchestrator) {
        // User-scoped, not chat-scoped: the watchdog batches findings per
        // owner and may wake main in any chat, so disposition verbs must
        // reach every root of the user or cross-chat findings have no settle
        // path. Chat isolation applies to /stop (execution), not the ledger.
        const root = await getTaskRun(target.rootRunId, owner)
        if (!root || (root.kind ?? 'dispatch') !== 'root') {
          return {
            output: `TaskRun ${target.id} is not inside one of your rooted task trees.`,
            isError: true,
          }
        }
      } else {
        const own = getCurrentTaskRunId()
        // A worker-created standing service is a top-level root
        // (parentRunId null), so the direct-child edge alone would lock the
        // creator out of its own service — entry ownership grants the cancel,
        // the way the retired CancelDispatch did.
        const ownsService =
          target.standing === true &&
          (target.kind ?? 'dispatch') === 'root' &&
          findBackingDispatches(owner, target.id)
            .some(entry => taskCallerSession(entry) === getSessionId())
        if (!ownsService && (!own || target.parentRunId !== own)) {
          return {
            output: `TaskRun ${target.id} is not a direct child of your current run; you can only cancel work you dispatched.`,
            isError: true,
          }
        }
      }
      const backing = findBackingDispatches(owner, target.id)
      if (target.standing === true && (target.kind ?? 'dispatch') === 'root') {
        for (const entry of backing) {
          if (!currentCallerMayManageDispatch(entry)) {
            return {
              output: `Dispatch ${entry.id} was created by ${taskCallerRole(entry)} in a different session and is outside your scope. Report it back to your requester instead of retrying.`,
              isError: true,
            }
          }
        }
        const childIds = backing.map(entry => entry.taskRunId).filter((id): id is string => Boolean(id))
        for (const entry of backing) {
          await cancelDispatchEntry(owner, entry)
        }
        const childResults: string[] = []
        for (const childId of childIds) {
          const child = await getTaskRun(childId, owner)
          if (!child || isTerminalTaskRun(child)) continue
          if (child.status === 'running' && child.currentSessionId) {
            abortInFlightForSession(child.currentSessionId)
          }
          const childCancelled = await markCancelled(
            child.id,
            `cancelled by ${byRole} via TaskUpdate standing-service shutdown`,
            Date.now(),
            owner,
            { allowRunning: true },
          )
          if (childCancelled?.status === 'cancelled') {
            childResults.push(childCancelled.id)
          }
        }
        const closed = await closeRootTaskRun(target.id, owner)
        if (!closed.closed && closed.reason === 'open-obligations') {
          return {
            output: [
              `Standing service ${target.id} was shut down, but its root still has unsettled obligations:`,
              ...closed.obligations.openRuns.map(run =>
                `- ${run.id} [${describeObligationStatus(run)}] ${run.role} — ${run.title}`,
              ),
            ].join('\n'),
            isError: true,
          }
        }
        return {
          output: JSON.stringify({
            runId: target.id,
            status: (await getTaskRun(target.id, owner))?.status ?? target.status,
            cancelledChildren: childResults,
            ...(backing.length ? { dispatchIds: backing.map(entry => entry.id) } : {}),
            ...(resolved.compatibilityDispatchId ? { compatibilityDispatchId: resolved.compatibilityDispatchId } : {}),
          }),
        }
      }
      for (const entry of backing) {
        if (entry.standingRootRunId && entry.taskRunId === target.id) continue
        if (!currentCallerMayManageDispatch(entry)) {
          return {
            output: `Dispatch ${entry.id} was created by ${taskCallerRole(entry)} in a different session and is outside your scope. Report it back to your requester instead of retrying.`,
            isError: true,
          }
        }
      }
      for (const entry of backing) {
        if (entry.standingRootRunId && entry.taskRunId === target.id) continue
        await cancelDispatchEntry(owner, entry)
      }
      if (target.status === 'running' && target.currentSessionId) {
        abortInFlightForSession(target.currentSessionId)
      }
      const cancelled = await markCancelled(
        target.id,
        `cancelled by ${byRole} via TaskUpdate`,
        Date.now(),
        owner,
        { allowRunning: true },
      )
      if (!cancelled || cancelled.status !== 'cancelled') {
        return {
          output: `TaskRun ${target.id} could not be cancelled (its state changed underneath).`,
          isError: true,
        }
      }
      await closeOrphanStandingRootBestEffort(owner, cancelled.rootRunId)
      return {
        output: JSON.stringify({
          runId: cancelled.id,
          status: cancelled.status,
          ...(backing.length ? { dispatchIds: backing.map(entry => entry.id) } : {}),
          ...(resolved.compatibilityDispatchId ? { compatibilityDispatchId: resolved.compatibilityDispatchId } : {}),
        }),
      }
    }

    // accept / reject — verdict on a delivered child.
    if (!input.runId) {
      return { output: `${input.action} requires \`runId\` of the delivered run.`, isError: true }
    }
    const feedback = input.feedback?.trim() ?? ''
    if (input.action === 'reject' && feedback.length === 0) {
      return {
        output: 'Rejecting a delivered run requires `feedback` describing what to change.',
        isError: true,
      }
    }
    const target = await getTaskRun(input.runId, owner)
    if (!target) {
      return { output: `TaskRun not found: ${input.runId}`, isError: true }
    }
    if (target.status !== 'delivered') {
      return {
        output: `TaskRun ${input.runId} is ${target.status}, not delivered. Only delivered runs await a verdict.`,
        isError: true,
      }
    }
    if (isOrchestrator) {
      // Transitional manager fallback: a one-shot worker that already returned
      // cannot settle its children, so the orchestrator may settle any
      // delivered run inside its own rooted trees. Tightens back to strict
      // parent-edge adjacency once parents are re-animatable (collab-phase3).
      const root = await getTaskRun(target.rootRunId, owner)
      if (!root || (root.kind ?? 'dispatch') !== 'root') {
        return {
          output: `TaskRun ${input.runId} is not inside one of your rooted task trees.`,
          isError: true,
        }
      }
    } else {
      const own = getCurrentTaskRunId()
      if (!own || target.parentRunId !== own) {
        return {
          output: `TaskRun ${input.runId} is not a direct child of your current run; you can only settle runs you dispatched.`,
          isError: true,
        }
      }
    }
    const settled = input.action === 'accept'
      ? await acceptTaskRun(input.runId, { byRole }, Date.now(), owner)
      : await rejectTaskRun(input.runId, { byRole, feedback }, Date.now(), owner)
    if (!settled) {
      return {
        output: `TaskRun ${input.runId} could not be settled (its state changed underneath).`,
        isError: true,
      }
    }
    if (input.action === 'reject') {
      // Detached on purpose: the rejected run's next shift can take minutes.
      // Awaiting it here would freeze the rejecting caller inside the tool
      // call — the exact shape retiring blocking dispatch removed.
      scheduleResumeRunWithBlock(owner, input.runId, {
        via: 'reject',
        reason: `rejected by ${byRole}`,
        body: [
          '<taskrun-reject-feedback>',
          feedback,
          '</taskrun-reject-feedback>',
        ].join('\n'),
      })
    }
    await closeOrphanStandingRootBestEffort(owner, settled.rootRunId)
    return { output: JSON.stringify({ runId: settled.id, status: settled.status }) }
  },
})

// In-process promptness only; the durable half is the watchdog reconcile,
// which re-arms due timer wakes from the ledger after a daemon restart.
function scheduleTaskRunTimerWake(owner: string, runId: string, at: number): void {
  const delay = Math.max(0, at - Date.now())
  setTimeout(() => {
    scheduleResumeRunWithBlock(owner, runId, {
      via: 'timer',
      reason: 'taskrun timer wake',
      body: '<taskrun-timer-wake />',
    })
  }, delay).unref?.()
}

export const __toolDescriptionForSnapshot = {
  TaskUpdate: TASK_UPDATE_DESCRIPTION,
}
