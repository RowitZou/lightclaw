import { z } from 'zod'

import { buildTool } from '../tool.js'

const MAX_DURATION_SECONDS = 600

export const sleepTool = buildTool({
  name: 'Sleep',
  description: `Wait for a specified duration. /stop interrupts it instantly.

Use this when:
- The user explicitly asked you to wait / pause / rest.
- You are waiting for something time-dependent (a background process to settle, a delay between API retries).
- You need a delay before checking a condition.

Do NOT use this:
- To poll for a condition — diagnose the root cause or use BackgroundTask for monitoring.
- To pad the response — silence costs nothing, fake work costs an API round-trip.
- For durations > 5 minutes — prompt cache TTL is 5 min, longer waits should go through BackgroundTask instead. The runtime cap is 600 s (10 min) but use sparingly.

Prefer this over \`Bash(sleep N)\` — Sleep is harness-side and does not hold a sandbox shell process, so concurrent tools keep working. /stop interrupts it instantly.

Each wake-up still costs one model turn. Pick the duration honestly: 30 s reads cheap, 5 min costs a full API round-trip plus loses the prompt cache.`,
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
