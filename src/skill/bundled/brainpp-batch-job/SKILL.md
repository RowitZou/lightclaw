---
name: brainpp-batch-job
description: "Submit and manage cluster batch training jobs via rjob: submit, inspect, monitor, stop/delete with confirmation, and collect logs."
when_to_use: "Use when the user wants to submit, inspect, monitor, stop, debug, clone, patch, or download logs for cluster batch training jobs. Examples: 'submit this training job to the cluster', 'tail logs for my batch job', 'stop that cluster job after I confirm'. This is for batch jobs, not interactive sandboxes."
requires-driver: brainpp
allowed-tools:
  - Bash
  - Read
  - Write
  - Grep
  - Glob
roles:
  - main
  - generalist
  - coder
---

# Brain++ Batch Job

Use the local `rjob` CLI for cluster batch training jobs while keeping LightClaw interactive sandbox work on the configured runtime backend.

## Positioning

- `rjob` is a batch-job tool for training/evaluation jobs: submit jobs, inspect status, tail logs, read scheduling events, stop/delete jobs, clone/patch specs, and download logs.
- `rjob` is not an interactive sandbox backend. Interactive sandbox execution is controlled by `runtime.backend` (`local` / `docker` / `cluster`) and is orthogonal to this skill.
- This skill appears only when the deployment platform is configured with `runtime.driver = "brainpp"`; the harness enforces that through the skill's driver gate. It depends on the Brain++ toolchain (`rjob` on PATH, provided by the internal `brainpp` package; not on public PyPI), which is present on the H-cluster dev host, Brain++ ml-base worker image, or a brainpp-preinstalled sandbox image.
- If `rjob` is not on PATH, the wrapper fails and stops. Report that this environment lacks the cluster toolchain; do not install, reconfigure, or substitute another mechanism without the user's go-ahead.
- Before every `rjob` call, initialize the kubebrain SSH environment with `source /etc/profile.d/ssh-init.sh`. Prefer the bundled wrapper, which does this automatically: `${LIGHTCLAW_SKILL_DIR}/scripts/rjob-wrapper.sh`.
- Keep environment-specific values out of source and memory unless the user explicitly provides them for the current job: namespace, charged group, image, GPFS/workspace paths, secrets, and credentials.
- Authentication is automatic — `rjob` reads the worker's kubebrain credentials and environment itself, so never ask for or store a token/accesskey. Read commands (`list`/`get`/`logs`/`events`) need no inputs (namespace defaults from the environment). A real `submit` requires job-specific values you must collect from the user: `--image`, resources (`--cpu`/`--gpu`/`--memory` in MB), the command after `--`, and any data/output paths. See `references/command-mapping.md` ("Auth and required inputs") for the full breakdown.

## References

- Command mapping: `${LIGHTCLAW_SKILL_DIR}/references/command-mapping.md`
- Templates and troubleshooting: `${LIGHTCLAW_SKILL_DIR}/references/templates.md`

## Wrapper

Run commands through:

```bash
${LIGHTCLAW_SKILL_DIR}/scripts/rjob-wrapper.sh <command> [args...]
```

The wrapper sources `/etc/profile.d/ssh-init.sh`, rejects unsupported subcommands, passes arguments as an argv array, refuses obvious shell metacharacters/control newlines, injects a bounded `logs --tail-lines 200` default when no `-n`/`--tail-lines` is supplied, and blocks real `submit`, `stop`, and `delete` unless an explicit confirmation flag or environment variable is present. See `references/command-mapping.md` for the exact per-subcommand syntax — follow it rather than guessing rjob's argument shapes.

## Command workflow

### 1. Understand the job request

Identify whether the user wants to list, inspect, monitor, submit, stop/delete, clone/patch, download logs, or analyze failure. For submit-like requests, collect the command, code/data location, image, namespace/group, resource requirements, output/log destination, and any deadline or stop condition. Ask for missing environment-specific values instead of guessing.

Preflight the environment on the first command: any wrapper call already checks that `rjob` is on PATH and fails with an install hint when it is absent. If that happens, report that this environment lacks the cluster toolchain and stop — do not attempt to install it or substitute another mechanism without the user's go-ahead.

**Success criteria**: You know the intended rjob operation and have the minimum job identifiers or submit parameters needed to run a safe command.

