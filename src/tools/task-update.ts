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
  markWaiting,
  rejectTaskRun,
} from '../taskrun/store.js'
import { scheduleResumeRunWithBlock } from '../taskrun/resume-schedule.js'
import { resolveBackingRun } from '../taskrun/resolve-run-id.js'
import { abortInFlightForSession, getCurrentRole, getCurrentTaskRunId, getSessionId, markConcludedRootThisTurn, requireCurrentUserId } from '../state.js'
import { buildTool } from '../tool.js'
import type { TaskRunMeta } from '../taskrun/types.js'

const TASK_UPDATE_DESCRIPTION = [
  'Change a TaskRun state: deliver your own run, wait on a declared wake, cancel work, or settle (accept / reject) a delivered child run.',
  '',
  "action='deliver' — conclude a run you own. Without runId it targets your current run: records your outcome (ok, plus a one-line summary) and parks it at delivered, awaiting your requester's verdict. Your full result goes in your turn's final reply, not in summary — summary is just a short label. A goal root you opened closes directly instead — pass its runId; the close is refused with an itemized list while the root still has open obligations. Settle each, then retry.",
  "action='accept' — verdict on a delivered run you dispatched: closes it per its delivered outcome.",
  "action='reject' — requires feedback; records it and resumes the delivered run with that feedback.",
  "action='wait' — without runId, set your own run waiting on a declared wake (checkpoint required): the last thing you do here — the task comes back to you when the wake fires. With runId, set a running direct child waiting.",
  "action='cancel' — cancel work you own by runId: your direct children, or any run inside goals you opened. Queued / waiting runs settle in place; running runs are stopped first; a recurring service's root runId takes the whole service down, schedule included. A dispatch entry id works here too and resolves to its backing run.",
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

/** A child-join wake is matched by TaskRun id (`tr_...`) on BOTH ends: the
 *  child's turn-end wake (`wakeParentForChildJoinBestEffort`) compares against
 *  `child.id`, and the watchdog due-wake reconcile looks the child up by
 *  `runById.get(wake.runId)`. But `Dispatch` hands the caller a dispatch-entry
 *  id (`<user>-<short>`), so a worker that waits on the id it was just handed
 *  registers a wake no consumer can ever match — the real child delivery can't
 *  resume it, and the watchdog then treats the unresolvable child as
 *  "settled/missing" and resumes the parent with an empty result. Resolve a
 *  dispatch-entry id to its backing run here, mirroring `resolveCancelTarget`,
 *  so the stored wake is always keyed the way both consumers read it. A value
 *  that already is a TaskRun id (or resolves to nothing) is left untouched. */
async function resolveChildJoinWakeRunId(owner: string, idOrDispatchId: string): Promise<string> {
  return (await resolveBackingRun(owner, idOrDispatchId))?.id ?? idOrDispatchId
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
  // Inline: a core ledger verb of every delegation loop (D5 extended after
  // dogfood showed repeated ToolSearch round-trips for it).
  shouldDefer: false,
  description: TASK_UPDATE_DESCRIPTION,
  searchHint: 'taskrun state deliver accept reject settle close verdict 交付 验收 打回 关单 工单',
  domain: 'host',
  riskLevel: 'safe',
  inputSchema: z.object({
    runId: z.string().min(1).optional(),
    action: z.enum(['deliver', 'accept', 'reject', 'cancel', 'wait']),
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
      // One meaning for every caller: conclude a run you own. The mechanics
      // fork on the TARGET's structure, not on who is calling — a goal root
      // (no requester above it) closes through the settled-ledger gate, an
      // ordinary run parks at delivered awaiting its requester's verdict.
      // Role only scopes which targets are yours.
      if (input.runId) {
        const target = await getTaskRun(input.runId, owner)
        if (!target && input.runId !== getCurrentTaskRunId()) {
          return { output: `TaskRun not found: ${input.runId}`, isError: true }
        }
        if (target && (target.kind ?? 'dispatch') === 'root') {
          if (!isOrchestrator) {
            return {
              output: `TaskRun ${input.runId} is a goal root, not a run of yours; deliver concludes runs you own.`,
              isError: true,
            }
          }
          const result = await closeRootTaskRun(input.runId, owner, Date.now(), {
            ...(input.ok !== undefined ? { ok: input.ok } : {}),
            ...(input.summary ? { summary: input.summary.slice(0, 2000) } : {}),
          })
          if (result.closed) {
            // A root closed this handling — the agent concluded a task. The
            // channel runner routes its synthetic-wake final block to chat on
            // this signal, so an incremental delivery (this root done while
            // others run) reaches the user instead of the card.
            markConcludedRootThisTurn()
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
      }

      // No runId, or a non-root runId: this is delivering your own run.
      const own = getCurrentTaskRunId()
      if (!own) {
        return {
          output: input.runId
            ? `TaskRun ${input.runId} is not a root TaskRun, and you have no current run of your own to deliver.`
            : 'No current TaskRun to deliver. To close a goal root, pass its runId.',
          isError: true,
        }
      }
      if (input.runId && input.runId !== own) {
        return {
          output: `deliver concludes runs you own; your current run is ${own}, not ${input.runId}.`,
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
      // Concluded a run this handling — same chat-routing signal as root close.
      markConcludedRootThisTurn()
      // Deliver records the outcome and parks; it does NOT wake a child-join
      // parent from here. Mid-turn this run has no final reply yet, only this
      // capped summary label. The wake fires at the run's turn-end instead — the
      // scheduler's settle-on-return for a fire, or resume.ts for a resumed run
      // — where the full final reply exists, so a waiting parent gets the result
      // in full rather than the label.
      return { output: JSON.stringify({ runId: delivered.id, status: delivered.status }) }
    }

    if (input.action === 'wait') {
      // requester-hold is ONLY the wake-less "hold a running child" case (an
      // orchestrator may pause a runaway child in its tree this way). A wait
      // that declares a `wake` is an armed self-suspend, handled by the branch
      // below. Gating requester-hold on `!input.wake` keeps a wake+checkpoint
      // self-suspend from being silently swallowed into a dead, never-revived
      // hold (2026-06-30 dogfood: a wake on a runId landed here and lost both).
      if (input.runId && !input.wake) {
        const target = await resolveBackingRun(owner, input.runId)
        if (!target) return { output: `TaskRun not found: ${input.runId}`, isError: true }
        if (target.status !== 'running' || !target.currentSessionId) {
          return { output: `TaskRun ${target.id} is ${target.status}, not a running run.`, isError: true }
        }
        if (isOrchestrator) {
          const root = await getTaskRun(target.rootRunId, owner)
          if (!root || (root.kind ?? 'dispatch') !== 'root') {
            return { output: `TaskRun ${target.id} is not inside one of your rooted task trees.`, isError: true }
          }
        } else {
          const own = getCurrentTaskRunId()
          if (!own || target.parentRunId !== own) {
            return { output: `TaskRun ${target.id} is not a direct child of your current run.`, isError: true }
          }
        }
        if (target.currentSessionId !== getSessionId()) {
          abortInFlightForSession(target.currentSessionId)
        }
        const waitingRun = await markWaiting(
          target.id,
          { reason: 'requester-hold', bySessionId: getSessionId() },
          Date.now(),
          owner,
        )
        return waitingRun?.status === 'waiting'
          ? { output: JSON.stringify({ runId: waitingRun.id, status: waitingRun.status, reason: waitingRun.waitReason }) }
          : { output: `TaskRun ${target.id} could not be set waiting.`, isError: true }
      }

      // Armed self-suspend: a dispatcher-worker parks its OWN run until the
      // declared wake fires, honoring the checkpoint. main (orchestrator) has no
      // run of its own and follows the unattended-manager model — it dispatches,
      // ends the turn, and is woken when a result is pushed back; it does not
      // self-suspend. A "retry / come back in N minutes" intent from main belongs
      // in a scheduled Dispatch (schedule: after / oneshot), not a wait. Reject
      // it here rather than let it name the root and freeze the task card.
      if (isOrchestrator) {
        return {
          output:
            'You manage work and are woken when a result returns — you do not self-suspend on a wake. To pause a still-running run in your tree, call wait with its runId and no wake. To pick this objective back up on your own later, schedule it with Dispatch({ schedule: { after: { afterMinutes } } }) (or a oneshot at an ISO time).',
          isError: true,
        }
      }
      const own = getCurrentTaskRunId()
      if (!own) return { output: 'wait requires a current TaskRun to suspend.', isError: true }
      if (input.runId && input.runId !== own) {
        return { output: `TaskRun ${input.runId} is not your current run — you can only wait on your own run.`, isError: true }
      }
      const checkpoint = input.checkpoint?.trim()
      if (!checkpoint) return { output: 'wait requires `checkpoint` so the run can be picked back up safely.', isError: true }
      if (!input.wake) return { output: 'wait requires `wake` (child-join or timer).', isError: true }
      const meta = await getTaskRun(own, owner)
      if (!meta) return { output: `TaskRun not found: ${own}`, isError: true }
      if (meta.status !== 'running') {
        return { output: `TaskRun ${own} is ${meta.status}, not running.`, isError: true }
      }
      await appendCheckpoint(own, checkpoint, Date.now(), owner)
      const wake = input.wake.kind === 'child-join'
        ? { kind: 'child-join' as const, runId: await resolveChildJoinWakeRunId(owner, input.wake.runId) }
        : { kind: 'timer' as const, at: Date.now() + input.wake.afterMinutes * 60_000 }
      const waitingRun = await markWaiting(
        own,
        {
          reason: input.wake.kind,
          wake,
        },
        Date.now(),
        owner,
      )
      if (waitingRun?.status !== 'waiting') {
        return { output: `TaskRun ${own} could not be set waiting.`, isError: true }
      }
      if (wake.kind === 'timer') {
        scheduleTaskRunTimerWake(owner, waitingRun.id, wake.at)
      }
      // The shift ends HERE, enforced: a run cannot be waiting while its
      // session keeps executing. Aborting our own in-flight turn seals the
      // shift; the aborted-outcome path leaves the waiting status untouched
      // and the wake brings the next shift.
      //
      // Key the abort off the run's `currentSessionId` (what markStarted /
      // markResumed recorded, and what the controller is registered under by
      // the scheduler fire / resume), NOT `getSessionId()`. For a dispatched
      // worker fire these differ: the controller is registered under the fire
      // sessionId (`bg-<canonical>-<task>-<fire>`), but the worker's ALS
      // sessionId is deliberately the chain leaf (the dispatchId) for per-fork
      // isolation — so abortInFlightForSession(getSessionId()) found no
      // controller and was a silent no-op. The live query loop then kept
      // running past this tool_result, produced an empty turn, and tripped the
      // worker empty-stop backstop into a confused re-wait that the ledger
      // (already `waiting`) rejected (0.3.4 dogfood, bg-guitao…25b7fb77). This
      // mirrors the requester-hold branch above, which already aborts
      // `target.currentSessionId`. On a resumed shift / channel main,
      // currentSessionId === getSessionId(), so the fallback is a no-op change.
      abortInFlightForSession(meta.currentSessionId ?? getSessionId())
      return {
        output: `${JSON.stringify({ runId: waitingRun.id, status: waitingRun.status, wake })}\nWait recorded. The task comes back to you when the wake fires, with what arrived in hand.`,
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
      const standingCurrentChild = backing.find(
        entry => entry.standingRootRunId && entry.taskRunId === target.id,
      )
      if (standingCurrentChild && target.status === 'queued') {
        // The schedule still backs this run: at fire time it would either
        // re-fire the cancelled run or recreate the slot, silently undoing the
        // cancel. Route to the verbs that actually stop the service.
        return {
          output: `TaskRun ${target.id} is the next scheduled fire of recurring service ${standingCurrentChild.standingRootRunId}. Cancelling a single upcoming fire is not supported. Cancel the service's root (TaskUpdate { action:'cancel', runId:'${standingCurrentChild.standingRootRunId}' }) to shut the service down, or UpdateSchedule { id:'${standingCurrentChild.id}', enabled:false } to suspend future fires.`,
          isError: true,
        }
      }
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
          if (child.status === 'running' && child.currentSessionId && child.currentSessionId !== getSessionId()) {
            abortInFlightForSession(child.currentSessionId)
          }
          const childCancelled = await markCancelled(
            child.id,
            `cancelled by ${byRole} via TaskUpdate recurring-service shutdown`,
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
      // A root opened in this very chat carries the caller's own session —
      // aborting it would kill the cancelling turn mid-batch (dogfood
      // 2026-06-11: cancelling a placeholder root aborted main's own turn,
      // taking the parallel SendFile / Dispatch calls down with it).
      if (target.status === 'running' && target.currentSessionId && target.currentSessionId !== getSessionId()) {
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
    // Accept a dispatch-entry id as well as a TaskRun id: the model holds the
    // dispatch id Dispatch handed it as a first-class handle for the child it
    // wants to settle. All downstream operations use the resolved `target.id`.
    const target = await resolveBackingRun(owner, input.runId)
    if (!target) {
      return { output: `TaskRun not found: ${input.runId}`, isError: true }
    }
    if (target.status !== 'delivered') {
      return {
        output: `TaskRun ${target.id} is ${target.status}, not delivered. Only delivered runs await a verdict.`,
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
          output: `TaskRun ${target.id} is not inside one of your rooted task trees.`,
          isError: true,
        }
      }
    } else {
      const own = getCurrentTaskRunId()
      if (!own || target.parentRunId !== own) {
        return {
          output: `TaskRun ${target.id} is not a direct child of your current run; you can only settle runs you dispatched.`,
          isError: true,
        }
      }
    }
    const settled = input.action === 'accept'
      ? await acceptTaskRun(target.id, { byRole }, Date.now(), owner)
      : await rejectTaskRun(target.id, { byRole, feedback }, Date.now(), owner)
    if (!settled) {
      return {
        output: `TaskRun ${target.id} could not be settled (its state changed underneath).`,
        isError: true,
      }
    }
    if (input.action === 'accept') {
      // Accepting a delivered run routes this shift's final block to chat
      // (routeSyntheticBlock's concludedRoot signal) ONLY for a STANDING
      // service: the scheduler auto-delivers each fire, main settles it with
      // accept (not deliver), and that per-fire accept IS the user-facing
      // report. A FINITE root's intermediate child-accept is NOT a report —
      // main is mid-task settling one of several children as they trickle in;
      // its narration folds onto the task card, and only the root close
      // (deliver root, line ~228) reports to chat. Without this gate, a finite
      // multi-child join surfaces one extra chat bubble per child that happens
      // to settle in its own resumed shift (2026-06-18 dogfood: "已验收子任务 2"
      // mid-join). Resolve the settled run's root: the orchestrator branch
      // already loaded it above, but it is block-scoped, so re-read here.
      const settledRoot = await getTaskRun(target.rootRunId, owner)
      if (settledRoot?.standing === true) markConcludedRootThisTurn()
    }
    if (input.action === 'reject') {
      // Detached on purpose: the rejected run's next shift can take minutes.
      // Awaiting it here would freeze the rejecting caller inside the tool
      // call — the exact shape retiring blocking dispatch removed.
      scheduleResumeRunWithBlock(owner, target.id, {
        via: 'reject',
        reason: 'your requester rejected your delivery',
        body: [
          'Your delivery was reviewed and sent back. Feedback:',
          '<taskrun-reject-feedback>',
          feedback,
          '</taskrun-reject-feedback>',
          "Address the feedback and deliver again. Your earlier work stands — fix what was called out, don't redo what wasn't.",
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
      reason: 'your declared timer fired',
      body: '<taskrun-timer-wake />\nYour timer wake fired. Check what you were waiting for; if it needs more time, declare a new wait — do not hold the turn open to watch it.',
    })
  }, delay).unref?.()
}

export const __toolDescriptionForSnapshot = {
  TaskUpdate: TASK_UPDATE_DESCRIPTION,
}
