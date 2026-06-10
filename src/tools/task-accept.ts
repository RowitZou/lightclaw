import { z } from 'zod'

import { acceptTaskRun, getTaskRun, rejectTaskRun } from '../taskrun/store.js'
import { getCurrentRole, requireCurrentUserId } from '../state.js'
import { buildTool } from '../tool.js'

const TASK_ACCEPT_DESCRIPTION = [
  'Settle a delivered TaskRun: accept its result, or reject it back with feedback.',
  '',
  'Targets a run whose status is `delivered` (a background worker finished and reported its result).',
  "verdict='accept' closes the run as done/failed according to the delivered outcome.",
  "verdict='reject' records your feedback and closes this run as failed; dispatch a new task (attached to the same root) carrying that feedback to continue the work.",
].join('\n')

export const taskAcceptTool = buildTool({
  name: 'TaskAccept',
  whenToUse: `Settle a delivered background TaskRun — accept the result or reject it with feedback.`,
  shouldDefer: true,
  description: TASK_ACCEPT_DESCRIPTION,
  searchHint: 'taskrun accept reject settle delivered verdict 验收 打回 工单',
  domain: 'host',
  riskLevel: 'safe',
  inputSchema: z.object({
    runId: z.string().min(1),
    verdict: z.enum(['accept', 'reject']),
    feedback: z.string().min(1).optional(),
  }),
  async call(input) {
    const role = getCurrentRole()
    if (role?.kind !== 'orchestrator') {
      return {
        output: 'TaskAccept is available only to the main orchestrator.',
        isError: true,
      }
    }
    const feedback = input.feedback?.trim() ?? ''
    if (input.verdict === 'reject' && feedback.length === 0) {
      return {
        output: 'Rejecting a delivered run requires `feedback` describing what to change.',
        isError: true,
      }
    }
    const owner = requireCurrentUserId()
    const meta = await getTaskRun(input.runId, owner)
    if (!meta) {
      return { output: `TaskRun not found: ${input.runId}`, isError: true }
    }
    if (meta.status !== 'delivered') {
      return {
        output: `TaskRun ${input.runId} is ${meta.status}, not delivered. Only delivered runs await acceptance.`,
        isError: true,
      }
    }
    const settled = input.verdict === 'accept'
      ? await acceptTaskRun(input.runId, { byRole: 'main' }, Date.now(), owner)
      : await rejectTaskRun(input.runId, { byRole: 'main', feedback }, Date.now(), owner)
    if (!settled) {
      return {
        output: `TaskRun ${input.runId} could not be settled (its state changed underneath).`,
        isError: true,
      }
    }
    return {
      output: JSON.stringify({ runId: settled.id, status: settled.status }),
    }
  },
})

export const __toolDescriptionForSnapshot = {
  TaskAccept: TASK_ACCEPT_DESCRIPTION,
}
