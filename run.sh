#!/usr/bin/env bash
#
# LightClaw daemon launcher + supervisor.
#
# Run THIS (not `node dist/cli.js` directly) in the deployment tmux window. It
# keeps the daemon alive across two events the bare process cannot handle on its
# own:
#
#   - `/admin version update` restart (exit 75): the slash handler has already
#     pulled + built + verified the new dist before exiting, so the supervisor
#     only has to relaunch — it deliberately does NOT pull or build, so a broken
#     build can never reach this loop (the handler aborts without exiting on
#     failure).
#   - crash (any other non-zero exit): relaunch after a short pause.
#
# A clean operator stop (Ctrl-D in the admin console, or SIGTERM → graceful
# shutdown → exit 0) ends the loop so you can actually stop the daemon.
#
# Any args after the script name are forwarded to the daemon, e.g.
#   ./run.sh --home /mnt/shared-storage-user/ailab-hs/lightclaw_official/home
#
# Proxy / env: inherit the launching shell's environment (bashrc exports
# http_proxy), exactly as a hand-run `node dist/cli.js` would — the daemon's
# own internal HTTP plane ignores ambient proxy regardless.

set -uo pipefail

# Run from the repo root (this script lives there) so `node dist/cli.js` and the
# daemon's own checkout detection agree on which tree to run.
cd "$(dirname "$0")" || exit 1

UPDATE_RESTART_CODE=75

while true; do
  node dist/cli.js "$@"
  code=$?
  case "$code" in
    "$UPDATE_RESTART_CODE")
      echo "[run.sh] update restart requested (exit $code); relaunching onto new build" >&2
      continue
      ;;
    0)
      echo "[run.sh] clean exit; stopping" >&2
      break
      ;;
    *)
      echo "[run.sh] daemon exited ($code); restarting in 2s" >&2
      sleep 2
      ;;
  esac
done
