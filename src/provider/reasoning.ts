import type { ReasoningEffort } from './types.js'

/**
 * Map the unified `ReasoningEffort` knob to Anthropic's `output_config.effort`
 * value. Anthropic accepts `low | medium | high | xhigh` (and `max`, which our
 * knob does not expose). It has no `none` / `minimal`:
 *   - `none`    → `null` (the caller omits `thinking` + `output_config`, leaving
 *                 the model with thinking off — Anthropic's own default when no
 *                 `thinking` param is sent).
 *   - `minimal` → `low` (closest supported tier).
 *   - the rest pass through unchanged.
 */
export function anthropicEffort(
  effort: ReasoningEffort,
): 'low' | 'medium' | 'high' | 'xhigh' | null {
  switch (effort) {
    case 'none':
      return null
    case 'minimal':
      return 'low'
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return effort
    default:
      return 'medium'
  }
}

/**
 * True when a wire error looks like the model / endpoint rejecting the
 * reasoning-control fields (`reasoning_effort` for Chat Completions,
 * `reasoning` for Responses, `thinking` / `output_config` for Anthropic
 * Messages). Used by each provider for a one-shot strip-and-retry: a genuinely
 * non-reasoning model (e.g. a plain chat model, or an Anthropic-compatible
 * endpoint that predates `output_config`) degrades to no-reasoning instead of
 * hard-failing the turn.
 *
 * Deliberately narrow: only 4xx request-shape rejections, and only when the
 * message names a reasoning field. 5xx / network / abort never match (those
 * are the global transient-retry path's job), and a 4xx about something else
 * (bad model id, auth) must NOT be silently swallowed into a reasoning strip.
 */
export function isReasoningUnsupportedError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status
  if (typeof status === 'number' && (status < 400 || status >= 500)) {
    return false
  }
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const msg = raw.toLowerCase()
  if (!msg) {
    return false
  }
  // Explicit field names the providers send.
  if (
    msg.includes('reasoning_effort') ||
    msg.includes('output_config') ||
    msg.includes('reasoning.effort')
  ) {
    return true
  }
  // Looser phrasings: a complaint about `effort` / `thinking` / `reasoning`
  // paired with an unsupported / not-allowed / unknown-parameter marker.
  const namesField =
    msg.includes('effort') ||
    msg.includes('thinking') ||
    msg.includes('reasoning')
  const unsupportedMarker =
    msg.includes('unsupported') ||
    msg.includes('not support') ||
    msg.includes('not allowed') ||
    msg.includes('unknown parameter') ||
    msg.includes('unexpected') ||
    msg.includes('does not accept') ||
    msg.includes('not permitted')
  return namesField && unsupportedMarker
}