### 2. Use read-only commands freely, with bounded output

Safe read-only mappings:

- List: `${LIGHTCLAW_SKILL_DIR}/scripts/rjob-wrapper.sh list [rjob list flags]`
- Get: `${LIGHTCLAW_SKILL_DIR}/scripts/rjob-wrapper.sh get <job> [flags]`
- Logs: `${LIGHTCLAW_SKILL_DIR}/scripts/rjob-wrapper.sh logs job <job> -n <N> [flags]`; the first positional must be `job` or `replica` (not the name alone). Tail flag is `-n`/`--tail-lines`; omit it only when the wrapper default of 200 lines is acceptable.
- Events: `${LIGHTCLAW_SKILL_DIR}/scripts/rjob-wrapper.sh events <job> [flags]`
- Download logs: `${LIGHTCLAW_SKILL_DIR}/scripts/rjob-wrapper.sh download-logs <job> [flags]`; choose a workspace destination and avoid overwriting existing artifacts without confirmation.

**Success criteria**: The user gets a concise status/log/event summary or a clearly named downloaded-log artifact without unbounded output.

### 3. Dry-run submissions first

For new submissions, first preview without creating a job. rjob's preview flags take a value, so pass `true` explicitly:

```bash
${LIGHTCLAW_SKILL_DIR}/scripts/rjob-wrapper.sh submit --predict-only true [submit args...]
```

`--predict-only true` checks whether the cluster has enough resources for the job; `--dry-run true` is a developer-debug preview of the rendered spec. Use whichever the user needs (or both). A real submit requires the full args including `--image` and the resource flags (`--cpu` / `--memory` / `--gpu` / `--charged-group`), so confirm those are present here. Summarize the predicted resources, image, command, mounts/paths, and any missing or risky values. Do not perform a real submit yet.

**Success criteria**: The user has reviewed the predicted job and understands what will run and what resources it will consume.

### 4. Confirm before real submit

Only after explicit user confirmation, run either:

```bash
${LIGHTCLAW_SKILL_DIR}/scripts/rjob-wrapper.sh submit --confirm-submit [submit args...]
```

or set `RJOB_WRAPPER_CONFIRM_SUBMIT=1` for that single command. Return the job name and next monitoring commands.

**Human checkpoint**: Required before every real submit.

**Success criteria**: The confirmed job is submitted, and the user receives the job name plus `get`, bounded `logs`, `events`, and `download-logs` follow-ups.

### 5. Confirm before stop or delete

Stop/delete are destructive. First show the target job and current state with `get <job>`, then ask the user to confirm the exact job name and action. After confirmation, run:

```bash
${LIGHTCLAW_SKILL_DIR}/scripts/rjob-wrapper.sh stop <job> --confirm-destructive
${LIGHTCLAW_SKILL_DIR}/scripts/rjob-wrapper.sh delete <job> --confirm-destructive
```

or set `RJOB_WRAPPER_CONFIRM_DESTRUCTIVE=1` for that single command.

**Human checkpoint**: Required before every stop/delete.

**Success criteria**: Only the confirmed job is stopped or deleted, and the result is checked with `get` or `list`.

### 6. Treat clone and patch as caution operations

Use clone/patch only when the user intends to reuse or alter an existing job spec:

```bash
${LIGHTCLAW_SKILL_DIR}/scripts/rjob-wrapper.sh clone <job> [flags]
${LIGHTCLAW_SKILL_DIR}/scripts/rjob-wrapper.sh patch <job> [flags]
```

Inspect and explain the generated or changed spec. Do not turn a clone into a real submit without the dry-run and confirmation flow. For patch operations that affect live behavior, explain the impact and ask for confirmation before applying risky changes.

**Success criteria**: The user sees the spec delta and no risky job mutation occurs silently.

### 7. Analyze failures in order

For failed or stuck jobs, run `get`, then `events`, then bounded `logs`; download full logs only when needed. Check quota/scheduling, image pull, mount/path, credentials, command arguments, resource requests, and application stack trace. Report the likely cause, evidence, and the next safe action.

**Success criteria**: The user receives an evidence-backed failure summary and a concrete next step without leaking credentials or dumping unbounded logs.
