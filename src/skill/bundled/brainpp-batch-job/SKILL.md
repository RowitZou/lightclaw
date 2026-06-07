---
name: brainpp-batch-job
description: "Workflow and judgment layer for the cluster job tool — the whole job lifecycle (launch, monitor, wrap up), the decisions and parameter choices at each stage, output conventions, and the blockers that need the user. Operations: capacity, submit, list, get, logs, events, stop, delete."
when_to_use: "Use when the user wants to submit, inspect, monitor, stop, or delete cluster batch training jobs, check cluster GPU / CPU / memory availability, or whenever a task needs more CPU / memory / GPU than your own environment has (see Environment Info) — run it as a cluster job rather than inline. Examples: 'submit this training job to the cluster', 'tail logs for my batch job', 'how many GPUs are free in my group', 'stop that cluster job', 'run this GPU job'. This is for batch jobs."
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

# Cluster Batch Jobs

This is the judgment layer for the cluster job tool — it covers a cluster batch job's whole lifecycle, from launching it through monitoring to wrapping up, and the decisions at each stage. The tool carries the mechanism (exact submit syntax, distributed flags, lane options); you decide, it builds.

## Scope to the request

The lifecycle below is a map, not a script you must run end to end. Do only what the request calls for, and enter at the stage it points to:
- "How many GPUs are free?" → just the capacity check.
- "Tail the logs for X" / "what's the status of Y" → just that read.
- "Stop / delete job Z" → just that stage.
- Handed a single step → do that step only.
- "Run this training job for me" → the full arc, launch through wrap-up.

A specific instruction wins over the full sequence: don't expand a quick question into a whole job launch, and don't skip a step the request actually needs. When you've done what was asked, stop.

## What the tool gives you

Operations:
- `capacity` — free GPU / CPU / memory in your group (or another group the user names).
- `submit` — create a new job.
- `list` — enumerate your jobs.
- `get` — one job's status, phase, and replicas.
- `logs` — read a job's logs (bounded).
- `events` — a job's scheduling / lifecycle events.
- `stop` — halt a running job.
- `delete` — remove a job record.

Your `/workspace` is **auto-mounted into every job** at the same `/workspace` path, so anything you prepare there is already in the job — no re-upload.

Drive everything through these operations — don't hand-build cluster commands in a shell. Use it for batch work: training, evaluation, or anything heavier or longer than a quick step you'd run yourself.

## Posture

- **Scope to the request first** (see *Scope to the request*), and let what's asked set how you carry it:
  - **A full job, end to end → long-horizon and autonomous.** Act on your own judgment and carry it through — submit, monitor, wrap up without waiting for a click, and **don't stop between stages**: a job left half-run mid-lifecycle is the failure to avoid.
  - **A single step or quick ask → do that one thing and return.** Answer the capacity check, the log tail, the stop — then stop; don't expand it into a launch or spin up monitoring nobody asked for.
- Take avoidable failures off the table before you spend a submit (capacity, image, environment, network).
- Report as you go, in plain text — what you ran, progress, the outcome. Reporting beats silence.
- Reuse what worked from your config library, and record what you learn.

## The job lifecycle

A full run moves through three stages — launch, monitor, wrap up. Enter at the stage the request points to (see *Scope to the request*); run all three only when you're taking a job end to end.

### Stage 1 — Launch

1. **Does it belong on the cluster?** Heavy or long work does: GPU training and large eval, but **also memory-hungry or big-CPU jobs**. Your own environment is modest (see **Environment Info**) — running such work yourself risks OOM-killing your own process, so push it to a cluster job. A quick, light step is faster done directly; don't submit a job for that.

