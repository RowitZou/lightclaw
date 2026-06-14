import type { ChainState } from '../signal-bus/chain-state.js'
import type { Role } from './types.js'
import { getAgent } from './registry.js'
import { loadEnabledSecrets } from '../secrets/store.js'

/**
 * Resolve the runtime secrets a dispatched fire may use in its Bash env.
 *
 * Only a TOP-LEVEL fire dispatched DIRECTLY by main — the owner's manager —
 * carries the owner's enabled secrets so owner-authorized actions
 * (authenticated git clone/push, etc.) can run unattended. Every deeper or
 * internal dispatch runs with none, so a secret never propagates further down a
 * chain than the single fire main authorized. See the Phase 18 secret note in
 * CLAUDE.md for the full rationale.
 *
 * Eligibility: the dispatcher node (`chainState.path.at(-2)`) is the
 * orchestrator AND the callee role is not internal. Both the initial dispatch
 * path (`runDispatchedAgent`) and the resume path feed the SAME `chainState`
 * here — the resume path reloads it from the backing bg entry — so the gate can
 * never drift between a fire's first shift and a resumed one. The returned map
 * is also what feeds the worker prompt's `## Available Secrets` section, so env
 * injection and prompt language always come from one source.
 */
export function resolveDispatchedFireSecrets(
  chainState: ChainState | undefined,
  role: Role,
  canonicalUser: string | undefined,
): ReadonlyMap<string, string> | undefined {
  if (role.kind === 'internal' || !canonicalUser) return undefined
  const dispatcherRole = chainState?.path.at(-2)?.role
  if (dispatcherRole === undefined) return undefined
  if (getAgent(dispatcherRole)?.kind !== 'orchestrator') return undefined
  return loadEnabledSecrets(canonicalUser)
}
