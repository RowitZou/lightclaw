import { ensureBackgroundResultToInterjectionSubscription } from './background-result-to-interjection.js'
import { ensureChainAbortPropagationSubscription } from './chain-abort-propagation.js'

export function initializePhase8SignalSubscribers(): void {
  ensureBackgroundResultToInterjectionSubscription()
  ensureChainAbortPropagationSubscription()
}
