#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE' >&2
Usage: rjob-wrapper.sh <command> [args...]

Safe commands:
  list [rjob list args...]
  get <job> [rjob get args...]
  logs <job> [--tail N] [rjob logs args...]
  events <job> [rjob events args...]
  submit --predict-only [rjob submit args...]
  download-logs <job> [rjob download-logs args...]

Confirmation-gated commands:
  submit [--confirm-submit|RJOB_WRAPPER_CONFIRM_SUBMIT=1] [rjob submit args...]
  stop <job> [--confirm-destructive|RJOB_WRAPPER_CONFIRM_DESTRUCTIVE=1] [rjob stop args...]
  delete <job> [--confirm-destructive|RJOB_WRAPPER_CONFIRM_DESTRUCTIVE=1] [rjob delete args...]
  clone <job> [rjob clone args...]       # caution: inspect output before submit
  patch <job> [rjob patch args...]       # caution: inspect output before submit
USAGE
}

fail() {
  printf 'rjob-wrapper: %s\n' "$*" >&2
  exit 2
}

if [[ $# -lt 1 ]]; then
  usage
  exit 2
fi

command_name=$1
shift

case "$command_name" in
  list|get|logs|events|submit|stop|delete|clone|patch|download-logs) ;;
  *) fail "unsupported subcommand '$command_name'" ;;
esac

args=()
confirm_submit=${RJOB_WRAPPER_CONFIRM_SUBMIT:-0}
confirm_destructive=${RJOB_WRAPPER_CONFIRM_DESTRUCTIVE:-0}
explicit_tail=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm-submit)
      confirm_submit=1
      shift
      ;;
    --confirm-destructive)
      confirm_destructive=1
      shift
      ;;
    --tail)
      [[ "$command_name" == "logs" ]] || fail "--tail is only managed by wrapper for logs"
      [[ $# -ge 2 ]] || fail "--tail requires a numeric value"
      [[ "$2" =~ ^[0-9]+$ ]] || fail "--tail must be numeric"
      explicit_tail=1
      args+=("$1" "$2")
      shift 2
      ;;
    --tail=*)
      [[ "$command_name" == "logs" ]] || fail "--tail is only managed by wrapper for logs"
      value=${1#--tail=}
      [[ "$value" =~ ^[0-9]+$ ]] || fail "--tail must be numeric"
      explicit_tail=1
      args+=("$1")
      shift
      ;;
    --)
      shift
      while [[ $# -gt 0 ]]; do
        args+=("$1")
        shift
      done
      ;;
    -*|*)
      args+=("$1")
      shift
      ;;
  esac
done

for arg in "${args[@]}"; do
  [[ "$arg" =~ ^[[:print:]]*$ ]] || fail "arguments must be printable single-line values"
  [[ "$arg" != *';'* && "$arg" != *'`'* && "$arg" != *'$('* && "$arg" != *'|'* && "$arg" != *'&'* ]] || fail "argument contains shell metacharacters; pass values as plain rjob arguments"
done

if [[ "$command_name" != "list" && ${#args[@]} -lt 1 ]]; then
  fail "$command_name requires at least one argument"
fi

if [[ "$command_name" == "logs" && "$explicit_tail" == "0" ]]; then
  default_tail=${RJOB_WRAPPER_DEFAULT_LOG_TAIL:-200}
  [[ "$default_tail" =~ ^[0-9]+$ ]] || fail "RJOB_WRAPPER_DEFAULT_LOG_TAIL must be numeric"
  args=(--tail "$default_tail" "${args[@]}")
fi

if [[ "$command_name" == "submit" ]]; then
  # A real submit creates a job; a preview does not. rjob's preview flags
  # (--predict-only / --dry-run) each take a VALUE, so only a truthy value
  # counts as a preview. Anything else needs explicit confirmation.
  preview_only=0
  prev=""
  for arg in "${args[@]}"; do
    val=""
    case "$arg" in
      --predict-only=*|--dry-run=*) val=${arg#*=} ;;
    esac
    [[ "$prev" == "--predict-only" || "$prev" == "--dry-run" ]] && val=$arg
    case "${val,,}" in
      true|1|yes|on) preview_only=1 ;;
    esac
    prev=$arg
  done
  if [[ "$preview_only" == "0" && "$confirm_submit" != "1" ]]; then
    fail "refusing real submit without --confirm-submit or RJOB_WRAPPER_CONFIRM_SUBMIT=1; first preview with 'submit --predict-only true ...' (resource feasibility) or 'submit --dry-run true ...', then ask the user to confirm. A real submit also requires --image and the job's resource args."
  fi
fi

if [[ "$command_name" == "stop" || "$command_name" == "delete" ]]; then
  if [[ "$confirm_destructive" != "1" ]]; then
    fail "refusing $command_name without --confirm-destructive or RJOB_WRAPPER_CONFIRM_DESTRUCTIVE=1 after explicit user confirmation"
  fi
fi

if [[ -r /etc/profile.d/ssh-init.sh ]]; then
  set +e
  # shellcheck disable=SC1091
  source /etc/profile.d/ssh-init.sh
  ssh_init_status=$?
  set -e
  if [[ "$ssh_init_status" -ne 0 ]]; then
    printf 'rjob-wrapper: warning: /etc/profile.d/ssh-init.sh exited with status %s; continuing with current environment\n' "$ssh_init_status" >&2
  fi
else
  printf 'rjob-wrapper: warning: /etc/profile.d/ssh-init.sh not readable; continuing with current environment\n' >&2
fi

if ! command -v rjob >/dev/null 2>&1; then
  fail "rjob CLI not found on PATH in this runtime. rjob is provided by the internal Brain++ 'brainpp' Python package (not on public PyPI). It is present where runtime.driver = brainpp is configured and the brainpp toolchain is installed (H-cluster dev host, Brain++ ml-base worker image, or a brainpp-preinstalled sandbox image). If this environment has the Brain++ pip index configured, install with: pip3 install brainpp (it provides the 'rjob' command). Otherwise tell the user this environment cannot run cluster jobs and stop."
fi

exec rjob "$command_name" "${args[@]}"
