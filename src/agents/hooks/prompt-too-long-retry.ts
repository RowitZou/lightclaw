import type { Hook } from './types.js'
import { runCompaction } from './auto-compact.js'

function isPromptTooLongError(err: unknown): boolean {
  if (!err) {
    return false
  }
  const message = err instanceof Error ? err.message : String(err)
  const lower = message.toLowerCase()
  return (
    lower.includes('prompt is too long')
    || lower.includes('input is too long')
    || lower.includes('input length')
    || lower.includes('context length')
    || lower.includes('exceeds maximum context')
    || lower.includes('maximum context length')
  )
}

export const promptTooLongRetryHook: Hook = {
  name: 'prompt-too-long-retry',
  async onStreamError(error, ctx) {
    if (!isPromptTooLongError(error)) {
      return { kind: 'rethrow' }
    }
    const compacted = await runCompaction(ctx, true)
    return compacted ? { kind: 'retry' } : { kind: 'rethrow' }
  },
}
