import { randomUUID } from 'node:crypto'

import { channelInterjectionQueue, type InterjectionEntry } from '../channels/feishu/interjection-queue.js'
import { getSignalRouter } from '../signal-bus/router.js'
import { getAgent } from '../agents/registry.js'
import { forkInvocationContext } from '../agents/invocation-context.js'
import { buildWorkerProgressForwarder } from './worker-progress.js'
import { deriveCanUseTool, filterToolsByRoleVisibility } from '../agents/role-tool-gate.js'
import { resolveDispatchedFireSecrets } from '../agents/dispatch-secrets.js'
import { loadBackgroundTasks } from '../background-task/store.js'
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
  queryImpl: typeof query = query,
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
  // run's turn is still in flight — e.g. a worker asked, parked at
  // paused(awaiting-reply), and the answer arrived before its turn wound down —
  // starting a second agent loop on the same session would race the live one on
  // a single transcript. Join the live turn instead: deliver the block as an
  // interjection and flip the ledger back to running; the live turn's
  // settle-on-return takes it from there.
  //
  // Two distinct session ids are at play and must not be conflated: the live
  // ADDRESS (the worker's chain-leaf sessionId, where its agent loop reports
  // active and drains interjections) and the transcript LOCATION (the
  // bg-session its messages persist under). For a background worker these
  // diverge — checking/pushing the transcript session would miss the in-flight
  // turn (its chain leaf, not the bg session, is in the active set) and orphan
  // the interjection, dropping us into the fresh-shift path that then races the
  // still-running worker on its transcript.
  const inboxSessionId = run.interjectionSessionId ?? run.lastSessionId ?? run.currentSessionId
  const transcriptSessionId = run.lastSessionId ?? run.currentSessionId
  if (inboxSessionId && isSessionTurnInFlight(inboxSessionId)) {
    const interjected = formatResumeBlock(run, block, 'resume')
    channelInterjectionQueue.push(inboxSessionId, {
      messageId: `taskrun-resume-${run.id}-${Date.now()}`,
      senderOpenId: `taskrun:${run.id}`,
      text: interjected,
      arrivedAt: Date.now(),
      source: 'background-task',
    })
    if (run.status === 'waiting') {
      // sessionId here feeds currentSessionId (the transcript locator), so it
      // stays the transcript session, never the chain-leaf address.
      await markResumed(run.id, { via: block.via, reason: block.reason, sessionId: transcriptSessionId ?? inboxSessionId }, Date.now(), run.ownerCanonicalUser)
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
  // Re-grant top-level-fire secrets on resume using the SAME gate the initial
  // fire used (resolveDispatchedFireSecrets). A TaskRunMeta carries no
  // chainState, so reload it from the backing bg entry — that is the exact
  // chainState dispatched-agent evaluated at fire time, so a resumed shift of a
  // top-level main fire keeps `$GH_TOKEN` and a resumed sub-worker / internal
  // shift stays stripped, with no separate predicate to drift. If the entry is
  // gone (e.g. a swept oneshot) there is nothing to prove eligibility, so the
  // safe fallback is no secrets.
  const fireChainState = loadBackgroundTasks(run.ownerCanonicalUser)
    .find(e => e.taskRunId === run.id || e.standingRootRunId === run.id)
    ?.chainState
  const resumedSecrets = resolveDispatchedFireSecrets(
    fireChainState,
    role,
    run.ownerCanonicalUser,
  )
  const systemPrompt = await buildPromptForRole(role, {
    tools,
    config,
    cwd: currentCtx.cwd,
    sessionId,
    environmentRoot: getRuntime().workspaceRoot,
    scratchRoot: getRuntime().scratchRoot,
    currentTaskRunId: run.id,
    enabledSecrets: resumedSecrets,
  })
  const childCtx = {
    ...currentCtx,
    sessionId,
    currentRole: role,
    currentTaskRunId: run.id,
    discoveredTools: new Map(),
    turnCounter: 0,
    enabledSecrets: resumedSecrets,
  }
  // The resumed turn now owns this run's inbox. Mark it in-flight so a message
  // arriving mid-turn — a user interjecting a resumed main, an agent Message
  // interjecting a resumed worker — is queued and drained at this turn's tool
  // boundaries (interjectionDrain above) instead of racing a second agent loop
  // onto the same transcript: resume runs outside the channel's per-session
  // lock, so this flag is the only thing serialising a concurrent channel turn
  // against it. Marked here, after the prep I/O, so a throw before this point
  // never leaks the flag; released — with leftover rescue — in the finally.
  if (inboxSessionId) channelInterjectionQueue.markInFlight(inboxSessionId)
  // Resumed shifts forward their assistant-block narration to this run's own
  // progress timeline, exactly as the initial dispatched fire does in
  // runDispatchedAgent. Without it, every shift after the first park (waiting →
  // resumed) silently drops its narration from the task card — only TodoWrite
  // progress (appended from inside the tool) would keep showing, leaving the
  // card's "执行过程" timeline frozen at the pre-park narration. The throttle
  // state in worker-progress.ts is keyed by taskRunId, so a fresh forwarder
  // here shares the same throttle window as the original fire's forwarder.
  const activityForwarder = buildWorkerProgressForwarder({
    taskRunId: run.id,
    ...(run.ownerCanonicalUser ? { ownerCanonicalUser: run.ownerCanonicalUser } : {}),
  })
  try {
    const result = await runWithSessionContext(childCtx, async () =>
      queryImpl({
        role,
        invocation: forkInvocationContext({
          systemPrompt,
          canUseTool: deriveCanUseTool(role),
          cacheBreakpointMessageIndex: 0,
          currentRoleOverride: role,
          onAssistantTurn: activityForwarder,
          // Drain interjections that arrived for this run's inbox at every tool
          // boundary while the resumed turn runs — a user interjecting a
          // resumed main, or an agent Message interjecting a resumed worker —
          // exactly as a normal channel turn and a dispatched worker do. The
          // inbox key is the run's chain-leaf / channel address, distinct from
          // the transcript location; the markInFlight below pairs with it.
          ...(inboxSessionId
            ? { interjectionDrain: () => channelInterjectionQueue.drain(inboxSessionId) }
            : {}),
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
    // Turn-end is where this run's full final reply exists, so a parent parked
    // on child-join is woken from here — carrying the final text, not the capped
    // ledger summary. Covers both the auto-deliver above and a worker that
    // self-delivered mid-turn via TaskUpdate (status already 'delivered', so the
    // markDelivered above no-ops, but the parent still needs the full result).
    const settled = (await getTaskRun(run.id, run.ownerCanonicalUser)) ?? run
    if (settled.status === 'delivered') {
      await wakeParentForChildJoinBestEffort(run.ownerCanonicalUser, settled, result.assistantText)
    }
    return {
      ok: true,
      run: settled,
      mode,
      assistantText: result.assistantText,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const failed = await markDelivered(run.id, { ok: false, error: message.slice(0, 500) }, Date.now(), run.ownerCanonicalUser)
    // A child-join parent must learn the run delivered-with-failure too; no
    // resultText, so the wake falls back to the recorded error.
    if (failed) {
      await wakeParentForChildJoinBestEffort(run.ownerCanonicalUser, failed)
    }
    return { ok: false, reason: 'query-failed', message }
  } finally {
    if (inboxSessionId) {
      const leftover = channelInterjectionQueue.unmarkInFlight(inboxSessionId)
      if (leftover.length > 0) {
        // Interjections that landed after this turn's last tool-boundary drain
        // (during settle / parent-wake) would otherwise be dropped by
        // unmarkInFlight. Re-deliver each — a channel inbox (resumed main) gets
        // a fresh synthetic turn, a worker chain-leaf falls back to the queue
        // for its next resume — mirroring the channel runner's post-query
        // leftover rescue. Detached: never block this return on a replayed turn.
        void rescueLeftoverInterjections(inboxSessionId, leftover)
      }
    }
  }
}

/** Re-deliver interjections that outlived a resumed turn's last tool boundary
 *  so unmarkInFlight does not silently drop them (the channel runner's Bug 9
 *  rescue, applied to the resume path). wakeOrInterject routes by address: a
 *  channel session starts a fresh synthetic turn, a worker chain-leaf queues
 *  for its next resume. Best-effort and self-contained — a rescue failure must
 *  never mask the resumed turn's own outcome. */
async function rescueLeftoverInterjections(
  inboxSessionId: string,
  leftover: InterjectionEntry[],
): Promise<void> {
  const { wakeOrInterject } = await import('../channels/feishu/wake-or-interject.js')
  const { traceInterjection, waitedMs } = await import('../channels/feishu/interjection-trace.js')
  for (const entry of leftover) {
    traceInterjection('rescued', {
      session: inboxSessionId,
      msg: entry.messageId,
      source: entry.source,
      waitedMs: waitedMs(entry.arrivedAt),
      via: 'resume-replay',
    })
    try {
      await wakeOrInterject({
        targetSessionId: inboxSessionId,
        block: entry.text,
        ownerOpenId: entry.senderOpenId,
        messageId: entry.messageId,
        emittedAt: entry.arrivedAt,
        logPrefix: '[taskrun-resume]',
        ...(entry.taskCardRoot ? { taskCardRoot: entry.taskCardRoot } : {}),
      })
    } catch (error) {
      process.stderr.write(
        `[taskrun-resume] leftover interjection rescue failed for ${inboxSessionId}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      )
    }
  }
}

function isSessionTurnInFlight(sessionId: string): boolean {
  return channelInterjectionQueue.hasInflightFor(sessionId) ||
    getSignalRouter().getAllActiveSessionIds().has(sessionId)
}

/** Child reached delivered → if its parent is parked at paused(child-join)
 *  waiting for exactly this child, hand the parent its result and resume the
 *  shift. Called from the child's turn-end delivery paths — the scheduler's
 *  settle-on-return for a fire, and resume.ts for a resumed run — because that
 *  is where the child's full final reply exists. Returns whether it actually
 *  scheduled a parent resume, so the caller can suppress a now-redundant
 *  bg-result notification to the same parent. Detached: the delivering caller
 *  must not sit inside the parent's whole next shift.
 *
 *  `resultText` is the child's full final reply (the live delivery paths have
 *  it in hand). The ledger `outcome.summary` is a capped card label and is only
 *  the fallback for cold backstops — the watchdog reconcile — that have no live
 *  final text. A parent that explicitly waited on this child is owed the full
 *  reply, not the label. */
export async function wakeParentForChildJoinBestEffort(
  ownerCanonicalUser: string,
  child: TaskRunMeta,
  resultText?: string,
): Promise<boolean> {
  if (!child.parentRunId) return false
  const parent = await getTaskRun(child.parentRunId, ownerCanonicalUser)
  if (parent?.status !== 'waiting') return false
  if (parent.wake?.kind !== 'child-join' || parent.wake.runId !== child.id || parent.wake.consumed) return false
  const resultBody = resultText?.trim() || child.outcome?.summary || child.outcome?.error || child.title
  const { scheduleResumeRunWithBlock } = await import('./resume-schedule.js')
  scheduleResumeRunWithBlock(ownerCanonicalUser, parent.id, {
    via: 'child-join',
    reason: `child ${child.id} delivered`,
    body: [
      '<taskrun-child-result>',
      `runId=${child.id}`,
      `status=${child.status}`,
      resultBody,
      '</taskrun-child-result>',
      'Settle it (TaskUpdate accept / reject) and continue your task with the result.',
    ].join('\n'),
  })
  return true
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
    block.body,
    '</taskrun-resume>',
    '',
    'You are picking your own task back up — everything above is your earlier work on it, and the block carries why you are back. Before continuing, reconcile: things may have changed while you were away (files, processes, the world). Verify the specific facts you previously reported or checkpointed before building on them. Then continue the task from where it stands, folding in what the block brought you.',
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
