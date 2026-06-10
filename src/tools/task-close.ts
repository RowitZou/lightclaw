import { z } from 'zod'

import { closeRootTaskRun } from '../taskrun/store.js'
import { getCurrentRole, requireCurrentUserId } from '../state.js'
import { buildTool } from '../tool.js'
import type { TaskRunMeta } from '../taskrun/types.js'

const TASK_CLOSE_DESCRIPTION = [
  'Close a root TaskRun after delivering its outcome to the user.',
  '',
  'The close is gated on a settled ledger: if the root still has open obligations',
  '(runs in flight, scheduled-but-not-fired dispatches, or delivered runs awaiting acceptance),',
  'the call fails and lists them — settle each with TaskAccept / CancelDispatch, then retry.',
].join('\n')

function describeObligationStatus(meta: TaskRunMeta): string {
  if (meta.status === 'delivered') return 'delivered, awaiting acceptance'
  if (meta.status === 'queued') return 'scheduled, not fired yet'
  return meta.status
}

export const taskCloseTool = buildTool({
  name: 'TaskClose',
  whenToUse: `Declare a root TaskRun delivered and close it once every child obligation is settled.`,
  shouldDefer: true,
  description: TASK_CLOSE_DESCRIPTION,
  searchHint: 'taskrun close finish root deliver settle 关闭 交付 结单 工单',
  domain: 'host',
  riskLevel: 'safe',
  inputSchema: z.object({
    task: z.string().min(1),
  }),
  async call(input) {
    const role = getCurrentRole()
    if (role?.kind !== 'orchestrator') {
      return {
        output: 'TaskClose is available only to the main orchestrator.',
        isError: true,
      }
    }
    const owner = requireCurrentUserId()
    const result = await closeRootTaskRun(input.task, owner)
    if (result.closed) {
      return {
        output: JSON.stringify({ runId: result.meta.id, status: result.meta.status }),
      }
    }
    if (result.reason !== 'open-obligations') {
      if (result.reason === 'not-found') {
        return { output: `TaskRun not found: ${input.task}`, isError: true }
      }
      if (result.reason === 'not-root') {
        return { output: `TaskRun ${input.task} is not a root TaskRun.`, isError: true }
      }
      return { output: `Root TaskRun ${input.task} is already closed.` }
    }
    const lines = [
      `Root TaskRun ${input.task} still has unsettled obligations:`,
      ...result.obligations.openRuns.map(run =>
        `- ${run.id} [${describeObligationStatus(run)}] ${run.role} — ${run.title}`,
      ),
      ...result.obligations.pendingDispatchIds.map(id =>
        `- dispatch ${id} [scheduled, not fired yet]`,
      ),
      '',
      'Settle each first: TaskAccept (accept/reject delivered runs), CancelDispatch (drop scheduled work you no longer want), or wait for running work to deliver. Then retry TaskClose.',
    ]
    return { output: lines.join('\n'), isError: true }
  },
})

export const __toolDescriptionForSnapshot = {
  TaskClose: TASK_CLOSE_DESCRIPTION,
}
