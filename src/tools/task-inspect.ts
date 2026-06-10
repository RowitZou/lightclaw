import { z } from 'zod'

import type { TaskRunMeta } from '../taskrun/types.js'
import { getCurrentRole, getCurrentTaskRunId, requireCurrentUserId } from '../state.js'
import {
  getTaskRun,
  getTaskRunEvents,
  listChildTaskRuns,
  listTaskRuns,
} from '../taskrun/store.js'
import { buildTool } from '../tool.js'

const RECENT_EVENT_LIMIT = 20

const TASK_INSPECT_DESCRIPTION = [
  'Read durable TaskRun state for dispatched work.',
  '',
  'Input:',
  '- `runId` optional. When provided, returns that run metadata, recent events, direct child runs, and the full descendant tree.',
  '- Omit `runId` to list TaskRuns related to your current session.',
  '',
  'Visibility:',
  '- The main orchestrator can inspect any TaskRun for the current user.',
  '- A worker can inspect only its current TaskRun and descendants.',
  '',
  'Returns JSON with `meta`, `events`, `children`, and `tree` for a specific run, or `runs` when listing.',
].join('\n')

export const taskInspectTool = buildTool({
  name: 'TaskInspect',
  whenToUse: `Inspect durable TaskRun progress, artifacts, lifecycle events, and direct child runs for delegated work.`,
  shouldDefer: true,
  description: TASK_INSPECT_DESCRIPTION,
  searchHint: 'taskrun task inspect progress artifact dispatch tree status 工单 进度 产出 查看',
  domain: 'host',
  riskLevel: 'safe',
  inputSchema: z.object({
    runId: z.string().min(1).optional(),
  }),
  async call(input) {
    const owner = requireCurrentUserId()
    const role = getCurrentRole()
    const currentTaskRunId = getCurrentTaskRunId()
    if (input.runId) {
      if (role?.kind === 'worker' && !await isWithinWorkerSubtree(input.runId, currentTaskRunId, owner)) {
        return {
          output: `TaskRun ${input.runId} is outside your TaskRun subtree. A worker can inspect only its current run and descendants.`,
          isError: true,
        }
      }
      const meta = await getTaskRun(input.runId, owner)
      if (!meta) {
        return { output: `TaskRun not found: ${input.runId}`, isError: true }
      }
      return {
        output: JSON.stringify(await inspectRun(meta, owner), null, 2),
      }
    }

    if (role?.kind === 'worker') {
      if (!currentTaskRunId) {
        return { output: 'No current TaskRun is active for this worker.' }
      }
      const meta = await getTaskRun(currentTaskRunId, owner)
      if (!meta) {
        return { output: `Current TaskRun not found: ${currentTaskRunId}`, isError: true }
      }
      return { output: JSON.stringify(await inspectRun(meta, owner), null, 2) }
    }

    const runs = await listTaskRuns(owner)
    return {
      output: runs.length === 0
        ? 'No TaskRuns related to the current session.'
        : JSON.stringify({ runs: runs.map(formatRunSummary) }, null, 2),
    }
  },
})

async function inspectRun(meta: TaskRunMeta, owner: string) {
  const events = await getTaskRunEvents(meta.id, { limit: RECENT_EVENT_LIMIT }, owner)
  const children = await listChildTaskRuns(meta.id, owner)
  const tree = await buildRunTree(meta, owner)
  return {
    meta,
    events,
    children: children.map(formatRunSummary),
    tree,
  }
}

function formatRunSummary(meta: TaskRunMeta) {
  return {
    id: meta.id,
    kind: meta.kind ?? 'dispatch',
    title: meta.title,
    role: meta.role,
    callerRole: meta.callerRole,
    mode: meta.mode,
    status: meta.status,
    parentRunId: meta.parentRunId,
    rootRunId: meta.rootRunId,
    latestProgress: meta.latestProgress ?? null,
    artifactPaths: meta.artifactPaths ?? [],
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  }
}

type RunTree = ReturnType<typeof formatRunSummary> & {
  children: RunTree[]
}

async function buildRunTree(meta: TaskRunMeta, owner: string): Promise<RunTree> {
  const children = await listChildTaskRuns(meta.id, owner)
  return {
    ...formatRunSummary(meta),
    children: await Promise.all(children.map(child => buildRunTree(child, owner))),
  }
}

async function isWithinWorkerSubtree(
  targetRunId: string,
  currentTaskRunId: string | undefined,
  owner: string,
): Promise<boolean> {
  if (!currentTaskRunId) return false
  let cursor: string | null = targetRunId
  const seen = new Set<string>()
  while (cursor && !seen.has(cursor)) {
    if (cursor === currentTaskRunId) return true
    seen.add(cursor)
    const meta = await getTaskRun(cursor, owner)
    cursor = meta?.parentRunId ?? null
  }
  return false
}
