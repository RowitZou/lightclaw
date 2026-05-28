---
name: delivery-orchestration
description: "Drive a substantial delivery end-to-end as the orchestrator: decompose it, dispatch the implementation to the fitting workers, run a review pass, iterate on the findings until it ships, then deliver and have the workspace cleaned up."
when_to_use: "Use when the user hands you a substantial deliverable — implement a feature, produce an analysis / report, build something from scratch, set up or migrate a project — anything that warrants real implementation plus a quality bar before you hand it back. Example messages: '帮我实现 X 并交付', '做一份 X 的分析报告', '把这个项目搭起来', 'build and ship X'. Skip it for quick questions, single-step lookups, or a one-line edit you can just do — those do not need the full delegate-and-review loop."
allowed-tools:
  - Read
  - TodoWrite
roles:
  - main
---

# Delivery Orchestration

Take a substantial delivery from request to a reviewed, cleaned-up result by orchestrating workers — your value is decomposition, delegation, and integration, not personally writing every line.

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
