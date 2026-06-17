import { test } from 'node:test'
import assert from 'node:assert/strict'

import { query } from './query.js'
import type { InvocationContext } from './agents/invocation-context.js'

test('query refuses an interjectionDrain wired without an interjectionRenderer', async () => {
  // Universal backstop for the drain-without-renderer blind spot (bit
  // dispatched-agent, then resume.ts in 2026-06-17). A hand-built
  // InvocationContext that drains but cannot render would stamp
  // metadata.interjectionEntries while the model never sees the message.
  // forkInvocationContext couples the two on the fork path; this guard catches
  // any caller that builds an InvocationContext by hand. It runs before any
  // provider/session machinery, so passing skeletal role/config is enough —
  // the refusal fires first. The config object short-circuits the getConfig()
  // fallback so no daemon home is required.
  const invocation = {
    interjectionDrain: () => [],
  } as InvocationContext

  await assert.rejects(
    () =>
      query({
        role: {} as never,
        config: {} as never,
        tools: [],
        messages: [],
        invocation,
      }),
    /interjectionDrain without interjectionRenderer/,
  )
})
