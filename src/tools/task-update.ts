import { z } from 'zod'

import { loadBackgroundTasks } from '../background-task/store.js'
import {
  acceptTaskRun,
  closeRootTaskRun,
  getTaskRun,
  markDelivered,
  rejectTaskRun,
} from '../taskrun/store.js'
import { getCurrentRole, getCurrentTaskRunId, requireCurrentUserId } from '../state.js'
import { buildTool } from '../tool.js'
import type { TaskRunMeta } from '../taskrun/types.js'

const TASK_UPDATE_DESCRIPTION = [
  'Change a TaskRun state: deliver your own run, or settle (accept / reject) a delivered child run.',
  '',
  "action='deliver' — conclude your own run. Without runId it targets your current run: records your outcome (ok + summary) and parks it at delivered, awaiting your requester's verdict. With a root runId (orchestrator) it declares the root delivered; the close is refused with an itemized list while the root still has open obligations — settle each, then retry.",
  "action='accept' — verdict on a delivered run you dispatched: closes it per its delivered outcome.",
  "action='reject' — requires feedback; records it and closes the delivered run as failed. Re-dispatch with that feedback if the work should continue.",
].join('\n')

function describeObligationStatus(meta: TaskRunMeta): string {
  if (meta.status === 'delivered') return 'delivered, awaiting acceptance'
  if (meta.status === 'queued') return 'scheduled, not fired yet'
  return meta.status
}

/** CancelDispatch can only close a standing-service root whose ledger is
 *  already settled; with a fire still in flight (or parked at delivered) the
 *  gate refuses, the entry is removed, and nothing revisits the root after
 *  that. The verdict settling a child is the natural revisit: once no live
 *  dispatch entry backs the root, retry the gated close — it succeeds exactly
 *  when the last obligation settles. */
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
    action: z.enum(['deliver', 'accept', 'reject']),
    ok: z.boolean().optional(),
    summary: z.string().min(1).optional(),
    feedback: z.string().min(1).optional(),
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
          'Settle each first: TaskUpdate accept/reject delivered runs, CancelDispatch scheduled work you no longer want, or wait for running work to deliver. Then retry.',
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
      return { output: JSON.stringify({ runId: delivered.id, status: delivered.status }) }
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
    await closeOrphanStandingRootBestEffort(owner, settled.rootRunId)
    return { output: JSON.stringify({ runId: settled.id, status: settled.status }) }
  },
})

export const __toolDescriptionForSnapshot = {
  TaskUpdate: TASK_UPDATE_DESCRIPTION,
}
