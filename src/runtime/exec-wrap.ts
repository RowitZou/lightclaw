import { shellQuote } from './process.js'

// Grace the in-sandbox watchdog gives a timed-out command's process group
// between SIGTERM and the escalating SIGKILL.
export const SANDBOX_KILL_GRACE_MS = 5_000
// How much longer the daemon-side runProcess timeout runs past the in-sandbox
// budget + grace, so the in-sandbox watchdog reliably resolves the command
// first and the daemon-side timeout only trips when the control plane itself
// (docker exec / brainctl exec) has wedged.
const SANDBOX_BACKSTOP_MARGIN_MS = 5_000

/**
 * Daemon-side `runProcess` timeout to pair with a command wrapped by
 * {@link wrapSandboxCommandWithTimeout}. Long enough that the in-sandbox
 * watchdog (fires at `budgetMs`, SIGKILLs at `budgetMs + killGraceMs`) always
 * resolves the command first, leaving the daemon-side timeout as a pure
 * backstop for a wedged control plane.
 */
export function sandboxBackstopTimeoutMs(
  budgetMs: number,
  killGraceMs: number = SANDBOX_KILL_GRACE_MS,
): number {
  return budgetMs + killGraceMs + SANDBOX_BACKSTOP_MARGIN_MS
}

/**
 * Wrap a sandbox command so the sandbox enforces its own timeout and kills the
 * command's whole process tree on expiry.
 *
 * Killing the daemon-side `docker exec` / `brainctl exec` client does NOT kill
 * the process it started inside the container / worker pod — that process is
 * owned by the container runtime, so a timed-out `git clone` leaves
 * `git index-pack` running until the container / worker is reaped by its
 * lifecycle (5.21 dogfood Bug 4). This wrapper runs the command via `setsid`
 * in a fresh process group and starts an in-sandbox watchdog that SIGTERMs,
 * then SIGKILLs, that group after the budget. Because the watchdog runs inside
 * the sandbox, it still fires even when the control-plane client is killed and
 * this wrapper shell is orphaned — the in-sandbox tree self-terminates within
 * `budget + grace` instead of leaking.
 *
 * The wrapper is transparent for a command that finishes on its own: it
 * forwards the command's stdout / stderr and exits with its exit code.
 *
 * Depends on `setsid` (util-linux) — present in both the rlaunch ml-base and
 * the lightclaw-sandbox images, the same dependency posture as `setpriv`.
 */
export function wrapSandboxCommandWithTimeout(
  command: string,
  budgetMs: number,
  killGraceMs: number = SANDBOX_KILL_GRACE_MS,
): string {
  const budgetSec = Math.max(1, Math.ceil(budgetMs / 1000))
  const graceSec = Math.max(1, Math.ceil(killGraceMs / 1000))
  // Watchdog body — runs in its own `setsid` group so the wrapper can cancel
  // it (and its sleeps) cleanly with one group kill. `$LC_TARGET` is the inner
  // command's process-group id, passed in via the environment.
  const watchdog = [
    `sleep ${budgetSec}`,
    `echo 'lightclaw: command exceeded the ${budgetSec}s sandbox time limit; terminating' >&2`,
    `kill -TERM -"$LC_TARGET" 2>/dev/null`,
    `sleep ${graceSec}`,
    `kill -KILL -"$LC_TARGET" 2>/dev/null`,
  ].join('; ')
  return [
    // Inner command: its own session/process group via setsid (pgid == pid).
    `setsid bash -c ${shellQuote(command)} &`,
    `__lc_pid=$!`,
    // Watchdog: a separate setsid group, told the inner's pgid via env.
    `LC_TARGET="$__lc_pid" setsid bash -c ${shellQuote(watchdog)} &`,
    `__lc_wd=$!`,
    `wait "$__lc_pid"`,
    `__lc_rc=$?`,
    // Inner finished (on its own or via the watchdog) — sweep any stragglers
    // left in its group, then cancel the watchdog group. ESRCH on an empty /
    // already-gone group is swallowed by `2>/dev/null`.
    `kill -KILL -"$__lc_pid" 2>/dev/null`,
    `kill -KILL -"$__lc_wd" 2>/dev/null`,
    `wait "$__lc_wd" 2>/dev/null`,
    `exit $__lc_rc`,
  ].join('\n')
}

/** One daemon-stderr line when a sandbox exec hit the in-sandbox watchdog.
 *  The wrapper's timeout message lands in the TOOL RESULT (visible only to
 *  the model), never in daemon logs — 2026-07-26 forensics found weeks of
 *  silent 30s tool timeouts (Glob the top burner) invisible to every
 *  log-based patrol. Best-effort observability; never throws. */
export function logSandboxTimeoutIfAny(
  kind: string,
  input: { command: string; cwd?: string },
  result: { stderr: string },
): void {
  if (!result.stderr.includes('sandbox time limit')) return
  const head = input.command.replace(/\s+/g, ' ').slice(0, 120)
  process.stderr.write(`[${kind} exec-timeout] cwd=${input.cwd ?? '-'} cmd=${head}\n`)
}