2. **Check capacity, then go with your plan.** Run `capacity` for the relevant group (your own by default; another only if the user named one).
   - **A figure the user gave (e.g. 8 GPUs) is a hard requirement — don't shrink it.** If it won't fit, that's a blocker.
   - **When the figure is yours to choose**, size it from the task; if your plan won't fit, you may scale down toward the minimum the task actually needs. Only if even that minimum won't fit is it a blocker.
   - The resource blocker default is **queue and wait** (see *When you're genuinely blocked*).

3. **Assemble the spec from your library; default or ask for what's missing.**
   - **Image** — reuse from your library; nothing on record → *(blocker)*.
   - **Environment** (linked to the image) — use a working env in `/workspace` if there is one; otherwise use the environment the image ships; only if the image lacks it too is it a *(blocker)*. Don't ask while either source still has a usable env.
   - **Network** — if you have a recorded network / proxy setup, apply it; if not, add nothing and just run (don't ask up front when there's no record but the job can connect fine). Only if connectivity then turns out slow or stuck, or a large download drags on → *(blockers — see below)*.
   - **Resources** — from the task and what `capacity` showed.

4. **Set the parameters by the job's shape:**
   - **Lane** (`taskType`): default `normal`. `idle` is **preemptible** — a preemption kills the job and you restart from your last saved state, losing everything since. The test is **how long a restart takes to get back to where the preemption hit**: minutes (cheap to re-run, or very frequent checkpoints) → `idle` is fine; hours (e.g. training that checkpoints only every few hours — a preemption throws away every step since the last checkpoint) → **never `idle`**, use `normal`. Don't assume "it has checkpoints" makes it idle-safe; assume it only if the work lost between checkpoints costs minutes, not hours.
   - **GPU** (`gpu`): GPU work → set the per-replica count; pure-CPU job → leave it 0.
   - **Single vs multi-node**: one node → leave `replicas` at 1; distributed multi-node → set `replicas` > 1.
   - **Where it runs, what it mounts**: `namespace` and `chargedGroup` default to your environment's — set them only to target a different namespace / quota group. `/workspace` is always mounted; add more storage with `mounts` — list the cluster paths you want available (a shared dataset or weights directory); give the path as-is and the tool maps each into the job. Set `priority` (default 1 = lowest) only to move a normal job up the queue.
   - **extraArgs**: leave it empty by default — the parameters above cover the normal cases. Add raw flags here only when the user explicitly asks for an option not modeled above, passing their flags through verbatim.

5. **Write the command well.** The command usually launches a script from `/workspace`. Make it: read its inputs from and write its outputs to `/workspace` so results survive the job; **emit periodic progress** (step logs / a heartbeat) — a long job that prints nothing can't be told apart from a hung one while monitoring; and **keep intermediate output bounded** — storage is finite, so don't let it pile up unbounded large intermediates (checkpoints especially): keep only what's needed (e.g. the last N checkpoints) and clean up the rest.

6. **Preview a risky spec, then submit.** When a spec looks expensive or uncertain, run it once with `predictOnly` (resource feasibility) or `dryRun` (rendered spec) as your own check. Then submit for real — there's no confirmation gate.

7. **Report and record.** Report what you submitted (see *Output conventions*), then record the config you used (image / env / network) in your library.

### Stage 2 — Monitor

1. **Check status.** `get` for phase and replicas; `events` for the scheduling / quota / image-pull story.
2. **Read the phase correctly.** Not running yet (pending / scheduling / pulling image) is normal startup, not failure — say "still starting" and re-check after a short wait. Once running, read bounded `logs` (`tailLines`) to gauge progress; raise the bound only when you need more.
3. **Triage if stuck or failed**, in order: **scheduling / quota** (`events`; a genuinely full group shows in `capacity`) → **image** (pull error, wrong tag) → **mounts / paths** (`events` + `logs`) → **command / args** (`logs`, the program's own stderr) → **resources** (`get`; OOM). Network slow / stuck or a large download dragging are blockers (below).
4. **For a long run, hand off to a watcher** instead of poll-looping — but only if you're running the job end to end. Set up a background watcher on an interval with a tightly-scoped prompt that does one thing — *check this job's status and report it, nothing else: no submit / change / stop, and spawn no further work* — and cancel it at a terminal state. (Handed only the monitoring step? Do one check and return — don't spawn a watcher.)
5. **Report.** See *Output conventions* — phase, progress, and any concern, in plain text; flag a must-not-miss moment (needs a decision, finished with an important result, blocked on the user) prominently rather than burying it in routine updates.

### Stage 3 — Wrap up or stop

1. **Reach a terminal state.** A job ends either by finishing on its own (succeeded / failed / stopped) or because you stop it. Stop it yourself only when: the user set a stop condition and it's met; or it's provably wasted with no path to success (hard crash-loop, loss gone NaN / diverged); or it's clearly hung — no new logs for far longer than its expected cadence (e.g. ~1h of silence when you'd expect regular output). Anything that merely *looks* off but is ambiguous is a blocker — ask, default **keep running**. `stop` only halts the job; it never deletes the record, and you `delete` only when the user explicitly asks (never to tidy up, after a failure, or to free a slot).
2. **Collect the results.** Take a final bounded `logs`, locate the outputs under `/workspace`, and — if it failed — the triaged cause.
3. **Report.** See *Output conventions* — the outcome, where the artifacts are, and the next safe action.
4. **Capture the lesson.** Record a working env / image / network config (or a pitfall to avoid) in your library so the next job skips it. Keep persistent outputs in `/workspace`; don't leave large throwaway artifacts lying around.

## Remember what works (config library)

`image`, the **network / proxy** setup, and the **runtime environment** describe what a particular job needs; the environment can't default them. Use `MemoryWrite` to keep a library of what the user has used or what you got working, and pick from it instead of re-asking or re-discovering:
- Record each config tied to *what it was for* (the kind of task or project), so it reads as "for `<this kind of work>`, the setup is `<image / env / network>`".
- Keep genuinely different choices as distinct options; dedupe only exact repeats.
- Before asking, pick the fit from the library and report which one you chose. Record configs, never credentials.
- A remembered config is a hint, not a guarantee — if it no longer works (image gone, env broke, proxy dead), treat the value as missing and re-resolve it (a blocker); don't force a stale one.

## Staging in /workspace

Because your `/workspace` is auto-mounted into every job, prepare once and reuse instead of rebuilding per job: set up a conda / venv there, install deps, place code and small data — each job then activates that env from `/workspace` with no per-job reinstall. Write job outputs under `/workspace` so they survive the job; for heavy intermediate IO inside the job, use the job's own local / temp space and copy only final artifacts back. Iterating is cheap: fix things in `/workspace`, resubmit, the job picks up the change.

## When you're genuinely blocked

These are the points you cannot settle alone. Bring each to the user through an `AskUserQuestion` card — you MUST use the card when the tool is available; plain text is the wrong move. Every card carries concrete options **and a safe default: the action taken if the user doesn't respond.** If you don't have the tool, put the open question in your result for the requester. Don't stall, don't guess an environment-specific value, don't go probing.

- **No image on record** — nothing in your library covers the image, and an image is mandatory. Ask which one; don't probe a registry, guess a tag, or copy another job's. Default: **don't submit** — without an image the job can't run, so if the user doesn't answer, stop.
- **No environment anywhere** — neither `/workspace` nor the image has a usable env. Ask whether to point at an existing env or an env-bearing image. Default: **build it in `/workspace`.**
- **Network slow or stuck (a job that needs the internet)** — your recorded network / proxy setup is missing or has stopped working and connectivity is failing (try the recorded setup first; only ask once everything you have fails). Ask for a working network / proxy. Default: **proceed without the network** — fall back to an alternative, or finish the parts that don't need it.
- **A large download dragging on** — a checkpoint or big dataset where the connection is fine but the transfer is taking very long. Ask whether to keep waiting. Default: **stop the download** — fall back, or finish the parts that don't need it.
- **Not enough capacity for the task's minimum** — a user-specified figure won't fit, or even the task's minimum footprint won't fit in the group. Ask whether to wait or reduce scope. Default: **queue and wait.** (When the amount is yours to choose, choosing it is not a blocker — decide it yourself, or follow the user's figure.)
- **A running job that looks off but ambiguously** — it might be going wrong, but you can't tell whether it's truly wasted (vs a slow phase). Ask whether to stop it. Default: **keep running** — don't stop on a guess. (Clear-cut cases — user stop condition met, hard crash-loop, NaN/diverged, or hung with no logs ~1h — you stop on your own judgment; see Stage 3.)

## Output conventions

- **Match the report to the work.** A one-off read (a capacity check, a status, a log tail) is a tight summary — the number, the phase, the relevant lines — not a lifecycle write-up. A full run gets a fuller report. Don't pad.
- **After a submit**, report what ran so the user can find and trust it: job name, image, resources (CPU / GPU / memory), mounts (including the auto `/workspace`), the command, and the lane (`normal` → `常规任务` tab / `idle` → `闲时任务` tab).
- **While monitoring**, report phase + progress and any concern in plain text; flag a must-not-miss moment prominently rather than burying it in routine updates.
- **On wrap-up**, report the outcome and where the artifacts are (under `/workspace`); on failure, the triaged cause and the next safe action.
- **Stale-config acknowledgement**: if a remembered config turned out wrong (image gone, env broke, proxy dead), say so in the report so it gets corrected — don't silently work around it.

## Do not

- Don't expand a quick, single-step request into the full lifecycle — do only what was asked, then stop (see *Scope to the request*).
- Don't ask "shall I proceed?" when nothing is unresolved — only genuine blockers go to the user.
- Don't read logs unbounded — use the `tailLines` cap (default 200); pull a full log artifact only when a bounded tail isn't enough.
- Don't `delete` a job unless the user explicitly asks for it.
- Don't put a credential in a command, log, or memory.
