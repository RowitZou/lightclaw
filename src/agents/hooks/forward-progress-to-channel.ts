import { getSessionId } from '../../state.js'
import { getSignalRouter } from '../../signal-bus/router.js'
import type { AgentSignal } from '../../signal-bus/types.js'
import type { Hook, HookContext } from './types.js'

const RATE_LIMIT_MS = 5000

const activeMainSessions = new Map<string, HookContext>()
const lastForwardedAtBySession = new Map<string, number>()
let unsubscribeProgress: (() => void) | null = null

export const forwardProgressToChannelHook: Hook = {
  name: 'forward-progress-to-channel',
  beforeTurn(ctx) {
    if (ctx.role.agentType !== 'main' || !ctx.invocation.onAssistantTurn) {
      return
    }
    ensureProgressSubscription()
    activeMainSessions.set(getSessionId(), ctx)
  },
  afterEndTurn() {
    activeMainSessions.delete(getSessionId())
  },
}

export function resetForwardProgressToChannelForTest(): void {
  activeMainSessions.clear()
  lastForwardedAtBySession.clear()
  if (unsubscribeProgress) {
    unsubscribeProgress()
    unsubscribeProgress = null
  }
}

function ensureProgressSubscription(): void {
  if (unsubscribeProgress) {
    return
  }
  unsubscribeProgress = getSignalRouter().subscribe(
    { kind: 'role', id: 'main' },
    signal => handleProgressSignal(signal),
  )
}

async function handleProgressSignal(signal: AgentSignal): Promise<void> {
  if (signal.kind !== 'progress') {
    return
  }
  const progressSignal = signal as AgentSignal<'progress'>
  const sessionId = signal.to.kind === 'role'
    ? signal.to.sessionId
    : undefined
  if (!sessionId) {
    return
  }
  const ctx = activeMainSessions.get(sessionId)
  const onAssistantTurn = ctx?.invocation.onAssistantTurn
  if (!onAssistantTurn) {
    return
  }
  const last = lastForwardedAtBySession.get(sessionId) ?? 0
  if (progressSignal.timing.emittedAt - last < RATE_LIMIT_MS) {
    return
  }
  lastForwardedAtBySession.set(sessionId, progressSignal.timing.emittedAt)
  await onAssistantTurn(formatProgress(progressSignal.payload))
}

function formatProgress(payload: AgentSignal<'progress'>['payload']): string {
  const breadcrumb = formatBreadcrumb(payload.chainPath)
  const body = `Progress: ${payload.completedCount}/${payload.totalCount} completed - ${payload.milestoneLabel}`
  return breadcrumb ? `${breadcrumb} ${body}` : body
}

// Worker-triggered progress arrives via this hook through the chain-root
// (main) sessionId. Render the chain breadcrumb (`[main → webSearcher]`)
// to match worker-activity-stream's prefix so users can attribute each
// progress line. main-triggered progress (chainPath length 1) stays bare.
function formatBreadcrumb(chainPath: readonly string[] | undefined): string {
  if (!chainPath || chainPath.length <= 1) {
    return ''
  }
  return `[${chainPath.join(' → ')}]`
}
