/**
 * Model-facing notice for a runtime "generation" change — the backend
 * environment serving a session's exec / fs was replaced (worker respawn after
 * worker-lost, health-checker restart, or /system mount swap). When that happens the
 * container-local state a long-running agent may rely on is gone: `/tmp` and
 * `/scratch` are wiped and any in-environment background process it started is
 * dead. The persistent workspace mount and re-provisioned command-line tools
 * survive.
 *
 * Detection is a single cause-agnostic chokepoint: `Runtime.currentGeneration()`
 * returns a token that changes on every environment replacement (for Rlaunch the
 * worker name). `query.ts` compares it per session at each tool-call boundary
 * and injects the reminder into the next user message exactly once per change.
 * This deliberately replaces the older per-command `[runtime] worker restarted,
 * container-local /tmp etc. lost` stderr prefix, which only covered the
 * worker-lost respawn path and only on the one command that tripped it.
 */

const lastSeenGenerationBySession = new Map<string, string>()

/**
 * Returns true exactly once per generation change for `sessionId`. The first
 * observation only records the baseline (no reminder for a session's opening
 * turn), and a null / absent generation — LocalRuntime, or a backend that has
 * not started an instance yet — never counts as a change and never updates the
 * baseline (so a transient null between a worker's death and respawn does not
 * masquerade as a restart).
 */
export function detectRuntimeRestart(
  sessionId: string,
  generation: string | null | undefined,
): boolean {
  if (!generation) return false
  const previous = lastSeenGenerationBySession.get(sessionId)
  lastSeenGenerationBySession.set(sessionId, generation)
  return previous !== undefined && previous !== generation
}

/** Test seam — clears the in-memory per-session baselines. */
export function resetRuntimeRestartTracking(): void {
  lastSeenGenerationBySession.clear()
}

/**
 * English to match the other framework reminders (empty-stop rescue, stop
 * notice) — this is a framework block the model reads, not the user's words.
 * Deliberately cause-free: the agent's action is the same regardless of why the
 * environment was replaced (re-establish in-environment state, the workspace is
 * intact), and the specific cause is neither observable to it nor available at
 * the generation-diff detection point.
 */
export const RUNTIME_RESTART_REMINDER = [
  '<system-reminder>',
  'Your environment was restarted since your last action and is now fresh. State that lived only in this environment is gone:',
  '- Files under /tmp and /scratch.',
  '- Background processes you started here (dev servers, watchers, nohup\'d jobs).',
  'Your workspace files persist across restarts and are intact, and your command-line tools are still available. If you were relying on a process or scratch files from before to continue, re-establish them before proceeding; otherwise continue as normal.',
  '</system-reminder>',
].join('\n')

export function formatRuntimeRestartReminder(): string {
  return RUNTIME_RESTART_REMINDER
}
