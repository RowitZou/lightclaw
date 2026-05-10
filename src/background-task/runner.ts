import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import { getConfig } from '../config.js'
import { createUserMessage } from '../messages.js'
import { getMemoryDir } from '../memory/auto-memory.js'
import { getProvider } from '../provider/index.js'
import { loadFileRules, loadIdentityRules } from '../permission/storage.js'
import { getAdmin } from '../identity/store.js'
import { loadIdentityPreferences } from '../identity/preferences.js'
import { workspaceFor } from '../identity/paths.js'
import { query } from '../query.js'
import { getImageReadiness, getRuntimePool } from '../state.js'
import {
  createSessionContext,
  runWithSessionContext,
} from '../session-context.js'
import {
  getSessionDir,
  rewriteTranscript,
  touchMeta,
} from '../session/storage.js'
import type { CanUseToolFn, Tool } from '../tool.js'
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
}): Promise<FireOutcome> {
  const sessionId = buildBackgroundTaskSessionId(input.task, input.fireUuid)
  try {
    if (input.signal.aborted) {
      return {
        kind: 'failure',
        reason: 'aborted',
        transient: true,
        attempt: 1,
      }
    }

    const config = getConfig()
    const prefs = loadIdentityPreferences(input.task.ownerCanonicalUser)
    const model = prefs.model ?? config.model
    const permissionMode = prefs.permissionMode ?? config.permissionMode
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

    const provider = getProvider(config)
    const { getAllTools, getEnabledTools } = await import('../tools.js')
    const tools = getEnabledTools(provider, getAllTools('feishu'))
    // Docker backend requires the tracker; local / rlaunch ignore it. Pass it
    // unconditionally so a task fire under any backend gets a valid runtime —
    // missing this caused DockerRuntime to throw at acquire() and every fire
    // to fail-transient-then-disable on docker hosts.
    const tracker = config.runtime.backend === 'docker' ? getImageReadiness() : undefined
    const runtime = getRuntimePool().acquire(input.task.ownerCanonicalUser, config, cwd, tracker)
    const userMessage = createUserMessage(buildBackgroundTaskFirePrompt(input.task))
    const permissionDenials: PermissionDenialDetail[] = []
    const ctx = createSessionContext({
      cwd,
      model,
      sessionsDir: config.sessionsDir,
      memoryDir: getMemoryDir(input.task.ownerCanonicalUser, config),
      currentUserId: input.task.ownerCanonicalUser,
      sessionId,
      channel: 'feishu',
      permissionMode,
      runtime,
      fileRules: loadFileRules({
        cwd,
        userPath: config.permissionRuleFiles.user,
        projectPath: config.permissionRuleFiles.project,
        localPath: config.permissionRuleFiles.local,
      }),
      identityRules: loadIdentityRules(input.task.ownerCanonicalUser),
      isBackgroundTask: true,
      taskAllowedTools: input.task.allowedTools ?? [],
      onPermissionDenial(detail) {
        permissionDenials.push(detail)
      },
    })

    const result = await runWithSessionContext(ctx, async () => {
      const output = await queryImpl({
        messages: [userMessage],
        tools,
        config: {
          ...config,
          model,
          routing: {
            ...config.routing,
            main: model,
          },
        },
        mode: 'subagent',
        canUseTool: createBackgroundTaskCanUseTool(),
        signal: input.signal,
        subagentLabel: 'background_task',
      })
      await rewriteTranscript(sessionId, output.messages)
      await touchMeta(sessionId, output.messages.length)
      return output
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
      kind: 'success',
      summary: result.assistantText || '(background task returned empty text)',
      transcriptPath: path.join(getSessionDir(sessionId), 'transcript.jsonl'),
    }
  } catch (error) {
    return {
      kind: 'failure',
      reason: error instanceof Error ? error.message : String(error),
      transient: isTransientFireError(error),
      attempt: 1,
    }
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

export function createBackgroundTaskCanUseTool(): CanUseToolFn {
  return async (tool: Tool) => {
    if (tool.name === 'BackgroundTask') {
      return {
        behavior: 'deny',
        reason: 'BackgroundTask cannot be invoked from inside a background task.',
      }
    }
    if (tool.name === 'notify_user' || tool.name === 'stay_silent') {
      return {
        behavior: 'deny',
        reason: `${tool.name} is wake-mode only; not available to background task agents.`,
      }
    }
    return { behavior: 'allow' }
  }
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
// schedule a future event — producing a clarifying question instead of doing
// the work. Same shape as buildWakePrompt; stays English on purpose because
// it is an LLM system instruction, not user-visible display.
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
    'You are a background-task agent invoked by the scheduler. The scheduled fire time is NOW.',
    'Execute the instruction above immediately and produce the result.',
    'Do not ask the user clarifying questions, do not schedule a new task, and do not read the instruction as a future event — the schedule has already resolved, this fire IS the moment "after the time comes".',
    'If the instruction is too underspecified to act on, do your best with reasonable defaults and explain your assumption in the result.',
  ].join('\n')
}

function isTransientFireError(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error)
  return /ECONNRESET|ECONNABORTED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|network|rate.?limit|429|timeout/i
    .test(detail)
}
