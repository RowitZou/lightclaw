// Self-restart coordination between the `/admin update` handler and cli.ts.
//
// The daemon has no in-process re-exec: a clean restart means "exit, and let
// the external supervisor (run.sh in the deployment tmux, or a
// systemd Restart=always unit) relaunch us". cli.ts owns the graceful-shutdown
// machinery (drain background work, release runtimes, flush logs) and is the
// only place that may call process.exit, so the update handler cannot restart
// the process itself. It instead asks through this tiny module: cli.ts installs
// a handler at startup that runs gracefulShutdown with the sentinel exit code,
// and self-update.ts calls triggerUpdateRestart() once the rebuild succeeded.
//
// Kept dependency-free (no imports) so neither cli.ts nor self-update.ts forms
// an import cycle through it.

// The exit code that tells the supervisor "rebuilt, relaunch me" (vs 0 = clean
// operator stop, end the loop; anything else = crash, restart after a pause).
// 75 = EX_TEMPFAIL from sysexits.h — conventionally "temporary failure, retry".
export const UPDATE_RESTART_EXIT_CODE = 75

let restartHandler: (() => void) | undefined

/** cli.ts registers the graceful-shutdown-with-restart-code implementation. */
export function setUpdateRestartHandler(handler: () => void): void {
  restartHandler = handler
}

/** Ask the daemon to shut down gracefully and exit with the restart code.
 *  Returns false when no handler is installed (e.g. a unit test importing the
 *  update module without a running daemon), so callers can degrade instead of
 *  silently doing nothing. */
export function triggerUpdateRestart(): boolean {
  if (!restartHandler) {
    return false
  }
  restartHandler()
  return true
}
