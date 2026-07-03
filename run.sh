#!/usr/bin/env bash
#
# LightClaw daemon launcher + supervisor.
#
# Run THIS (not `node dist/cli.js` directly) in the deployment tmux window. It
# keeps the daemon alive across two events the bare process cannot handle on its
# own:
#
#   - `/admin version update` restart (exit 75): the slash handler has already
#     pulled + built into dist.next/ + verified it, and cli.ts swapped it into
#     dist/ right before exiting (old build parked as dist.prev/), so the
#     supervisor only has to relaunch — it deliberately does NOT pull or build,
#     so a broken build can never reach this loop (the handler aborts without
#     exiting on failure). The dist.next promotion below only covers a crash
#     between the swap's two renames.
#   - crash (any other non-zero exit): relaunch after a short pause.
#
# Fast-fail guard: a daemon that exits non-zero within MIN_HEALTHY_SECONDS is a
# startup failure (bad config, a port already in use, a missing dist) — NOT a
# transient mid-run crash. Restarting it every 2s forever just spams the log and
# never recovers. After MAX_FAST_FAILS consecutive fast failures the supervisor
# STOPS and surfaces the exit code, so the operator fixes the root cause and
# re-runs. A daemon that ran healthy for a while and then died resets the
# counter and is restarted normally.
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
MIN_HEALTHY_SECONDS=20   # ran at least this long before a crash → treat as transient, restart
MAX_FAST_FAILS=3         # this many back-to-back fast crashes → give up and surface the error

fast_fails=0
while true; do
  # Crash-window recovery for the self-update staged-build swap (cli.ts does
  # `mv dist dist.prev && mv dist.next dist` right before exit 75): if the
  # process died between the two renames there is no dist/ but a verified
  # dist.next/ — promote it so the relaunch has a build to run.
  if [ ! -d dist ] && [ -d dist.next ]; then
    echo "[run.sh] no dist/ but staged dist.next/ present; promoting staged build" >&2
    mv dist.next dist
  fi
  start=$(date +%s)
  node dist/cli.js "$@"
  code=$?
  ran=$(( $(date +%s) - start ))

  if [ "$code" -eq "$UPDATE_RESTART_CODE" ]; then
    echo "[run.sh] update restart requested (exit $code); relaunching onto new build" >&2
    fast_fails=0
    continue
  fi
  if [ "$code" -eq 0 ]; then
    echo "[run.sh] clean exit; stopping" >&2
    break
  fi

  # Non-zero crash. Distinguish a transient mid-run crash from a startup failure.
  if [ "$ran" -ge "$MIN_HEALTHY_SECONDS" ]; then
    fast_fails=0
    echo "[run.sh] daemon exited ($code) after ${ran}s; restarting in 2s" >&2
    sleep 2
  else
    fast_fails=$(( fast_fails + 1 ))
    echo "[run.sh] daemon exited ($code) after ${ran}s (fast fail ${fast_fails}/${MAX_FAST_FAILS})" >&2
    if [ "$fast_fails" -ge "$MAX_FAST_FAILS" ]; then
      echo "[run.sh] daemon keeps failing at startup; NOT restarting." >&2
      echo "[run.sh] Fix the error above (commonly: a port already in use, a stale daemon still running, or a bad config), then re-run ./run.sh." >&2
      exit "$code"
    fi
    sleep 2
  fi
done
