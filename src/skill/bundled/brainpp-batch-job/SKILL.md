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
  - TaskUpdate
  - Message
roles:
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
- Take avoidable failures off the table before you spend a submit: **have the image** (a precondition — from your library, or ask the user; never guess-and-pull one), then stage and validate the run — assets, environment, network, capacity (see *Prepare and stage before you submit*).
- **The few things you genuinely can't settle — image, environment, network, capacity — are the exception to "don't stop".** Don't guess an environment-specific value just to keep moving: put it to the user with a safe default (see *When you're genuinely blocked*), then carry on. Stopping there is part of the autonomy, not a break from it.
- Report as you go, in plain text — what you ran, progress, the outcome. Reporting beats silence.
- Reuse what worked from your config library, and record what you learn.

## The job lifecycle

A full run moves through three stages — launch, monitor, wrap up. Enter at the stage the request points to (see *Scope to the request*); run all three only when you're taking a job end to end.

### Stage 1 — Launch

1. **Does it belong on the cluster?** Heavy or long work does: GPU training and large eval, but **also memory-hungry or big-CPU jobs**. Your own environment is modest (see **Environment Info**) — running such work yourself risks OOM-killing your own process, so push it to a cluster job. A quick, light step is faster done directly; don't submit a job for that.

2. **Check capacity, then go with your plan.** Run `capacity` for the relevant group (your own by default; another only if the user named one).
   - **A figure the user gave (e.g. 8 GPUs) is a hard requirement — don't shrink it.** If it won't fit, that's a blocker.
   - **When the figure is yours to choose**, size it from the task; if your plan won't fit, you may scale down toward the minimum the task actually needs. Only if even that minimum won't fit → *(blocker)*.

3. **Assemble the spec from your library; default or ask for what's missing.**
   - **Image** — reuse from your library; nothing on record → *(blocker)*.
   - **Environment** — reuse a working env in `/workspace`, else the env the image ships; build one only if neither works (see *Prepare and stage*), don't jump to building when a usable one is there. A library the run needs but lacks splits by ownership: your own `/workspace` env → repair it (`UseSkill('build-environment')`); the image's env or a user-provided one, which you can't change → *(blocker)*.
   - **Network** — apply a recorded proxy if you have one; if not, the cluster itself may have connectivity, so it's fine to proceed without one. The real job should only need the network for what you couldn't stage (see *Prepare and stage before you submit*) or what legitimately runs online (experiment logging, an API). But the moment a fetch keeps failing or dragging — the same request timing out and retrying — that is a *(blocker — see below)*, not a phase to wait out: surface it, don't keep retrying in place.
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
4. **For a long run, set a timer and step away** instead of poll-looping — but only if you're running the job end to end. Declare a wait (TaskUpdate wait, timer wake — pick an interval matching the job's expected cadence, e.g. 30 minutes) with a checkpoint naming the job id and what to look at; each time you come back, check status once, and either declare the next wait or wrap up at a terminal state. (Handed only the monitoring step? Do one check and return — don't set up ongoing monitoring.)
5. **Report.** See *Output conventions* — phase, progress, and any concern, in plain text; flag a must-not-miss moment (needs a decision, finished with an important result, blocked on the user) prominently rather than burying it in routine updates.

### Stage 3 — Wrap up or stop

1. **Reach a terminal state.** A job ends either by finishing on its own (succeeded / failed / stopped) or because you stop it. Stop it yourself only when: the user set a stop condition and it's met; or it's provably wasted with no path to success (hard crash-loop, loss gone NaN / diverged); or it's clearly hung — no new logs for far longer than its expected cadence (e.g. ~1h of silence when you'd expect regular output). Anything that merely *looks* off but is ambiguous is a *(blocker)* — see *When you're genuinely blocked*. `stop` only halts the job; it never deletes the record, and you `delete` only when the user explicitly asks (never to tidy up, after a failure, or to free a slot).
2. **Collect the results.** Take a final bounded `logs`, locate the outputs under `/workspace`, and — if it failed — the triaged cause.
3. **Report.** See *Output conventions* — the outcome, where the artifacts are, and the next safe action.
4. **Capture the lesson.** Record a working env / image / network config (or a pitfall to avoid) in your library so the next job skips it. Keep persistent outputs in `/workspace`; don't leave large throwaway artifacts lying around.

