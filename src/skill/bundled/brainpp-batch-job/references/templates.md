# rjob templates and troubleshooting

Exact command shapes are in `command-mapping.md`. This file is the end-to-end flow and copy-paste templates. Every `rjob ...` below runs through `rjob ...`.

## Submit flow (the only safe order)

1. **Collect the spec.** From the user: the command to run, image, resources (`--cpu` / `--gpu` / `--memory` in MB), namespace, charged/quota group, code/data location, and where logs/output should land. Ask for anything missing — do not guess env-specific values.
2. **Preview** with a value-bearing flag and the `--` command separator:
   ```
   rjob submit --predict-only true --name <job> --image <img> \
     --cpu <n> --gpu <n> --memory <MB> --charged-group <group> --namespace <ns> \
     -- <command line>
   ```
   `--predict-only true` checks resource feasibility; `--dry-run true` renders the spec instead. Run whichever (or both) the user needs.
3. **Summarize** the predicted resources, image, command, mounts/paths, **and the task type** back to the user. State plainly whether it is a `normal` (normal-priority, `常规任务` tab) or `idle` (low-priority, preemptible, `闲时任务` tab) job — the two land under different UI tabs, so the user cannot find the submitted job unless you say which. Flag anything missing or risky.
4. **Get the user's confirmation, then submit for real** — re-run the same command with the `--predict-only true` preview flag removed:
   ```
   rjob submit --name <job> --image <img> \
     --cpu <n> --gpu <n> --memory <MB> --charged-group <group> --namespace <ns> \
     -- <command line>
   ```
5. **Hand back** the job name plus the follow-ups: `get <job>`, `logs job <job> -n <N>`, `events <job>`, `download-logs <job> --action create --wait`.

### Minimal single-command job
```
rjob submit --predict-only true --name demo-train --image <img> \
  --cpu 8 --memory 16384 --gpu 1 --charged-group <group> --namespace <ns> \
  -- python train.py --epochs 10
```

### Low-priority (idle) sleep / smoke-test job (no GPU)
```
rjob submit --predict-only true --name idle-probe --image <img> \
  --task-type idle --cpu 1 --memory 1024 --gpu 0 --charged-group <group> --namespace <ns> \
  -- sleep 3600
```
`--task-type idle` puts the job in the **low-priority lane** — it is preemptible and shows under the **闲时任务** UI tab, not 常规任务. Use it for throwaway smoke tests; use `normal` (omit `--task-type`, the default) for real training. Whichever you pick, tell the user the lane so they look under the right tab.

Note the `-- sleep 3600`: the command after `--` is what runs inside the job. `submit ... sleep 3600` (no `--`) fails.

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
- Never run a real `submit`, `stop`, or `delete` without explicit user confirmation — that is your responsibility (there is no wrapper). `rjob delete` additionally surfaces a permission prompt the user must approve; never try to route around it.
- Treat `clone` / `patch` as spec edits — inspect and explain the change first.
- Keep log reads bounded unless the user asks for a full artifact.
- Keep namespace, charged group, image, GPFS paths, and any credentials out of source and memory; take them per-job from the user.
