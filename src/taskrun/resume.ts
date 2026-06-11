import { randomUUID } from 'node:crypto'

import { channelInterjectionQueue } from '../channels/feishu/interjection-queue.js'
import { getSignalRouter } from '../signal-bus/router.js'
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
  | { ok: true; run: TaskRunMeta; mode: 'resume' | 'rebuild' | 'interjection'; assistantText: string }
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

  // Awake-already guard ("没醒就唤醒、醒了就插嘴" applied to workers): if the
  // run's last session still has a turn in flight — e.g. a worker asked,
  // parked at paused(awaiting-reply), and the answer arrived before its turn
  // wound down — starting a second agent loop on the same session would race
  // the live one on a single transcript. Join the live turn instead: deliver
  // the block as an interjection and flip the ledger back to running; the
  // live turn's settle-on-return takes it from there.
  const liveSessionId = run.lastSessionId ?? run.currentSessionId
  if (liveSessionId && isSessionTurnInFlight(liveSessionId)) {
    const interjected = formatResumeBlock(run, block, 'resume')
    channelInterjectionQueue.push(liveSessionId, {
      messageId: `taskrun-resume-${run.id}-${Date.now()}`,
      senderOpenId: `taskrun:${run.id}`,
      text: interjected,
      arrivedAt: Date.now(),
      source: 'background-task',
    })
    if (run.status === 'waiting') {
      await markResumed(run.id, { via: block.via, reason: block.reason, sessionId: liveSessionId }, Date.now(), run.ownerCanonicalUser)
    }
    return {
      ok: true,
      run: (await getTaskRun(run.id, run.ownerCanonicalUser)) ?? run,
      mode: 'interjection',
      assistantText: '',
    }
  }

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
  const gapSince = run.waitingAt ?? run.deliveredAt ?? run.updatedAt
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
    currentTaskRunId: run.id,
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

function isSessionTurnInFlight(sessionId: string): boolean {
  return channelInterjectionQueue.hasInflightFor(sessionId) ||
    getSignalRouter().getAllActiveSessionIds().has(sessionId)
}

/** Child reached delivered → if its parent is parked at paused(child-join)
 *  waiting for exactly this child, hand the parent its result and resume the
 *  shift. Called from BOTH delivery paths — TaskUpdate explicit deliver and
 *  the scheduler's settle-on-return — or a parent awaiting a fire that never
 *  self-reports would sleep forever. Detached: the delivering caller must not
 *  sit inside the parent's whole next shift. */
export async function wakeParentForChildJoinBestEffort(
  ownerCanonicalUser: string,
  child: TaskRunMeta,
): Promise<void> {
  if (!child.parentRunId) return
  const parent = await getTaskRun(child.parentRunId, ownerCanonicalUser)
  if (parent?.status !== 'waiting') return
  if (parent.wake?.kind !== 'child-join' || parent.wake.runId !== child.id || parent.wake.consumed) return
  const summary = child.outcome?.summary ?? child.outcome?.error ?? child.title
  const { scheduleResumeRunWithBlock } = await import('./resume-schedule.js')
  scheduleResumeRunWithBlock(ownerCanonicalUser, parent.id, {
    via: 'child-join',
    reason: `child ${child.id} delivered`,
    body: [
      '<taskrun-child-result>',
      `runId=${child.id}`,
      `status=${child.status}`,
      summary,
      '</taskrun-child-result>',
    ].join('\n'),
  })
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
