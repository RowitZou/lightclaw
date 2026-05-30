---
name: delivery-orchestration
description: "The main orchestrator's standing delivery procedure: triage, then for substantial deliverables decompose → dispatch → review → iterate → deliver → clean up."
when_to_use: "Always loaded for main; the body's triage step decides per request whether to run the loop."
auto_load: true
allowed-tools:
  - Read
  - TodoWrite
roles:
  - main
---

# Delivery Orchestration

This is your standing operating procedure as the orchestrator. **Triage each request with your own judgment:** if it's self-contained work you can do and verify yourself in a few steps — a focused question, a lookup, a contained edit or fix — just handle it; you don't need the loop below. Run the loop when the work is a real deliverable that benefits from being split across specialists or checked before it reaches the user — a feature, an analysis / report, building or migrating something, anything multi-part or that shouldn't go out unreviewed. When it's a genuine toss-up, lean toward the loop: a review pass is cheap insurance, and skipping it on something that mattered is the expensive miss.

## Workflow

1. **Understand and decompose.** Pin down the deliverable and what "done" looks like — the acceptance signal (a passing test, a complete report, a working setup). Break it into subtasks small enough that each lands an independently checkable result; a subtask whose output you cannot verify on its own is too big — split it further.
2. **Plan.** Lay the phases out as a `TodoWrite` list so progress stays visible to you and the user across the loop.
3. **Dispatch implementation.** Route each subtask to the worker whose specialty fits it, with a self-contained prompt stating the subtask and its acceptance criteria. Independent subtasks can go out in parallel.
4. **Review against the acceptance signal.** As parts land, dispatch a review pass over them — for a multi-part deliverable, review at integration milestones rather than batching one giant review at the end, so failures stay small and localized. Point the review at the concrete acceptance signal from step 1, not a vague "look it over." Do not skip this on a real deliverable.
5. **Iterate.** If the review returns blockers, dispatch a fix with the precise findings, then re-review. Loop until the verdict is ship. If it is not converging after two or three passes, stop and hand the situation to the user instead of thrashing.
6. **Integrate, verify, deliver.** Compose the parts and check yourself that they fit together and meet the acceptance signal — a worker's "done" and a reviewer's "ship" are inputs to your judgment, not a substitute for it. Then report to the user: what was built, the verdict, and where it lives.
7. **Clean up.** Once the deliverable is accepted, dispatch the worker that organizes the workspace to clear scratch artifacts, dedupe, and index the result, so the next task starts from a clean tree.

## Do not

- Do not collapse the loop on a real deliverable: skipping the review step, or handing off an unreviewed artifact as final, defeats the point.
- Do not loop fix↔review indefinitely — two or three passes without convergence means hand it back to the user with what you have.
- Do not run the cleanup before the deliverable is accepted; scratch artifacts may still be needed during iteration.
