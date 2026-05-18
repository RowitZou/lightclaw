export type BackgroundTaskResultOutcome =
  | 'success'
  | 'failed'
  | 'permission-denied'
  | 'aborted'

// Main-receiver template: rendered when the bg-dispatch result returns to
// the orchestrator (main). The "you, the manager" framing fits — main is
// user-facing and holds the Notify card capability that worker roles do
// not have.
export const BACKGROUND_TASK_RESULT_BLOCK_MAIN_TEMPLATE = `<background-task-result label="{label}" outcome="{success|failed|permission-denied|aborted}" dispatchId="{id}">
{result text from the dispatched run}
</background-task-result>

A background dispatch you previously scheduled has finished. The block above is its result — outcome and full text. Treat this as a delegated worker handing in their work to you, the manager.

Your decision space is continuous, not binary. The ONE thing to ration is Notify — silent continue and plain reply are both acceptable defaults:

1. Continue silently. Integrate the result into your ongoing work without surfacing it. Pick this when the result has no bearing on what the user can see or cares about right now (e.g. you're still mid-task on something unrelated; the result is a routine check that landed as expected).

2. Adjust your current plan if the result changes the situation — you were about to ask the user something the result just answered, or you discover the BG task failed in a way that affects what you're doing now. This may or may not involve telling the user; combine with option 3 if it does.

3. Send a plain reply mentioning the result. This is a normal action, NOT an interruption. In a chat with regular bot activity, plain reply lives in the same flow as your other turn-by-turn output — user sees progress without being pinged. Use this freely when there's value in user seeing what happened: progress visibility ("the daily fetch finished, nothing unusual"), context for what you'll do next ("the research came back, I'll factor it into the answer"), transparency about delegated work, or just confirming a dispatched task ran. Plain reply is NOT a scarce resource.

4. Send a Notify card ONLY when the user genuinely cannot miss this (see Notify tool description for the bar). Notify is the scarce attention resource — overuse makes users tune out cards. Most background results do NOT warrant Notify.

Decision heuristic: ask "would the user be surprised / confused / unable to act if I never mention this?"
- "They wouldn't notice either way" → option 1 (silent).
- "Useful context but no action needed; they may glance or skim" → option 3 (plain reply). This is the common case.
- "They need to drop what they're doing and react" → option 4 (Notify).

For outcome=failed or permission-denied: read the failure detail. You may consider UpdateDispatch (extend allowed_tools, change prompt, change schedule) or CancelDispatch if it makes sense. Choose 1/3/4 above on the user-surfacing axis independently from the self-healing axis.

For outcome=aborted: the dispatch was cancelled (by /stop or chain abort) — usually option 1 unless the user explicitly asked about its status.`

// Worker-receiver template: rendered when the bg-dispatch result returns to
// a worker that spawned it (scheduler resolves spawner-aware delivery). The
// "manager / user-facing reply / Notify" framing of the main template does
// not apply — workers communicate to their requester via final-text, not
// directly to the user, and they do not have the Notify tool.
export const BACKGROUND_TASK_RESULT_BLOCK_WORKER_TEMPLATE = `<background-task-result label="{label}" outcome="{success|failed|permission-denied|aborted}" dispatchId="{id}">
{result text from the dispatched run}
</background-task-result>

A background dispatch you fired earlier in this turn has finished. The block above is its result — outcome and full text.

Your final-text summary is the only thing your requester sees from this turn, so the question is whether to fold this result into that summary or treat it as side context.

1. Continue silently. Absorb the result and don't mention the dispatch in your final summary. Pick this when the result has no bearing on what you're about to hand back (the dispatch was an exploratory check that confirmed what you expected).

2. Adjust the rest of your turn. If the result changes your plan — remaining steps, what to verify, scope to drop — incorporate it before continuing. This may or may not surface in your final summary; combine with option 3 if it should.

3. Mention the result in your final-text summary. Your requester does not see the block directly — only what you choose to surface. Use this when the dispatch outcome is part of what your requester needs to know to act on your work: a key piece of evidence, a failed check that affects your verdict, scope you couldn't cover.

Decision heuristic: ask "would my requester be misled or unable to act if I leave this out of my final summary?"
- "No, they would not notice or care" → option 1.
- "Yes, this changes what they should do" → option 3 (combine with 2 if your plan also shifts).

For outcome=failed or permission-denied: read the failure detail. You may consider UpdateDispatch (extend allowed_tools, change prompt, change schedule) or CancelDispatch to manage the failed dispatch. Choose 1/3 above on the requester-surfacing axis independently from this self-healing axis.

For outcome=aborted: the dispatch was cancelled — usually option 1 unless the failure is relevant to your final summary.`

export function formatBackgroundTaskResultBlock(input: {
  label: string
  outcome: BackgroundTaskResultOutcome
  dispatchId: string
  result: string
  receiverRole: string
}): string {
  const template = input.receiverRole === 'main'
    ? BACKGROUND_TASK_RESULT_BLOCK_MAIN_TEMPLATE
    : BACKGROUND_TASK_RESULT_BLOCK_WORKER_TEMPLATE
  return template
    .replace('label="{label}"', `label="${escapeAttribute(input.label)}"`)
    .replace('outcome="{success|failed|permission-denied|aborted}"', `outcome="${input.outcome}"`)
    .replace('dispatchId="{id}"', `dispatchId="${escapeAttribute(input.dispatchId)}"`)
    .replace('{result text from the dispatched run}', input.result.trim() || '(empty result)')
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}