## Remember what works (config library)

`image`, the **network / proxy** setup, and the **runtime environment** describe what a particular job needs; the environment can't default them. Use `MemoryWrite` to keep a library of what the user has used or what you got working, and pick from it instead of re-asking or re-discovering:
- Record each config tied to *what it was for* (the kind of task or project), so it reads as "for `<this kind of work>`, the setup is `<image / env / network>`".
- Keep genuinely different choices as distinct options; dedupe only exact repeats.
- Before asking, pick the fit from the library and report which one you chose. Record configs, never credentials.
- A remembered config is a hint, not a guarantee — if it no longer works (image gone, env broke, proxy dead), treat the value as missing and re-resolve it (a blocker); don't force a stale one.

## Prepare and stage before you submit

The real job should be a deterministic run over assets you already staged — not an exploration that discovers what it needs while burning cluster time (and, on GPU, scarce cards). Prepare first, then submit. Because your `/workspace` is auto-mounted into every job, everything you stage there is already in the job with no re-upload. Treat preparation as a gate the real run passes through, not an optional optimization.

**The cluster job's image is the exception — you don't stage it.** `/workspace` can't hold the image a submit runs on, and you don't build or pull one into existence here: you either already have a known-good image (from your library) or you ask the user for an internal one (see *When you're genuinely blocked*). (This is about the *submitted job's* image — not a blanket rule against images; spinning up a local container for some other task is a different context.) Never guess-and-pull public / private images to "prepare" a run — a failed pull is a blocker for the user, not a cue to try more tags. Everything below is what you *can* stage:

- **Make sure every external asset is in place before the run needs it** — model weights / checkpoints, datasets, pip packages. If it already lives on a cluster path you can mount, point the job straight at it or symlink it — don't copy it into `/workspace` and waste storage (ask the user if you're unsure such a copy exists). Fetch only what's genuinely missing, into `/workspace`, ahead of time. The point is that the real job never has to *discover and fetch* a missing dependency mid-run, where a stall or timeout wastes the whole submit; doing it now turns a network problem into a cheap blocker you handle here (see *When you're genuinely blocked*). This removes avoidable run-time fetches — it does not ban the network: a job that legitimately needs it at run time (experiment logging like wandb, an online API) is fine.
- **Settle the environment before you submit — and never let the job install it.** Take what already works, in order: an env in `/workspace`, then the env the image ships. If you must build or repair one, **`UseSkill('build-environment')`** — that skill owns *how*; on the cluster it just runs from a prep job in the target image, into `/workspace`. Whatever env you land on, finish it *before* the run — never bake `pip install` / `apt` into the job command (the slow, network-bound, per-run-flaky anti-pattern). Don't link or copy the image's env into `/workspace`: a `/workspace` env that's secretly a `--system-site-packages` venv over the image's conda only resolves inside that image (it lists but cannot run outside it). A missing library splits by ownership: an env you built in `/workspace` is yours to fix (repair via the skill, then re-stage); a backend or library missing from the image's env or a user-provided one is not yours to paper over → *(blocker)*.
- **Validate before the expensive run.** Prove the staged setup with a cheap check in the *same image* — import the heavy modules, run a 1-step / tiny end-to-end — so missing deps and version conflicts surface in a throwaway job, not after the real run has spun up on a GPU. Iterate in this cheap prepare/smoke loop; don't iterate by resubmitting the full job.

Write job outputs under `/workspace` so they survive the job; for heavy intermediate IO inside the job, use the job's own local / temp space and copy only final artifacts back.

## When you're genuinely blocked

These are the points you cannot settle alone. Bring each to the user through an `AskUserQuestion` card — you MUST use the card when the tool is available; plain text is the wrong move. Every card carries concrete options **and a safe default: the action taken if the user doesn't respond.** If you don't have the card tool, ask your requester instead (Message with no `to`) with the same options and default — the answer comes back as the tool's return, so you keep working rather than parking the question in your final result. Don't stall, don't guess an environment-specific value, don't go probing.

