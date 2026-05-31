import type { Hook } from './types.js'
import { runCompaction } from './auto-compact.js'
import { isContextOverflowError } from '../../transient-error.js'

export const promptTooLongRetryHook: Hook = {
  name: 'prompt-too-long-retry',
  async onStreamError(error, ctx) {
    // isContextOverflowError covers both the Anthropic ("prompt is too long")
    // and OpenAI/codex ("exceeds the context window of this model") phrasings
    // from the single matcher in transient-error.ts. The earlier local
    // allowlist only matched the Anthropic family, so a codex context-overflow
    // skipped compaction here and then fell through to a useless plain retry.
    if (!isContextOverflowError(error)) {
      return { kind: 'rethrow' }
    }
    const compacted = await runCompaction(ctx, true)
    return compacted ? { kind: 'retry' } : { kind: 'rethrow' }
  },
}
