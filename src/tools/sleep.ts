import { z } from 'zod'

import { buildTool } from '../tool.js'

const MAX_DURATION_SECONDS = 600

export const sleepTool = buildTool({
  name: 'Sleep',
  whenToUse: `Brief in-turn pause (waiting for retry, letting a background process settle).`,
  shouldDefer: true,
  description: `Wait for a specified duration. /stop interrupts it instantly.

Use this when:
- The user explicitly asked you to wait / pause / rest.
- You are waiting for something time-dependent (a background process to settle, a delay between retries).
- You need a delay before checking a condition.

Do NOT use this:
- To poll for a condition — diagnose the root cause, or dispatch a monitor that reports back.
- To pad the response — silence costs nothing; pretended work is not free.
- For durations beyond a few minutes — a long wait should not be spent sleeping in place: schedule the follow-up (a scheduled dispatch, or a declared wait on your run) and let it come back to you. The cap is 600 s (10 min).

Prefer this over \`Bash(sleep N)\` — Sleep does not occupy a shell, concurrent tools keep working, and /stop interrupts it instantly.

A sleep is not free, and its cost grows with its length: pick the shortest duration the wait actually needs.`,
  domain: 'host',
  riskLevel: 'safe',
  concurrencySafe: true,
  inputSchema: z.object({
    duration_seconds: z.number().int().min(1).max(MAX_DURATION_SECONDS),
  }),
  async call(input, context) {
    const start = Date.now()

    if (context.abortSignal.aborted) {
      throw new Error('Sleep aborted before start.')
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        context.abortSignal.removeEventListener('abort', onAbort)
        resolve()
      }, input.duration_seconds * 1000)

      const onAbort = () => {
        clearTimeout(timer)
        reject(new Error('Sleep aborted by /stop.'))
      }

      context.abortSignal.addEventListener('abort', onAbort, { once: true })
    })

    const elapsedMs = Date.now() - start
    return {
      output: `Slept ${(elapsedMs / 1000).toFixed(1)}s.`,
    }
  },
})