- **No usable image (none on record, or your candidate won't pull)** — an image is mandatory, and either nothing in your library covers it or the one(s) you tried won't pull (private-registry timeout, public-tag DNS / mirror failure, or any internal-resource access you can't confirm). Ask the user for a known-good internal image (or a prior successful job's spec); don't probe a registry, guess a public tag, or copy another job's. Default: **don't submit** — without a pullable image the job can't run, so if the user doesn't answer, stop.
- **No usable environment (none, or missing a backend / library you can't supply)** — neither `/workspace` nor the image has a usable env, *or* the one you'd use is missing something the run needs (e.g., a rollout backend, a library) that you can't add yourself because it's the image's env or a user-provided one. Ask whether they have an env-bearing image or an existing env to point at. Default: **build a complete one yourself in `/workspace`** via `UseSkill('build-environment')` (in the target image).
- **Network slow or stuck (while prefetching, or a job that genuinely needs the internet at run time)** — your recorded proxy is missing or not working and connectivity is failing. Try the recorded setup once, then ask as soon as it's clearly not connecting — don't grind through every retry first. Ask for a working network / proxy. Default: **proceed without the network** — fall back to an alternative, switch an online-only feature to offline mode (e.g. experiment logging), or finish the parts that don't need it.
- **A large download dragging on** — a checkpoint or big dataset where the connection is fine but the transfer is taking very long. Ask whether to keep waiting, **and whether there's an existing copy on a cluster path you can point at instead.** Default: **stop the download** — use that existing path if the user names one, otherwise fall back to an alternative or finish the parts that don't need it.
- **Not enough capacity for the task's minimum** — a user-specified figure won't fit, or even the task's minimum footprint won't fit in the group. Ask whether to wait or reduce scope. Default: **queue and wait.** (When the amount is yours to choose, choosing it is not a blocker — decide it yourself, or follow the user's figure.)
- **A running job that looks off but ambiguously** — it might be going wrong, but you can't tell whether it's truly wasted (vs a slow phase). Ask whether to stop it. Default: **keep running** — don't stop on a guess. (Clear-cut cases — user stop condition met, hard crash-loop, NaN/diverged, or hung with no logs ~1h — you stop on your own judgment; see Stage 3.)

## Output conventions

- **Match the report to the work.** A one-off read (a capacity check, a status, a log tail) is a tight summary — the number, the phase, the relevant lines — not a lifecycle write-up. A full run gets a fuller report. Don't pad.
- **After a submit**, report what ran so the user can find and trust it: job name, image, resources (CPU / GPU / memory), mounts (including the auto `/workspace`), the command, and the lane (`normal` → `常规任务` tab / `idle` → `闲时任务` tab).
- **While monitoring**, report phase + progress and any concern in plain text; flag a must-not-miss moment prominently rather than burying it in routine updates.
- **On wrap-up**, report the outcome and where the artifacts are (under `/workspace`); on failure, the triaged cause and the next safe action.
- **A prior job's success is not your run's success.** Report what *your* fresh run actually did. If your submission failed (image wouldn't pull, deps missing, etc.) but an earlier job once succeeded, that earlier success shows the work *can* run — it is not proof you reproduced it. Never present a historical job's outcome as your completion; say plainly that your fresh run is still blocked.
- **Stale-config acknowledgement**: if a remembered config turned out wrong (image gone, env broke, proxy dead), say so in the report so it gets corrected — don't silently work around it.

## Do not

- Don't expand a quick, single-step request into the full lifecycle — do only what was asked, then stop (see *Scope to the request*).
- Don't ask "shall I proceed?" when nothing is unresolved — only genuine blockers go to the user.
- Don't read logs unbounded — use the `tailLines` cap (default 200); pull a full log artifact only when a bounded tail isn't enough.
- Don't `delete` a job unless the user explicitly asks for it.
- Don't put a credential in a command, log, or memory.
