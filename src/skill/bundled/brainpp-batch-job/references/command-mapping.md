# rjob command reference

Run `rjob` directly via `Bash`, prefixed so the kubebrain SSH environment is initialized (harmless when already loaded):

```bash
source /etc/profile.d/ssh-init.sh >/dev/null 2>&1 || true; rjob <subcommand> [args...]
```

Authentication is automatic (the worker carries the kubebrain credentials). The examples below show the bare `rjob <subcommand>` for readability — apply the `source ...; ` prefix in the actual `Bash` call. You run these on your own judgment and report what you did (see the posture in `SKILL.md`); the only hard gate is `rjob delete`, which surfaces a permission card the user must approve.

`<job>` below means the job's `metadata.name` (the long id like `myuser-20260601-ab12c`, the first column of `list`), **not** the human showname. Filter by showname with `--name <showname>` instead.

`--namespace <ns>` defaults from the kubebrain worker environment — pass it only to target a non-default namespace. Never hardcode a namespace, charged group, image, or path into source; the agent may remember a *working* image / mount / override in memory (configs are not secrets — credentials are, and those never go in memory).

---

## Auth and required inputs

**Authentication: nothing to provide.** Inside the cluster runtime, `rjob` authenticates automatically from the worker environment (kubebrain access keys + env are already present). Never ask the user for, accept, or store any accesskey / token / credential, and never put one in source or memory.

**Read commands (`list` / `get` / `logs` / `events`): no inputs required.** Namespace defaults from the worker environment; pass `--namespace <ns>` only to target a different one.

