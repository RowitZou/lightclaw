import { z } from 'zod'

import { createRootTaskRun } from '../taskrun/store.js'
import { getCurrentRole, getSessionId, requireCurrentUserId } from '../state.js'
import { buildTool } from '../tool.js'

const TASK_CREATE_DESCRIPTION = [
  'Create a root TaskRun for a user-facing objective before dispatching finite worker tasks.',
  '',
  'This tool only creates the root. It does not dispatch workers or change your plan.',
  'Use the returned `runId` as `Dispatch.task` when launching now, after, or oneshot dispatches for this objective.',
].join('\n')

export const taskCreateTool = buildTool({
  name: 'TaskCreate',
  whenToUse: `Create a durable root TaskRun for a user-facing objective before attaching finite Dispatch work.`,
  // Inline (not deferred): opening the goal root is the first ledger act of
  // every delivery loop — the orchestrator must see it without a ToolSearch.
  shouldDefer: false,
  description: TASK_CREATE_DESCRIPTION,
  searchHint: 'taskrun create root task objective dispatch parent 工单 创建 根任务',
  domain: 'host',
  riskLevel: 'safe',
  inputSchema: z.object({
    objective: z.string().min(1),
    title: z.string().min(1).max(120).optional(),
  }),
  async call(input) {
    const role = getCurrentRole()
    if (role?.kind !== 'orchestrator') {
      return {
        output: 'TaskCreate is available only to the main orchestrator.',
        isError: true,
      }
    }
    const owner = requireCurrentUserId()
    const sessionId = getSessionId()
    const run = await createRootTaskRun(owner, sessionId, {
      objective: input.objective,
      title: input.title,
    })
    return {
      output: JSON.stringify({
        runId: run.id,
        title: run.title,
      }),
    }
  },
})

export const __toolDescriptionForSnapshot = {
  TaskCreate: TASK_CREATE_DESCRIPTION,
}
