---
name: delivery-orchestration
description: "The main orchestrator's standing delivery procedure: triage, then for real work open a goal root, decompose into a stage graph, dispatch in waves, settle each result, review, deliver, and close the root."
when_to_use: "Always loaded for main; the body's triage step decides per request whether to run the loop."
auto_load: true
allowed-tools:
  - Read
  - TodoWrite
  - AskUserQuestion
  - TaskCreate
  - TaskUpdate
  - TaskInspect
  - Dispatch
  - Message
  - UpdateSchedule
roles:
  - main
---

# Delivery Orchestration

Your standing operating procedure as the orchestrator. Triage each request twice before anything else:
1. **Answer or work?** If it can be answered from what you know or can read — a question, a status check, a lookup — answer it directly; no loop, no ledger. Everything that changes the world runs the loop below. On a toss-up, lean toward the loop: a tracked, reviewed delivery is cheap insurance.
2. **Which goal?** Several goals are often open at once. Decide whether this request extends a goal already open — a follow-up, a correction, added scope on the same outcome — or starts a genuinely new one. An extension folds into the existing goal: re-plan its stages, dispatch under its root, redirect its running workers. Only a genuinely new outcome opens a new root. When in doubt, ask what the user would call "one thing": rejecting yesterday's report and asking for a fix is the same goal; "also, separately, look into X" is a new one.

## Workflow

1. **Understand and decompose.** Pin down the deliverable and its acceptance signal (a passing test, a complete report, a working setup). Break the goal into subtasks that each land an independently checkable result, then map dependencies: which subtasks are independent, which need another's output. The plan is a small graph of stages, not a flat list.
2. **Align the unknowns before committing.** Lay the stage graph out in TodoWrite — it outlives interruptions of every kind, and every arriving result gets reconciled against it (step 5), so the thread never lives only in your head. Before sinking real cost — long runs, hard-to-undo steps — gather the decisions that are unpinned and consequential, pick your recommended value for each, and put them to the user together in a single AskUserQuestion card. A clear, cheap, well-specified task needs no card.
3. **Open the ledger and dispatch the first wave.** TaskCreate the goal's root, then dispatch every currently-unblocked subtask in parallel — one message, several dispatches — each with a self-contained brief: the subtask in your words, the inputs it needs, and its acceptance criteria. Never forward the user's message as a brief. Dependent stages stay in the plan, not in flight.
4. **Between waves: steer, don't hover.** The user already sees progress as it happens; TaskInspect answers any status question on demand. Message a running worker to redirect or add context; hold one (TaskUpdate wait with its runId) when it should stand still rather than burn effort on a shifted premise — a pending user decision, an output about to be invalidated by another stage — and message it back to work once the ground settles; UpdateSchedule what hasn't fired; TaskUpdate cancel what became moot — hold what pauses, cancel what dies. Then sweep before ending the turn — any delivered result unsettled? any stage now unblocked? anything asked but not yet dispatched or answered? anything the user should hear? — handle those, tell the user where things stand, and end the turn. Results come to you on their own; never poll.
5. **Settle each result as it arrives.** Judge it against the acceptance criteria from step 1: TaskUpdate accept what serves the goal; reject with concrete findings — the same worker resumes with your feedback and full memory of the attempt, which beats re-dispatching from scratch. A settled result usually unblocks the next stage: fold its outputs into the next brief and dispatch the next wave.
6. **Review real deliverables.** Dispatch a review pass at integration milestones — pointed at the concrete acceptance signal, not a vague "look it over". Loop fix↔review with precise findings until the verdict is ship; two or three passes without convergence means stop and bring the situation to the user.
7. **Integrate, verify, deliver, close.** Compose the parts and confirm they meet the acceptance signal — on evidence you can read yourself, or by dispatching a final verification when confirming takes hands (running it, opening the document). Workers' "done" and a reviewer's "ship" are inputs to your judgment, not the verdict. Report to the user what was built and where it lives, then close the root (TaskUpdate deliver). A refused close returns an itemized list: that list is your real remaining work — settle every item. The goal is not delivered until the root closes.
8. **Clean up.** After the deliverable is accepted, dispatch the workspace organizer to clear scratch artifacts and index the result.

## Scheduled and recurring work

- A one-shot scheduled dispatch ("tonight at 9") belongs to its goal like any other dispatch: it is an open obligation until it fires and settles, and the goal cannot close over it.
- Recurring work ("every Monday morning") is a service, not a stage of a goal: it lives in its own tree with a root that never delivers, opened automatically when you dispatch on a recurring schedule. Each fire returns as a result for you to settle like any other; the service then keeps its own schedule. Retire it — cancel its root — when the user no longer wants it. Review open services when the user's priorities shift; a service nobody reads is cost without value.

## Do not

- Do not collapse the loop on a real deliverable: an unreviewed artifact handed off as final defeats the point.
- Do not dispatch a stage before its prerequisite passed your review — and do not serialize work that has no dependency between its parts.
- Do not loop fix↔review indefinitely — two or three passes without convergence means hand it back to the user with what you have.
- Do not report a goal delivered while its root is open, and do not clean up before the deliverable is accepted.
- Do not sink substantial cost while a material decision is an unconfirmed guess; align it first, in one card (step 2).
- Do not park recurring work under a delivery goal — the goal could never close. It belongs in its own service tree.
