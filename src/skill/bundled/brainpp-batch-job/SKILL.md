---
name: brainpp-batch-job
description: "Submit and manage cluster batch training jobs via rjob: submit, inspect, monitor, stop/delete, and collect logs."
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

Use the `rjob` CLI for cluster batch training jobs while keeping LightClaw interactive sandbox work on the configured runtime backend.

## Positioning

- `rjob` is a batch-job tool for training/evaluation jobs: submit jobs, inspect status, tail logs, read scheduling events, stop/delete jobs, clone/patch specs, and download logs.
- `rjob` is not an interactive sandbox backend. Interactive sandbox execution is controlled by `runtime.backend` (`local` / `docker` / `cluster`) and is orthogonal to this skill.
- This skill appears only when the deployment platform is configured with `runtime.driver = "brainpp"`; the harness enforces that through the skill's driver gate. It depends on the Brain++ toolchain (`rjob` on PATH, provided by the internal `brainpp` package; not on public PyPI), which is present on the H-cluster dev host, Brain++ ml-base worker image, or a brainpp-preinstalled sandbox image.
- **Run `rjob` directly via `Bash`.** Prefix each call so the kubebrain SSH environment is initialized (harmless when it is already loaded):

  ```bash
  source /etc/profile.d/ssh-init.sh >/dev/null 2>&1 || true; rjob <subcommand> [args...]
  ```

  Authentication is automatic — `rjob` reads the worker's kubebrain credentials and environment itself. Never ask for or store a token/accesskey.
- If `rjob` is not on PATH, this environment lacks the cluster toolchain. Report that and stop; do not install, reconfigure, or substitute another mechanism without the user's go-ahead.
- Keep environment-specific values out of source and memory unless the user explicitly provides them for the current job: namespace, charged group, image, GPFS/workspace paths, secrets, and credentials.
- **Get the exact rjob syntax from the reference — do not guess it.** `references/command-mapping.md` lists every subcommand's real arguments (e.g. `logs` needs a `job`/`replica` positional, `submit`'s job command goes after a literal `--`, preview flags take a `true` value, the tail flag is `-n`/`--tail-lines`). Read it before constructing a command.

## References

- Command mapping (exact syntax + auth/required inputs): `${LIGHTCLAW_SKILL_DIR}/references/command-mapping.md`
- Templates and troubleshooting: `${LIGHTCLAW_SKILL_DIR}/references/templates.md`

## Safety: you are the manager, the user is the approver

There is no wrapper enforcing confirmation — `rjob` runs directly. Safety is your responsibility plus the permission layer:

- **`submit` creates a job and spends resources.** Always preview first (`--predict-only true` and/or `--dry-run true`), summarize the predicted spec to the user, and get the user's explicit go-ahead before a real submit. Never submit a real job off your own judgment.
- **`stop` halts a job; `delete` removes it irreversibly.** Show the target with `get <job>` and confirm the exact job name with the user first. A real `rjob delete` additionally triggers a confirmation prompt the user must approve each time — do not try to work around it.
- **`clone` / `patch` mutate a spec.** Inspect and explain the change before applying; never turn a clone into a real submit without the preview + confirm flow.
- Keep log/output bounded (use `-n` on `logs`); collect full artifacts only when the user needs them. Never put credentials into job specs, command lines, logs, or git remotes.

## Command workflow

### 1. Understand the job request

Identify whether the user wants to list, inspect, monitor, submit, stop/delete, clone/patch, download logs, or analyze a failure. For submit-like requests, collect the command, code/data location, image, namespace/group, resource requirements, output/log destination, and any deadline or stop condition. Ask for missing environment-specific values instead of guessing. On the first call, if `rjob` is missing, report the environment lacks the cluster toolchain and stop.

### 2. Use read-only commands freely, with bounded output

`list`, `get`, `logs` (with `-n`), `events`, and `download-logs` are safe to run as needed. Keep output bounded and summarize concisely. See `command-mapping.md` for exact syntax (notably `logs {job|replica} <name>`).

### 3. Preview submissions, then confirm

Preview with `submit --predict-only true ...` (resource feasibility) or `--dry-run true ...` (rendered spec) — both take a `true` value, and the job command goes after `--`. Summarize predicted resources, image, command, and mounts/paths. Do not perform a real submit yet.

**Human checkpoint**: get the user's explicit confirmation, then run the real `submit` (same args, drop the preview flag). Return the job name plus `get` / bounded `logs` / `events` / `download-logs` follow-ups.

### 4. Confirm before stop or delete

Show `get <job>`, confirm the exact job + action with the user, then run `stop` / `delete`. `delete` will surface a permission confirmation the user must approve.

### 5. Treat clone and patch as caution operations

Use `clone` / `patch` only to reuse or alter an existing spec; inspect and explain the delta and confirm risky changes before applying.

### 6. Analyze failures in order

For failed or stuck jobs: `get`, then `events`, then bounded `logs`; download full logs only when needed. Check quota/scheduling, image pull, mount/path, credentials, command arguments, and resource requests. Report the likely cause, the evidence, and the next safe action — without leaking credentials or dumping unbounded logs.
