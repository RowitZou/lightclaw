import { randomUUID } from 'node:crypto'

import { getAgent } from '../agents/registry.js'
import { forkInvocationContext } from '../agents/invocation-context.js'
import { deriveCanUseTool, filterToolsByRoleVisibility } from '../agents/role-tool-gate.js'
import { buildPromptForRole } from '../prompt.js'
import { getConfig } from '../config.js'
import { resolveRoleModel } from '../model-resolution.js'
import { getProviderFor } from '../provider/index.js'
import { query } from '../query.js'
import { getCurrentSessionContext, runWithSessionContext } from '../session-context.js'
import {
  appendMessage,
  loadTranscript,
  rewriteTranscript,
  touchMeta,
} from '../session/storage.js'
import { createUserMessage } from '../messages.js'
import {
  getRuntime,
} from '../state.js'
import type { TaskRunMeta, TaskRunResumedEvent } from './types.js'
import {
  getTaskRun,
  getTaskRunEvents,
  markDelivered,
  markRebuilt,
  markResumed,
} from './store.js'

export type ResumeRunBlock = {
  via: TaskRunResumedEvent['via']
  reason: string
  body: string
}

export type ResumeRunResult =
  | { ok: true; run: TaskRunMeta; mode: 'resume' | 'rebuild'; assistantText: string }
  | { ok: false; reason: 'not-found' | 'no-role' | 'no-session-context' | 'no-transcript' | 'no-checkpoint' | 'query-failed'; message: string }

