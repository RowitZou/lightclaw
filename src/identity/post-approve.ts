import { randomUUID } from 'node:crypto'

import type { NormalizedChannelMessage } from '../channels/types.js'
import { getConfig } from '../config.js'
import { getImageReadiness, getRuntimePool } from '../state.js'
import { isAdmin } from './store.js'
import type { SenderKey } from './types.js'

export type PreheatOptions = {
  /**
   * The applicant's pre-approval text, captured from the pending entry
   * (or directly from the application card state when called from the
   * card flow). When non-empty, post-approve replays this text through
   * the channel runner so the user's first @ message is actually
   * answered. Empty / missing text simply skips replay; daemon shutdown
   * / restart between approval and welcome is tolerated because
   * pending.json is the durable source of truth.
   */
  applicantText?: string
  /**
   * The chatId where the user originally @'d the bot. Replay routes
   * the agent reply HERE (group → group, DM → DM), preserving the
   * "user-asked-where-the-agent-answers" continuity. Welcome / pairing
   * / permission cards remain DM-only by separate design — the
   * privacy boundary and the agent-conversation continuity boundary
   * are different concerns. When missing (old pending.json shape),
   * fall back to the welcome card's DM chat_id (always-DM degraded
   * default).
   */
  applicantChatId?: string
  /**
   * Drives Phase 26 sessionId routing on replay (`feishu:dm:<chatId>`
   * vs `feishu:group:<chatId>:<senderOpenId>`). Defaults to 'p2p'.
   */
  applicantChatType?: string
  /**
   * Feishu topic-group thread id of the original @. Two duties on replay:
   * sessionId routing (`feishu:group:<chatId>:<threadId>:<sender>` must
   * match the user's future in-topic inbounds, or the transcript splits)
   * and outbound thread targeting. Only meaningful with applicantChatId.
   */
  applicantThreadId?: string
  /**
   * Real platform messageId of the original @. Rides the synthetic replay
   * message as `replyAnchorMessageId` so every outbound in the replay turn
   * goes through `im.message.reply` against the user's actual message —
   * in a topic group that is the ONLY way to land in the original topic
   * (`im.message.create` cannot target a thread and opens a NEW topic per
   * message; 2026-06-10 dogfood).
   */
  applicantMessageId?: string
}

// Fire-and-forget preheat promises tracked here so callers can drain on
// shutdown (avoid mid-mkdir at process exit) and tests can await before
// their afterEach tears down `setLightclawHomeOverride` — without the
// drain, the floating preheat promise outlives the override and
// `RuntimePool.acquire()` reads the *real* `~/.lightclaw/config.json`,
// silently mkdir'ing the per-user workspace inside the production user tree
// (e.g. `claw_data/users/<derived-name>/workspace`).
const pendingPreheats = new Set<Promise<void>>()

export function preheatAndWelcomeOnApproval(
  name: string,
  link: SenderKey,
  opts: PreheatOptions = {},
): void {
  const promise = runApprovalPreheat(name, link, opts)
    .catch(error => {
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(`[preheat-on-approval] ${name}: unhandled ${detail}\n`)
    })
    .finally(() => {
      pendingPreheats.delete(promise)
    })
  pendingPreheats.add(promise)
}

export async function drainPendingPreheats(timeoutMs = 60_000): Promise<void> {
  if (pendingPreheats.size === 0) {
    return
  }
  const TIMEOUT = Symbol('preheat-drain-timeout')
  await Promise.race([
    Promise.allSettled([...pendingPreheats]),
    new Promise<typeof TIMEOUT>(resolve =>
      setTimeout(() => resolve(TIMEOUT), timeoutMs).unref(),
    ),
  ])
}

