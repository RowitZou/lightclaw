// Poll a predicate until it is true, or throw after a generous timeout.
//
// Use this instead of `await new Promise(r => setTimeout(r, N))` followed by an
// assertion on state that some DETACHED async work (signal-bus publish, resume
// scheduler, background fire) produces. A fixed sleep guesses how long that
// work takes; under the suite's 16-way concurrent load the CPU is starved and
// the work routinely lands later than the guess, so the immediate assertion
// reads not-yet-present state and the test flakes. Polling for the actual
// condition removes the timing assumption: it returns the instant the state is
// real (usually within a few ms) and only fails — loudly, with a label — if the
// work genuinely never happens within `timeoutMs`, which is a real bug, not a
// scheduling hiccup.
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 2000
  const intervalMs = opts.intervalMs ?? 5
  const start = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - start >= timeoutMs) {
      throw new Error(
        `waitFor timed out after ${timeoutMs}ms${opts.label ? `: ${opts.label}` : ''}`,
      )
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}
