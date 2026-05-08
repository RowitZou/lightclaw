import { randomUUID } from 'node:crypto'

import { getConfig } from '../config.js'
import { getImageReadiness, getRuntimePool } from '../state.js'
import { isAdmin } from './store.js'
import type { SenderKey } from './types.js'

export type PreheatOptions = {
  /**
   * The applicant's pre-approval text, captured from the pending entry
   * (or directly from the application card state when called from the
   * card flow). When non-empty AND the welcome card push reports a DM
   * chat_id, post-approve replays this text through the channel runner
   * so the user's first message is actually answered. Empty / missing
   * text simply skips replay; daemon shutdown / restart between approval
   * and welcome is tolerated because pending.json is the durable source
   * of truth.
   */
  applicantText?: string
}

export function preheatAndWelcomeOnApproval(
  name: string,
  link: SenderKey,
  opts: PreheatOptions = {},
): void {
  void runApprovalPreheat(name, link, opts).catch(error => {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[preheat-on-approval] ${name}: unhandled ${detail}\n`)
  })
}

async function runApprovalPreheat(
  name: string,
  link: SenderKey,
  opts: PreheatOptions,
): Promise<void> {
  const config = getConfig()
  const backend = config.runtime.backend
  if (backend !== 'docker' && backend !== 'rlaunch') {
    return
  }
  if (backend === 'rlaunch' && !config.runtime.rlaunch.preheatOnApproval) {
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
  // dropped on the floor. Requires:
  //   - a stashed text (the applicant actually said something with their
  //     first contact, not just an empty mention)
  //   - the welcome card send returned a chat_id (so the synthetic
  //     replay message lands in the same DM session future inbound
  //     messages will use, keeping transcript continuity)
  //   - the channel runner is registered (the daemon owns one)
  // All three are best-effort — replay is a UX nicety, not a correctness
  // contract; if any prerequisite is missing we log to stderr and stop.
  const applicantText = opts.applicantText?.trim()
  if (!applicantText) {
    return
  }
  const dmChatId = sendResult?.chatId
  if (!dmChatId) {
    process.stderr.write(
      `[preheat-on-approval] ${name}: welcome card returned no chat_id; skipping replay\n`,
    )
    return
  }
  const { getChannelRunner } = await import('../channels/feishu/runner-registry.js')
  const runner = getChannelRunner()
  if (!runner) {
    process.stderr.write(
      `[preheat-on-approval] ${name}: channel runner not registered; skipping replay\n`,
    )
    return
  }
  // Construct a minimal NormalizedChannelMessage matching what an actual
  // inbound DM from this user would look like. chatType='p2p' so it
  // routes to feishu:dm:<chatId> per Phase 26. eventId / messageId have
  // a 'replay-' prefix for grep-ability in dedup / api-logs (the dedup
  // layer is bypassed here — dedup runs in feishu-channel onMessage,
  // before this synthetic injection point).
  process.stderr.write(
    `[preheat-on-approval] ${name}: replaying pre-approval text (${applicantText.length} chars) into ${dmChatId}\n`,
  )
  await runner.handleMessage({
    channel: 'feishu',
    eventId: `replay-${randomUUID()}`,
    chatId: dmChatId,
    senderOpenId: openId,
    senderKey: link,
    chatType: 'p2p',
    messageId: `replay-${randomUUID()}`,
    text: applicantText,
  }).catch(error => {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[preheat-on-approval] ${name}: replay failed: ${detail}\n`)
  })
}