async function runApprovalPreheat(
  name: string,
  link: SenderKey,
  opts: PreheatOptions,
): Promise<void> {
  const config = getConfig()
  const backend = config.runtime.backend
  if (backend !== 'docker' && backend !== 'cluster') {
    return
  }
  if (backend === 'cluster' && !config.runtime.clusterSettings.preheatOnApproval) {
    return
  }

  const channel = link.split(':', 1)[0]
  if (channel !== 'feishu') {
    const runtime = backend === 'docker'
      ? getRuntimePool().acquire(name, config, undefined, getImageReadiness())
      : getRuntimePool().acquire(name, config)
    await runtime.start().catch(error => {
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(`[preheat-on-approval] ${name}: ${detail}\n`)
    })
    return
  }

  const openId = link.slice('feishu:'.length)
  const { getFeishuSender } = await import('../channels/feishu/sender-registry.js')
  const { buildApprovalWelcomeCard, buildStartupFailureCard } =
    await import('../channels/feishu/welcome-card.js')
  const { waitUntilRuntimeAvailable } = await import('../runtime/wait-ready.js')

  const sender = getFeishuSender()
  if (!sender) {
    process.stderr.write(
      `[preheat-on-approval] ${name}: feishu sender not registered; preheating without welcome push\n`,
    )
    const runtime = backend === 'docker'
      ? getRuntimePool().acquire(name, config, undefined, getImageReadiness())
      : getRuntimePool().acquire(name, config)
    await runtime.start().catch(error => {
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(`[preheat-on-approval] ${name}: ${detail}\n`)
    })
    return
  }

  // Eager Feishu cloud workspace create. The lazy path inside the agent
  // tools (resolveCurrentFeishuWorkspace) probes the workspace on every
  // tool call, so creating it once here at pairing-approval time amortizes
  // away the first-use latency and lets admin `/feishu-workspace list`
  // see the binding immediately. Fire-and-forget — best-effort, never
  // blocks the welcome push. Folder name is `name` (canonical user), not
  // the Feishu open_id, so admin and the user both see a recognizable
  // folder name in Feishu UI.
  void preheatFeishuWorkspace(name, openId)

  const tracker = backend === 'docker' ? getImageReadiness() : undefined
  const runtime = getRuntimePool().acquire(name, config, undefined, tracker)
  try {
    await runtime.start()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[preheat-on-approval] ${name}: start failed: ${detail}\n`)
    await sender
      .sendInteractiveCardToOpenId(
        openId,
        buildStartupFailureCard({ reason: detail, elapsedSeconds: 0, timedOut: false }),
      )
      .catch(pushError => {
        const pd = pushError instanceof Error ? pushError.message : String(pushError)
        process.stderr.write(`[preheat-on-approval] ${name}: failure push send failed: ${pd}\n`)
      })
    return
  }

  const ready = await waitUntilRuntimeAvailable(runtime)
  if (!ready.ok) {
    const elapsedSeconds = Math.round(ready.elapsedMs / 1000)
    const reason =
      ready.availability.ok === false
        ? ready.availability.adminMessage || ready.availability.userMessage || ready.availability.reason
        : 'unknown'
    process.stderr.write(
      `[preheat-on-approval] ${name}: not ready after ${elapsedSeconds}s (timedOut=${ready.timedOut}): ${reason}\n`,
    )
    await sender
      .sendInteractiveCardToOpenId(
        openId,
        buildStartupFailureCard({ reason, elapsedSeconds, timedOut: ready.timedOut }),
      )
      .catch(pushError => {
        const pd = pushError instanceof Error ? pushError.message : String(pushError)
        process.stderr.write(`[preheat-on-approval] ${name}: failure push send failed: ${pd}\n`)
      })
    return
  }

  const elapsedSeconds = Math.round(ready.elapsedMs / 1000)
  process.stderr.write(
    `[preheat-on-approval] ${name}: runtime ready after ${elapsedSeconds}s; sending welcome card\n`,
  )
  const recipientIsAdmin = await isAdmin(name)
  const sendResult = await sender
    .sendInteractiveCardToOpenId(openId, buildApprovalWelcomeCard({ isAdmin: recipientIsAdmin }))
    .catch(pushError => {
      const pd = pushError instanceof Error ? pushError.message : String(pushError)
      process.stderr.write(`[preheat-on-approval] ${name}: welcome push send failed: ${pd}\n`)
      return null
    })

  // Replay the pre-approval message so the user's first @ doesn't get
  // dropped on the floor. Requires only a target chatId now — we replay
  // even when applicantText is empty (just `@bot` with no body) so the
  // LLM can greet via the bare `[senderName] ` prefix per 9af7001.
  // Routing rules:
  //   - target chatId: prefer the original chat from the pending entry
  //     (group → group, DM → DM); fall back to the welcome card's DM
  //     chat_id when unknown, e.g. old pending.json files written before
  //     this field was tracked.
  //   - the channel runner must be registered (the daemon owns one).
  // Both are best-effort — replay is a UX nicety, not a correctness
  // contract; if any prerequisite is missing we log to stderr and stop.
  const applicantText = opts.applicantText?.trim() ?? ''
  const replayChatId = opts.applicantChatId ?? sendResult?.chatId
  if (!replayChatId) {
    process.stderr.write(
      `[preheat-on-approval] ${name}: no replay chatId (no original chat stashed and welcome card returned no chat_id); skipping replay\n`,
    )
    return
  }
  const replayChatType = opts.applicantChatType ?? 'p2p'
  const replayingTo = opts.applicantChatId ? 'origin' : 'dm-fallback'
  const { getChannelRunner } = await import('../channels/feishu/runner-registry.js')
  const runner = getChannelRunner()
  if (!runner) {
    process.stderr.write(
      `[preheat-on-approval] ${name}: channel runner not registered; skipping replay\n`,
    )
    return
  }
  process.stderr.write(
    `[preheat-on-approval] ${name}: replaying pre-approval text (${applicantText.length} chars) ${replayingTo}=${replayChatId} type=${replayChatType}${opts.applicantThreadId ? ` thread=${opts.applicantThreadId}` : ''}\n`,
  )
  await runner.handleMessage(synthesizeReplayMessage({
    openId,
    senderKey: link,
    chatId: replayChatId,
    chatType: replayChatType,
    text: applicantText,
    // Thread routing + reply anchor only make sense for an origin-chat
    // replay; the stash writes them together with chatId, so anchor
    // present ⇒ origin chat present. The DM-fallback path (old
    // pending.json shapes) carries neither.
    threadId: replayingTo === 'origin' ? opts.applicantThreadId : undefined,
    anchorMessageId: replayingTo === 'origin' ? opts.applicantMessageId : undefined,
  })).catch(error => {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[preheat-on-approval] ${name}: replay failed: ${detail}\n`)
  })
}

