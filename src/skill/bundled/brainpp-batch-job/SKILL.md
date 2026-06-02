---
name: brainpp-batch-job
description: "Submit and manage cluster batch training jobs via rjob: submit, inspect, monitor, stop/delete, and collect logs."
when_to_use: "Use when the user wants to submit, inspect, monitor, stop, debug, clone, patch, or download logs for cluster batch training jobs. Examples: 'submit this training job to the cluster', 'tail logs for my batch job', 'stop that cluster job'. This is for batch jobs, not interactive sandboxes."
requires-driver: brainpp
allowed-tools:
  - Bash
  - Read
  - Write
  - Grep
  - Glob
  - MemoryWrite
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
- **Get the exact rjob syntax from the reference — do not guess it.** `references/command-mapping.md` lists every subcommand's real arguments (e.g. `logs` needs a `job`/`replica` positional, `submit`'s job command goes after a literal `--`, preview flags take a `true` value, the tail flag is `-n`/`--tail-lines`). Read it before constructing a command.

## References

- Command mapping (exact syntax + auth/required inputs): `${LIGHTCLAW_SKILL_DIR}/references/command-mapping.md`
- Templates and troubleshooting: `${LIGHTCLAW_SKILL_DIR}/references/templates.md`

## Posture: act on your own judgment, report after

You run cluster jobs the way a competent operator would — submit, monitor, stop, clone, patch, collect logs — and carry the task through without pausing for permission at each step. LightClaw is built for long-horizon autonomous work: default to executing, and reserve interrupting the user for a genuine blocker.

- **Submit on your own judgment once the spec is complete.** Use `--predict-only true` / `--dry-run true` when you want to catch an infeasible spec before spending — then submit; you do not wait for a click between preview and submit. Don't ask "shall I submit?" when nothing is actually unresolved.
- **After every submit, report the full job config back.** Name, image, namespace, charged/quota group, mount / GPFS paths, resources, command, and the task-type lane (`normal` → normal priority → `常规任务` tab / `idle` → low priority, preemptible → `闲时任务` tab). The user did not approve it beforehand, so they must always see exactly what ran and which tab to find it under.
- **`delete` is the one hard gate, and the permission layer owns it.** A real `rjob delete` surfaces a confirmation card the user approves each time — that approval *is* the gate. Never add your own delete confirmation, and never try to route around the card. `stop` / `clone` / `patch` you run directly, then report what changed.
- Keep log/output bounded (`-n` on `logs`); collect full artifacts only when needed. Never put a token / accesskey / credential in a command line, log, memory, or git remote.

## Build a config library — remember the user's choices, pick the fit

Two of the job inputs have an environment default, two don't:

- **`namespace` and `charged/quota group` default from the kubebrain worker environment** — `rjob` fills them when you omit `--namespace` / `--charged-group`, so you don't need them to submit.
- **`image` and `mount / GPFS paths` have no environment default** — they describe what a particular job needs, which the environment can't know.

But all four become worth remembering the moment the user names or changes one — that choice carries a preference. Use `MemoryWrite` to build a **library of the configs the user has actually used**, and pick from it instead of re-asking:

- **Record every config the user gives or changes** — the image they pick, mounts they add or drop, and any namespace / group they name (even though those default, naming a specific one is a stated preference). Tie each record to *what it was for*: the kind of task, the project, or the reason the user gave — so it reads as "for `<this kind of work>`, the user used `<image / mounts / namespace / group>`".
- **This accumulates into several candidate configs, not one.** The user may run one kind of task with image A and another with image B; keep both as distinct options. Deduplicate only exact repeats (same config, same purpose) — never collapse genuinely different choices into one.
- **Before asking, pick the fit from the library.** Match the current task against what you've recorded and reuse the config whose purpose fits, reporting which one you chose. When several could apply, lean on the user's more recent or more specific preference.
- **Ask only when several genuinely fit and the choice matters — and when you ask, ask the right way.** If the `AskUserQuestion` tool is available to you, you MUST ask through it: it renders a choice card; pass the candidate configs as options with a safe default. Typing the question as a plain-text reply is the wrong move when you have the tool. Only when that tool is not available to you, hand the open choice back to the requester in your result instead. Don't ask at all when one config clearly fits.
- **A missing image (nothing on record) is a blocker — ask, do not hunt.** If no recorded config covers an image for this kind of task, ask which image to use, following the asking rule above. Do NOT try to discover one yourself: don't probe the registry, try tags, read the image the sandbox itself runs, or copy another job's image. A wrong image wastes a real submit, and the user already knows which image they want. The same goes for any other no-default value you have nothing on record for — ask, don't go looking.
- Record configs, never credentials. A token / accesskey / password must never enter memory.

## When you're genuinely blocked

A blocker is a required value that nothing on record covers and you cannot reasonably infer — not a routine "should I go ahead". When you hit one:

- If the `AskUserQuestion` tool is available to you, you MUST ask through it — it renders a card; give concrete options and a safe default, never a plain-text question.
- If you don't have that tool, put the open question in your result so the requester can resolve it. Either way: don't stall, don't guess an environment-specific value, and don't go probing to discover one (e.g. hunting for a usable image).

## Command workflow

### 1. Understand the job request

Identify whether the user wants to list, inspect, monitor, submit, stop/delete, clone/patch, download logs, or analyze a failure. For submit-like requests, assemble the spec — command, code/data location, image, resource requirements, mounts, output/log destination, and any deadline or stop condition. Namespace and charged/quota group default from the worker environment — leave them off unless the user wants a non-default one. For image / mounts / resources, pick the fitting config from your library first (see below) and ask only for what nothing on record covers. On the first call, if `rjob` is missing, report the environment lacks the cluster toolchain and stop.

### 2. Use read-only commands freely, with bounded output

`list`, `get`, `logs` (with `-n`), `events`, and `download-logs` are safe to run as needed. Keep output bounded and summarize concisely. See `command-mapping.md` for exact syntax (notably `logs {job|replica} <name>`).

### 3. Submit on your judgment, then report

Optionally preview (`submit --predict-only true ...` for resource feasibility, `--dry-run true ...` for the rendered spec — both take a `true` value, the job command goes after `--`) to catch a bad spec before spending. Then run the real `submit` — there is no confirmation gate. Afterward, report the full config: resources, image, namespace, charged/quota group, mount / GPFS paths, command, and the task-type lane (`normal` → `常规任务` tab / `idle` → `闲时任务` tab), plus the `get` / bounded `logs` / `events` / `download-logs` follow-ups. Then record the config the user chose as a library option (see "Build a config library").

### 4. Stop or delete the right job

Use `get` / `list` to pin the exact job name, then run `stop` / `delete` directly. `delete` surfaces the permission card the user must approve — that approval is the gate; you add none of your own.

### 5. Clone and patch are spec edits

Use `clone` / `patch` to reuse or alter an existing spec, then report the delta. A `clone` is not a `submit` — don't silently turn it into one.

### 6. Analyze failures in order

For failed or stuck jobs: `get`, then `events`, then bounded `logs`; download full logs only when needed. Check quota/scheduling, image pull, mount/path, credentials, command arguments, and resource requests. Report the likely cause, the evidence, and the next safe action — without leaking credentials or dumping unbounded logs.
