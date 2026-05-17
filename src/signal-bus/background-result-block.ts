export type BackgroundTaskResultOutcome =
  | 'success'
  | 'failed'
  | 'permission-denied'
  | 'aborted'

export const BACKGROUND_TASK_RESULT_BLOCK_TEMPLATE = `<background-task-result label="{label}" outcome="{success|failed|permission-denied|aborted}" dispatchId="{id}">
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

export function formatBackgroundTaskResultBlock(input: {
  label: string
  outcome: BackgroundTaskResultOutcome
  dispatchId: string
  result: string
}): string {
  return BACKGROUND_TASK_RESULT_BLOCK_TEMPLATE
    .replace('label="{label}"', `label="${escapeAttribute(input.label)}"`)
    .replace('outcome="{success|failed|permission-denied|aborted}"', `outcome="${input.outcome}"`)
    .replace('dispatchId="{id}"', `dispatchId="${escapeAttribute(input.dispatchId)}"`)
    .replace('{result text from the dispatched run}', input.result.trim() || '(empty result)')
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

