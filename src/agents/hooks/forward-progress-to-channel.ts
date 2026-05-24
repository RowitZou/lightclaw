import { t } from '../../i18n/index.js'
import { getSessionId } from '../../state.js'
import { getSignalRouter } from '../../signal-bus/router.js'
import type { AgentSignal } from '../../signal-bus/types.js'
import { resolveDisplayName } from '../role-display.js'
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
  const actor = formatActor(payload.chainPath)
  const body = t('channel.progress.completed', {
    completed: payload.completedCount,
    total: payload.totalCount,
    label: payload.milestoneLabel,
  })
  return actor ? `${actor}｜${body}` : body
}

// Worker-triggered progress arrives via this hook through the chain-root
// (main) sessionId. We render only the LEAF actor — the role actually
// emitting the progress — as a product-language verb phrase ("正在搜索互联网"),
// not the full dispatch chain. Users care about the current action, not the
// dispatcher tree above it; the chain topology is internal scheduling and
// stays out of view per the "user-no-detail-leak" principle.
//
// main-triggered progress (chainPath length ≤ 1) stays bare — the user is
// already talking to main directly and doesn't need a self-prefix.
function formatActor(chainPath: readonly string[] | undefined): string {
  if (!chainPath || chainPath.length <= 1) {
    return ''
  }
  const leaf = chainPath[chainPath.length - 1]!
  // User-defined roles may omit displayName — fall back to a generic label
  // rather than the raw agentType (which would leak internal vocabulary).
  return resolveDisplayName(leaf) ?? t('channel.actor.fallback')
}
