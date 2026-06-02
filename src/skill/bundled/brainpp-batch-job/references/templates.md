# rjob templates and troubleshooting

Exact command shapes are in `command-mapping.md`. This file is the end-to-end flow and copy-paste templates. Every `rjob ...` below runs through `rjob ...`.

## Submit flow

You submit on your own judgment — there is no per-submit confirmation step. The order is: assemble the spec, optionally sanity-check it, submit, report everything back, remember what had no default.

1. **Assemble the spec.** Image, mounts / GPFS paths, resources (`--cpu` / `--gpu` / `--memory` in MB), the command (after `--`), and where logs/output land. Pull image / mounts from what you have on record first; ask the user only for what nothing on record covers. **Namespace and charged/quota group default from the worker environment** — leave `--namespace` / `--charged-group` off unless the user wants a non-default one.
2. **Preview (optional, your own sanity check — not a user gate).** `--predict-only true` checks resource feasibility; `--dry-run true` renders the spec. Run one when you want to catch a bad spec before spending:
   ```
   rjob submit --predict-only true --name <job> --image <img> \
     --cpu <n> --gpu <n> --memory <MB> -- <command line>
   ```
3. **Submit.** Run the real `submit` (same command, drop the `--predict-only true` flag):
   ```
   rjob submit --name <job> --image <img> \
     --cpu <n> --gpu <n> --memory <MB> -- <command line>
   ```
4. **Report the full config to the user.** The job name plus image, the effective namespace + charged/quota group, mounts / GPFS paths, resources, command, and the **task-type lane** — `normal` (normal priority → `常规任务` tab) or `idle` (low priority, preemptible → `闲时任务` tab). They did not approve it beforehand, so they must see exactly what ran and which tab to find it under. Hand back the follow-ups: `get <job>`, `logs job <job> -n <N>`, `events <job>`, `download-logs <job> --action create --wait`.
5. **Add the config to your library** — the image / mounts (and any namespace / group the user named) for this kind of work — via `MemoryWrite`, so it becomes a candidate you can reuse and pick from next time. Keep distinct task→config choices as separate options; dedupe only exact repeats. See "Build a config library" in `SKILL.md`.

### Minimal single-command job
```
rjob submit --predict-only true --name demo-train --image <img> \
  --cpu 8 --memory 16384 --gpu 1 -- python train.py --epochs 10
```
`--namespace` / `--charged-group` are omitted on purpose: `rjob` fills them from the worker environment. Add them only to override the env default.

### Low-priority (idle) sleep / smoke-test job (no GPU)
```
rjob submit --predict-only true --name idle-probe --image <img> \
  --task-type idle --cpu 1 --memory 1024 --gpu 0 -- sleep 3600
```
`--task-type idle` puts the job in the **low-priority lane** — it is preemptible and shows under the **闲时任务** UI tab, not 常规任务. Use it for throwaway smoke tests; use `normal` (omit `--task-type`, the default) for real training. Whichever you pick, tell the user the lane so they look under the right tab.

Note the `-- sleep 3600`: the command after `--` is what runs inside the job. `submit ... sleep 3600` (no `--`) fails.

### Distributed / multi-GPU training job (multi-replica + RDMA)

For training that spans several full GPU nodes. The extras over the single-command job are: `-P <replicas>`, `--gang-start true` (replicas discover each other), `--host-network true`, RDMA via `--custom-resources`, one `--mount=` per storage path, `-e` env vars, and a `bash -c` compound command. All the `<...>` values are environment-/job-specific — take them from the user or your config library, don't invent them.

```
rjob submit --predict-only true --name <job> --image <img> \
  -P 2 --gpu 8 --cpu 64 --memory 819200 \
  --gang-start true --host-network true --private-machine group \
  -e DISTRIBUTED_JOB=true \
  --custom-resources rdma/mlnx_shared=8 \
  --custom-resources mellanox.com/mlnx_rdma=1 \
  --mount=gpfs://gpfs1/<your-dir>:/mnt/shared-storage-user/<your-dir> \
  --mount=gpfs://gpfs2/<dataset>:/mnt/shared-storage-gpfs2/<dataset> \
  -- bash -c "source <env-setup> && conda activate <env> && cd <proj-dir> && python <train-script> <args>"
```

- `-P` is the replica (node) count; `--gpu 8` is **per replica** → 2 nodes × 8 GPU here.
- `--gang-start true` is **required** for multi-replica: it starts all replicas together and injects every replica's IP into pod env so ranks can find each other. `--custom-resources rdma/...` exposes the RDMA / InfiniBand devices collective ops need.
- Repeat `--mount=<src>:<dst>` once per path; `-e K=V` once per env var.
- The run command goes through `bash -c "..."` so `source` / `conda activate` / `cd` / `&&` actually work — a bare `-- a && b` would not run `b`.
- For a long run add `--auto-restart true` (and `--enable-self-health true` to auto-heal on node failure; note self-health is not available for idle tasks).
- Drop `--predict-only true` to submit for real, then report the full config (image / replicas / GPU / mounts / env / command / lane) back to the user.

## Monitor / debug flow

1. `get <job>` — phase, replica names, resource requests, recent status.
2. `events <job>` — scheduling, quota, image-pull, mount, eviction messages (add `--replica` for a single replica).
3. `logs job <job> -n 200` — always pass `-n` to bound output; raise it only when needed.
4. `download-logs <job> --action create --wait` then `--action download --task-id <id> --output <workspace-path>` — full artifact, only when needed.

## Failure triage checklist

For a `Failed` / `Stopped` / stuck job, in order:

- **Scheduling / quota** → `events`: pending, insufficient resources, quota denied.
- **Image** → `events`: image-pull errors, wrong tag, registry auth.
- **Mounts / paths** → `events` + `logs`: GPFS/workspace path not found, permission denied.
- **Command / args** → `logs`: the program's own stderr; compare against the submitted `-- <command>`.
- **Resources** → `get`: requested `--cpu`/`--gpu`/`--memory` vs what the job actually needs (OOM-kill, etc.).

Report the likely cause, the evidence line, and the next safe action. Don't dump unbounded logs and don't leak credentials.

## Safety rules

- This skill is for **batch jobs only**. Interactive sandbox / shell work is the runtime backend's job (`runtime.backend`), not rjob — they are orthogonal.
- Run `submit` / `stop` / `clone` / `patch` on your own judgment, then report what you did. `delete` is the one hard gate — a real `rjob delete` surfaces a permission card the user must approve each time; that approval is the gate, so never add your own and never try to route around the card.
- Treat `clone` / `patch` as spec edits — apply, then report the delta; a `clone` is not a `submit`.
- Keep log reads bounded unless the user asks for a full artifact.
- Credentials (tokens / accesskeys / passwords) never enter a command line, log, or memory. Image, mounts, and namespace/group overrides are config, not secrets — record them (see `SKILL.md`) so you stop re-asking.
