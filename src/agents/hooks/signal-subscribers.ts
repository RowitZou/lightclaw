import { ensureBackgroundResultToInterjectionSubscription } from './background-result-to-interjection.js'
import { ensureChainAbortPropagationSubscription } from './chain-abort-propagation.js'

/** Bootstrap entry for the process-wide Signal Bus subscriber hooks
 *  (`background-result-to-interjection`, `chain-abort-propagation`).
 *  Per-turn lifecycle subscribers (e.g. `forward-progress-to-channel`)
 *  register themselves through the role hook pipeline, not here. */
export function registerBusSubscribers(): void {
  ensureBackgroundResultToInterjectionSubscription()
  ensureChainAbortPropagationSubscription()
}