**`submit` — these are job-specific (no environment default):**
- `--image <image>` — container image (**required**; the environment can't default it because it describes what the job needs to run).
- `--cpu <n>` / `--gpu <n>` / `--memory <MB>` — resource requests (**required**).
- the command to run, after the `--` separator.
- code / data / output paths and any mounts the command needs.

**These default from the kubebrain worker environment** (`KUBEBRAIN_NAMESPACE` / `KUBEBRAIN_QUOTA_GROUP`):
- `--namespace <ns>` and `--charged-group <group>` / `--group <group>` — omit them and `rjob` fills them in; pass one only to override the env default.

For the no-default values (image / mounts / resources), pick the fitting config from your recorded library — the configs the user has used for this kind of work — and ask only for what nothing on record covers; don't invent an image or a path. Record any image / mount / namespace / group the user names or changes as a new candidate option (see "Build a config library" in `SKILL.md`).

---

## Read-only commands (safe, run freely)

### list — enumerate jobs
```
rjob list [<job>...] [--name <showname>] [--namespace <ns>]
```
- No positional required. Bare `list` returns all jobs in the namespace — ask for a filter if that would be too broad.
- `--name <showname>` filters by the `kubebrain.brainpp.cn/showname` annotation.

### get — job details
```
rjob get <job>... [--name <showname>] [--namespace <ns>]
```
- Positional is one or more job names. Use before `logs`/`events` when the exact name is uncertain.

### logs — tail container logs
```
rjob logs {job|replica} <name> [-n <N> | --tail-lines <N>] [--namespace <ns>]
```
- **The first positional MUST be the literal `job` or `replica`**, then the name. `logs <name>` alone fails with `invalid choice (choose from 'job', 'replica')`.
- `job <job>` tails the whole job; `replica <replica-name>` tails a single replica (replica names come from `get`/`events`).
- Tail flag is `-n` / `--tail-lines` (**not** `--tail`). Always pass a bound (e.g. `-n 200`) so logs stay bounded.
- Example: `rjob logs job myuser-20260601-ab12c -n 50`

### events — scheduling / lifecycle events
```
rjob events <job-or-replica-name> [--replica] [--namespace <ns>]
```
- Default target is a job; add `--replica` to read a replica's events. Best first stop for "stuck / pending / not scheduling".

### download-logs — collect a log artifact
```
rjob download-logs <job> --action {create|list|get|delete|download} [--task-id <id>] [--output <path>] [--wait] [--namespace <ns>]
```
- Two-step: `--action create [--wait]` makes a download task; `--action download --task-id <id> --output <path>` fetches the zip. Default output is `./rjob-logs.zip` — choose a workspace path and don't overwrite existing artifacts without asking.

---

## Submit (creates a job — submit on your judgment, then report)

```
rjob submit [job options] [task/resource options] -- <command line>
```

- **The job's command goes after a literal `--` separator.** `submit ... sleep 3600` fails with `unrecognized arguments`; write `submit ... -- sleep 3600`.
- **Normal tasks: add `--private-machine=group` by default.** It schedules the job onto your quota group's private machines; a normal-priority job submitted without it can be rejected for quota and never leave the queue. Idle tasks (`--task-type idle`) don't need it. (`group` and `yes` are equivalent.)
- **Preview flags take a VALUE**: `--predict-only true` (checks resource feasibility) or `--dry-run true` (renders the spec for developer inspection). Bare `--predict-only` is wrong.
- A real submit creates a job and spends resources. Preview first only as your own sanity check when a spec looks risky — there is no confirmation gate, so submit on your own judgment, then report the full config (image / namespace / group / mounts / resources / command / task-type lane) back to the user.

Common options (run `rjob submit --help` for the full list), grouped by purpose:

**Required for a real submit**

| Flag | Meaning |
| --- | --- |
| `--image <image>` | Container image (**required**). `--image=<v>` and `--image <v>` both work. |
| `--cpu <n>` / `--gpu <n>` / `--memory <MB>` | Resource requests. `--gpu` is **per replica**; `--memory` is in **megabytes**. |
| `-- <command>` | The command to run, after a literal `--` separator (see below). |

**Identity, lane, quota**

| Flag | Meaning |
| --- | --- |
| `--name <job-name>` | Job name; omitted → auto `<user>-<timestamp>`. |
| `--task-type {normal,idle}` | Priority lane (default `normal`). `normal` = normal priority → **常规任务** UI tab. `idle` = low priority, preemptible → **闲时任务** UI tab. The tabs are separate, so tell the user which lane you used. |
| `--priority <1-9>` | Fine-grained priority within a `normal` task (default 5; not for idle). |
| `--namespace <ns>` / `--charged-group <group>` / `--group <group>` | Namespace and charged / user quota group. **All default from the worker environment** — pass one only to override the default. |

**Scheduling / placement**

| Flag | Meaning |
| --- | --- |
| `--private-machine group` | **Add to normal tasks by default.** Schedules onto your quota group's private machines; a normal job without it can be denied for quota and never start. Idle tasks don't need it. `group` and `yes` are equivalent. |
| `--host-network true` | Pod uses the host network namespace (common for multi-node + RDMA). |
| `--positive-tags <t>` / `--negative-tags <t>` | Machine features the worker MUST / MUST NOT have (repeatable). |

**Replicas / distributed** (see the distributed section below)

| Flag | Meaning |
| --- | --- |
| `-P <n>` / `--replica <n>` | Replica count (each replica = one pod / node). |
| `--gang-start true` | Start all replicas together and inject every replica's IP into pod env. **Required for multi-replica jobs** (so ranks find each other). |
| `--custom-resources <k>=<v>` | Extra scheduler resources (repeatable). RDMA / InfiniBand for distributed, e.g. `--custom-resources rdma/mlnx_shared=8`. |

**Reliability / restart**

| Flag | Meaning |
| --- | --- |
| `-r <p>` / `--restart-policy <p>` | Restart policy: `never` (default) or `restartjobonfailure`. Normal tasks support `never` only; `restartjobonfailure` is idle-only (pair with `--backoff_limit`). |
| `--auto-restart <false\|true\|always>` | Auto-restart a failed job. `true` = long multi-node run; `always` = endless (e.g. pretraining). Default `false`. |
| `--enable-self-health true` | Auto-heal on node failure / hang. **Not supported for idle tasks.** |
| `--backoff_limit <n>` | (idle) max evictions / restarts; default 1, max 100. |
| `--termination-grace-period-seconds <n>` | (idle) graceful-stop window; default 0, range 0–300. |
| `--share-host-shm True` | Mount host `/dev/shm` into the container — **required by the checkpoint engine**. |

**Environment / mounts** (see the mounts section below)

| Flag | Meaning |
| --- | --- |
| `-e <K=V>` / `--env <K=V>` / `--set-env <K=V>` | Environment variable inside the job. Repeatable / space-separated: `-e A=1 B=2`. |
| `--mount=<src>:<dst>` | Mount a storage path into **each replica** (repeatable). Source is a GPFS volume `gpfs://<vol>/<path>` — see the mounts section. |

**Preview (do not create)**

| Flag | Meaning |
| --- | --- |
| `--predict-only true` | Check resource feasibility. |
| `--dry-run true` | Render the spec for inspection. |

Single-replica example (`--namespace` / `--charged-group` omitted — they default from the env):
```
rjob submit --name demo --image <img> \
  --private-machine=group --cpu 8 --memory 16384 --gpu 0 -- python train.py
```
Preview the same line by adding `--predict-only true`; submit for real by removing it. No confirmation step — submit, then report the config back. (Drop `--private-machine=group` only for `--task-type idle`.)

### Environment variables, mounts, and the command

- **The command after `--` is run as a single argv.** For a multi-step command (activate an env, `cd`, then run), wrap it in `bash -c "..."`:
  ```
  rjob submit ... -- bash -c "source ~/.bashrc && conda activate myenv && cd /path/to/proj && python train.py --foo bar"
  ```
  A bare `-- source ... && python ...` does **not** work — only `bash -c` gives you a shell that understands `&&` / `source` / `cd`.
- **`-e K=V` sets env vars** the job sees (e.g. `-e DISTRIBUTED_JOB=true`). Repeatable.
- **`--mount=<src>:<dst>` mounts storage into each replica** (repeatable, one per path). On this cluster the source is a **GPFS volume** in the form `gpfs://<vol>/<subpath>`, mounted at a container path:
  ```
  --mount=gpfs://gpfs1/<your-dir>:/mnt/shared-storage-user/<your-dir>
  --mount=gpfs://gpfs2/<shared-dataset>:/mnt/shared-storage-gpfs2/<shared-dataset>
  ```
  The specific volumes / paths are environment- and job-specific — take them from the user (or your config library), don't invent them.

### Distributed / multi-node training flags

For a job that spans multiple replicas / nodes (GPU-heavy training):
- `-P <n>` — number of replicas (nodes).
- `--gang-start true` — **required** so all replicas start together and each pod learns the others' IPs.
- `--host-network true` — pod uses host networking.
- `--custom-resources rdma/mlnx_shared=8` (and any other `--custom-resources k=v` the cluster needs) — RDMA / InfiniBand for inter-node collective ops.
- `--auto-restart true` for a long multi-node run; `--enable-self-health true` to auto-heal on node failure.

See `templates.md` for a full distributed example.

---

## Destructive commands (delete is gated by the permission card)

### stop — stop a running job
```
rjob stop <job>... [--name <showname>] [--force] [--force-all] [--namespace <ns>]
```

### delete — delete a job
```
rjob delete <job>... [--name <showname>] [--force-all] [--namespace <ns>]
```

- Pin the exact job with `get` / `list`, then run `stop` / `delete` directly. Prefer `stop` if the user only wants to halt work; `delete` removes the record irreversibly.
- `rjob delete` is classified high-risk: it surfaces a permission confirmation the user must approve each time, and that approval can never be granted "always". That card is the gate — don't add your own, and don't try to route around it (there is no bypass to reach for).

---

## Spec-editing commands (caution — inspect before acting)

### clone — copy a job spec into a new job
```
rjob clone <job> [--name <new-name>] [--auto-restart <v>] [--stop-original <v>] [--namespace <ns>]
```

### patch — change an existing job's task
```
rjob patch <job> [--task_name <t>] [-P <replicas>] [--auto-restart <v>] [--namespace <ns>]
```

- Treat both as spec mutations: apply, then report what changed. A `clone` is not a `submit` — don't silently turn it into one.

---

## Gotchas (get these right — don't guess)

- `logs` needs `job`/`replica` as the first positional. `events` defaults to job, `--replica` for a replica.
- `submit` needs `--` before the command, and `--predict-only`/`--dry-run` need a `true` value.
- A multi-step job command (`source` / `conda activate` / `cd` / `&&`) must be wrapped: `-- bash -c "..."`. A bare `-- a && b` does not run `b` in the job.
- `--mount`, `-e`, and `--custom-resources` are **repeatable** — pass one per entry. The mount source is `gpfs://<vol>/<path>`.
- Multi-replica distributed jobs need `--gang-start true` (and usually `--host-network true` + RDMA via `--custom-resources`). Without `--gang-start`, replicas can't discover each other.
- A normal task stuck in `Inqueue` / `Pending` whose `events` show `insufficient group quota` usually just needs `--private-machine=group` (it went to the shared pool) — add it and re-submit before concluding the cluster is out of quota. Idle tasks don't use it.
- The tail flag is `-n` / `--tail-lines`, never `--tail`.
- There is no `kubectl` / `kubebrain` CLI in this skill — only the `rjob` subcommands above. Don't invent commands; if something isn't covered, run `rjob <subcommand> --help`.
- If `rjob` is missing (`command -v rjob` empty), this environment lacks the Brain++ toolchain — report it and stop rather than improvising.