export async function resumeRunWithBlock(
  runId: string,
  block: ResumeRunBlock,
  ownerCanonicalUser?: string,
): Promise<ResumeRunResult> {
  const currentCtx = getCurrentSessionContext()
  if (!currentCtx) {
    return { ok: false, reason: 'no-session-context', message: 'resumeRunWithBlock requires an active SessionContext.' }
  }
  const run = await getTaskRun(runId, ownerCanonicalUser ?? currentCtx.currentUserId)
  if (!run) return { ok: false, reason: 'not-found', message: `TaskRun not found: ${runId}` }
  const role = getAgent(run.role)
  if (!role) return { ok: false, reason: 'no-role', message: `TaskRun role is not registered: ${run.role}` }

  let config: ReturnType<typeof getConfig>
  try {
    config = getConfig()
  } catch (error) {
    return {
      ok: false,
      reason: 'query-failed',
      message: error instanceof Error ? error.message : String(error),
    }
  }
  const now = Date.now()
  const lastSessionId = run.lastSessionId ?? run.currentSessionId
  const gapSince = run.pausedAt ?? run.deliveredAt ?? run.updatedAt
  const withinGap = config.taskrun.resume.maxGapMs === 0 || now - gapSince <= config.taskrun.resume.maxGapMs
  const transcript = lastSessionId ? await loadTranscript(lastSessionId) : []
  const canResume = lastSessionId && transcript.length > 0 && withinGap
  const sessionId = canResume
    ? lastSessionId
    : `taskrun-${run.id}-${randomUUID().slice(0, 8)}`
  const mode: 'resume' | 'rebuild' = canResume ? 'resume' : 'rebuild'
  if (!canResume && !run.checkpoint) {
    return {
      ok: false,
      reason: transcript.length === 0 ? 'no-transcript' : 'no-checkpoint',
      message: `TaskRun ${run.id} cannot be resumed and has no checkpoint for cold rebuild.`,
    }
  }

  const resumeText = formatResumeBlock(run, block, mode)
  const resumeMessage = createUserMessage(resumeText)
  const messages = canResume
    ? [...transcript, resumeMessage]
    : [createUserMessage(formatRebuildSeed(run, await taskObjective(run), block)), resumeMessage]
  if (canResume) {
    await appendMessage(sessionId, resumeMessage)
    await markResumed(run.id, {
      via: block.via,
      reason: block.reason,
      sessionId,
    }, now, run.ownerCanonicalUser)
  } else {
    await rewriteTranscript(sessionId, messages)
    await touchMeta(sessionId, messages.length)
    await markRebuilt(run.id, {
      via: block.via,
      reason: block.reason,
      sessionId,
    }, now, run.ownerCanonicalUser)
  }

  const roleModel = resolveRoleModel(role, config)
  const provider = getProviderFor(config, roleModel).provider
  const { getAllTools, getEnabledTools } = await import('../tools.js')
  const tools = filterToolsByRoleVisibility(
    role,
    getEnabledTools(provider, getAllTools(currentCtx.channel, {
      includeInternal: role.kind === 'internal',
      runtimeDriver: config.runtime.driver,
    })),
  )
  const systemPrompt = await buildPromptForRole(role, {
    tools,
    config,
    cwd: currentCtx.cwd,
    sessionId,
    environmentRoot: getRuntime().workspaceRoot,
    scratchRoot: getRuntime().scratchRoot,
  })
  const childCtx = {
    ...currentCtx,
    sessionId,
    currentRole: role,
    currentTaskRunId: run.id,
    discoveredTools: new Map(),
    turnCounter: 0,
    enabledSecrets: undefined,
  }
  try {
    const result = await runWithSessionContext(childCtx, async () =>
      query({
        role,
        invocation: forkInvocationContext({
          systemPrompt,
          canUseTool: deriveCanUseTool(role),
          cacheBreakpointMessageIndex: 0,
          currentRoleOverride: role,
          persistMessages: async (batch) => {
            await appendMessagesAfterSeed(sessionId, batch)
          },
          rewriteMessages: async (nextMessages) => {
            await rewriteTranscript(sessionId, nextMessages)
            await touchMeta(sessionId, nextMessages.length)
          },
        }),
        messages,
        tools,
        config,
      }),
    )
    const latest = await getTaskRun(run.id, run.ownerCanonicalUser)
    if (latest?.status === 'running') {
      await markDelivered(
        run.id,
        { ok: true, summary: (result.assistantText || '(resumed turn returned empty text)').slice(0, 500) },
        Date.now(),
        run.ownerCanonicalUser,
      )
    }
    return {
      ok: true,
      run: (await getTaskRun(run.id, run.ownerCanonicalUser)) ?? run,
      mode,
      assistantText: result.assistantText,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await markDelivered(run.id, { ok: false, error: message.slice(0, 500) }, Date.now(), run.ownerCanonicalUser)
    return { ok: false, reason: 'query-failed', message }
  }
}

async function appendMessagesAfterSeed(sessionId: string, batch: Parameters<typeof appendMessage>[1][]): Promise<void> {
  const { appendMessages } = await import('../session/storage.js')
  await appendMessages(sessionId, batch)
  const transcript = await loadTranscript(sessionId)
  await touchMeta(sessionId, transcript.length)
}

async function taskObjective(run: TaskRunMeta): Promise<string> {
  const created = (await getTaskRunEvents(run.id, { limit: 0 }, run.ownerCanonicalUser))
    .find(event => event.kind === 'created') as { objective?: string } | undefined
  return created?.objective ?? run.title
}

function formatResumeBlock(run: TaskRunMeta, block: ResumeRunBlock, mode: 'resume' | 'rebuild'): string {
  const checkpoint = run.checkpoint ?? run.latestProgress?.label ?? run.outcome?.summary
  return [
    `<taskrun-resume runId="${escapeAttr(run.id)}" via="${escapeAttr(block.via)}" mode="${mode}">`,
    `<reason>${block.reason}</reason>`,
    checkpoint ? `<checkpoint>${checkpoint}</checkpoint>` : '',
    '<reconcile>Before continuing, verify the last claimed state against the workspace or artifacts, then proceed from the verified state.</reconcile>',
    block.body,
    '</taskrun-resume>',
  ].filter(Boolean).join('\n')
}

function formatRebuildSeed(run: TaskRunMeta, objective: string, block: ResumeRunBlock): string {
  return [
    `<taskrun-rebuild-seed runId="${escapeAttr(run.id)}" via="${escapeAttr(block.via)}">`,
    `<objective>${objective}</objective>`,
    `<checkpoint>${run.checkpoint ?? '(no checkpoint)'}</checkpoint>`,
    `<reason>${block.reason}</reason>`,
    '</taskrun-rebuild-seed>',
  ].join('\n')
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}
