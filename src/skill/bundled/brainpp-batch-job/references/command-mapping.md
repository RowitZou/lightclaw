# rjob command reference

All commands run through the wrapper:

```bash
${LIGHTCLAW_SKILL_DIR}/scripts/rjob-wrapper.sh <subcommand> [args...]
```

The wrapper initializes the kubebrain SSH environment, verifies `rjob` is on PATH, blocks unsafe metacharacters, gates the destructive subcommands, then runs `rjob <subcommand> [args...]`. Pass plain `rjob` flags as separate arguments — do **not** use shell metacharacters (`;`, `|`, `&`, `` ` ``, `$(`), pipes, or quotes-as-grouping; the wrapper rejects them.

`<job>` below means the job's `metadata.name` (the long id like `myuser-20260601-ab12c`, the first column of `list`), **not** the human showname. Filter by showname with `--name <showname>` instead.

`--namespace <ns>` is environment-specific. Take it from the user or deployment config; never hardcode a namespace, charged group, image, or GPFS path in source or memory.

---

## Auth and required inputs

**Authentication: nothing to provide.** Inside the cluster runtime, `rjob` authenticates automatically from the worker environment (kubebrain access keys + env are already present). Never ask the user for, accept, or store any accesskey / token / credential, and never put one in source or memory.

**Read commands (`list` / `get` / `logs` / `events`): no inputs required.** Namespace defaults from the worker environment; pass `--namespace <ns>` only to target a different one.

**`submit` — collect these per job (they are job-specific and not hardcoded):**
- `--image <image>` — container image (**required**).
- `--cpu <n>` / `--gpu <n>` / `--memory <MB>` — resource requests (**required**).
- the command to run, after the `--` separator.
- code / data / output paths the command needs.
- `--charged-group <group>` and `--namespace <ns>` usually default from the worker's kubebrain environment — provide them explicitly only to override, or if a submit fails asking for them.

Ask the user for any missing `submit` value instead of guessing; never invent an image, group, namespace, or path.

---

## Read-only commands (safe, run freely)

### list — enumerate jobs
```
rjob-wrapper.sh list [<job>...] [--name <showname>] [--namespace <ns>]
```
- No positional required. Bare `list` returns all jobs in the namespace — ask for a filter if that would be too broad.
- `--name <showname>` filters by the `kubebrain.brainpp.cn/showname` annotation.

### get — job details
```
rjob-wrapper.sh get <job>... [--name <showname>] [--namespace <ns>]
```
- Positional is one or more job names. Use before `logs`/`events` when the exact name is uncertain.

### logs — tail container logs
```
rjob-wrapper.sh logs {job|replica} <name> [-n <N> | --tail-lines <N>] [--namespace <ns>]
```
- **The first positional MUST be the literal `job` or `replica`**, then the name. `logs <name>` alone fails with `invalid choice (choose from 'job', 'replica')`.
- `job <job>` tails the whole job; `replica <replica-name>` tails a single replica (replica names come from `get`/`events`).
- Tail flag is `-n` / `--tail-lines` (**not** `--tail`). The wrapper injects a default tail of `${RJOB_WRAPPER_DEFAULT_LOG_TAIL:-200}` when you omit one, so keep output bounded.
- Example: `rjob-wrapper.sh logs job myuser-20260601-ab12c -n 50`

### events — scheduling / lifecycle events
```
rjob-wrapper.sh events <job-or-replica-name> [--replica] [--namespace <ns>]
```
- Default target is a job; add `--replica` to read a replica's events. Best first stop for "stuck / pending / not scheduling".

### download-logs — collect a log artifact
```
rjob-wrapper.sh download-logs <job> --action {create|list|get|delete|download} [--task-id <id>] [--output <path>] [--wait] [--namespace <ns>]
```
- Two-step: `--action create [--wait]` makes a download task; `--action download --task-id <id> --output <path>` fetches the zip. Default output is `./rjob-logs.zip` — choose a workspace path and don't overwrite existing artifacts without asking.

---

## Submit (creates a job — preview first, then confirm)

```
rjob-wrapper.sh submit [job options] [task/resource options] -- <command line>
```

- **The job's command goes after a literal `--` separator.** `submit ... sleep 3600` fails with `unrecognized arguments`; write `submit ... -- sleep 3600`.
- **Preview flags take a VALUE**: `--predict-only true` (checks resource feasibility) or `--dry-run true` (renders the spec for developer inspection). Bare `--predict-only` is wrong.
- A real submit (no truthy preview flag) is **blocked by the wrapper** unless you pass `--confirm-submit` (or set `RJOB_WRAPPER_CONFIRM_SUBMIT=1`) — and only after the user has confirmed the previewed spec.

Common options (run `submit --help` through the wrapper for the full list):

| Flag | Meaning |
| --- | --- |
| `--name <job-name>` | Job name; omitted → auto `<user>-<timestamp>` |
| `--image <image>` | Container image (**required** for a real submit) |
| `--cpu <n>` | CPU cores |
| `--gpu <n>` | GPU count |
| `--memory <MB>` | Memory in **megabytes** |
| `--charged-group <group>` | Charged quota group |
| `--group <group>` | User quota group |
| `-P` / `--replica <n>` | Replica count of the task |
| `-r` / `--restart-policy <p>` | Task restart policy (normal task: `Never` only) |
| `--namespace <ns>` | Namespace |
| `--task-type {normal,idle}` | Task type (default `normal`) |
| `--priority <1-9>` | Priority for normal tasks |
| `--predict-only true` / `--dry-run true` | Preview, do not create |
| `--confirm-submit` | Required for a real submit (wrapper gate) |

Preview example:
```
rjob-wrapper.sh submit --predict-only true --name demo --image <img> \
  --cpu 8 --memory 16384 --gpu 0 --charged-group <group> --namespace <ns> -- python train.py
```
Real submit (after confirmation): same line with `--confirm-submit` replacing `--predict-only true`.

---

## Destructive commands (require explicit confirmation)

### stop — stop a running job
```
rjob-wrapper.sh stop <job>... --confirm-destructive [--name <showname>] [--force] [--force-all] [--namespace <ns>]
```

### delete — delete a job
```
rjob-wrapper.sh delete <job>... --confirm-destructive [--name <showname>] [--force-all] [--namespace <ns>]
```

- Both are **blocked** unless `--confirm-destructive` (or `RJOB_WRAPPER_CONFIRM_DESTRUCTIVE=1`) is present, and you must confirm the exact job name with the user first. Show `get <job>` before asking. Prefer `stop` if the user only wants to halt work; `delete` removes the record.

---

## Spec-editing commands (caution — inspect before acting)

### clone — copy a job spec into a new job
```
rjob-wrapper.sh clone <job> [--name <new-name>] [--auto-restart <v>] [--stop-original <v>] [--namespace <ns>]
```

### patch — change an existing job's task
```
rjob-wrapper.sh patch <job> [--task_name <t>] [-P <replicas>] [--auto-restart <v>] [--namespace <ns>]
```

- Treat both as spec mutations: explain what will change and confirm before applying anything that affects a live job. A `clone` is not a submit — do not turn it into one without the dry-run + confirm flow.

---

## Gotchas the wrapper does NOT fix for you

- `logs` needs `job`/`replica` as the first positional. `events` defaults to job, `--replica` for a replica.
- `submit` needs `--` before the command, and `--predict-only`/`--dry-run` need a `true` value.
- The tail flag is `-n` / `--tail-lines`, never `--tail`.
- There is no `kubectl` / `kubebrain` CLI in this skill — only the `rjob` subcommands above. Don't invent commands; if something isn't covered, run `<subcommand> --help` through the wrapper.
- If `rjob` is missing entirely the wrapper fails with an install hint — that means the environment lacks the Brain++ toolchain; report it and stop rather than improvising.