/**
 * Construct the minimal synthetic NormalizedChannelMessage the post-approval
 * replay feeds into ChannelRunner.handleMessage, matching what the user's
 * actual @bot looked like. chatType AND threadId drive the Phase 26
 * sessionId formula (`feishu:group:<chatId>[:<threadId>]:<sender>`) so the
 * replay turn lands in the same transcript the user's future inbounds will
 * continue — omitting threadId for a topic-group origin splits the
 * transcript AND forces every outbound onto `im.message.create`, which
 * opens a new topic per message. `replyAnchorMessageId` carries the real
 * messageId of the original @ so the sender can reply against it
 * (`im.message.reply` resolves the topic off the anchor). eventId /
 * messageId keep the 'replay-' prefix for grep-ability; dedup is bypassed
 * because the message never went through feishu-channel onMessage. The
 * synthetic flag still short-circuits typing reactions and tells the
 * sender the messageId itself is not replyable.
 */
export function synthesizeReplayMessage(input: {
  openId: string
  senderKey: SenderKey
  chatId: string
  chatType: string
  text: string
  threadId?: string
  anchorMessageId?: string
}): NormalizedChannelMessage {
  return {
    channel: 'feishu',
    eventId: `replay-${randomUUID()}`,
    chatId: input.chatId,
    senderOpenId: input.openId,
    senderKey: input.senderKey,
    chatType: input.chatType,
    messageId: `replay-${randomUUID()}`,
    text: input.text,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.anchorMessageId ? { replyAnchorMessageId: input.anchorMessageId } : {}),
    synthetic: true,
  }
}

async function preheatFeishuWorkspace(name: string, openId: string): Promise<void> {
  try {
    const { getFeishuClient } = await import('../channels/feishu/client.js')
    const { getOrCreateUserWorkspace, getOrCreateWorkspaceRoot } =
      await import('../channels/feishu/workspace/lifecycle.js')
    const client = getFeishuClient()
    const root = await getOrCreateWorkspaceRoot(client)
    await getOrCreateUserWorkspace(client, name, openId, root)
    process.stderr.write(`[preheat-on-approval] ${name}: feishu workspace ready\n`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[preheat-on-approval] ${name}: feishu workspace preheat failed: ${detail}\n`)
  }
}
