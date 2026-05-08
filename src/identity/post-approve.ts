import { getConfig } from '../config.js'
import { getImageReadiness, getRuntimePool } from '../state.js'
import type { SenderKey } from './types.js'

export function preheatAndWelcomeOnApproval(name: string, link: SenderKey): void {
  void runApprovalPreheat(name, link).catch(error => {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[preheat-on-approval] ${name}: unhandled ${detail}\n`)
  })
}

async function runApprovalPreheat(name: string, link: SenderKey): Promise<void> {
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
  await sender
    .sendInteractiveCardToOpenId(openId, buildApprovalWelcomeCard())
    .catch(pushError => {
      const pd = pushError instanceof Error ? pushError.message : String(pushError)
      process.stderr.write(`[preheat-on-approval] ${name}: welcome push send failed: ${pd}\n`)
    })
}
