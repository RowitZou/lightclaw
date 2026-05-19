export type BackgroundTaskResultOutcome =
  | 'success'
  | 'failed'
  | 'permission-denied'
  | 'aborted'

// Main-receiver template: rendered when the bg-dispatch result returns to
// the orchestrator (main). The "you, the manager" framing fits — main is
// user-facing and holds the Notify card capability that worker roles do
// not have. The 2026-05-19 rewrite pushed the default toward an unattended
// agent posture: surface every result via plain reply, take autonomous
// follow-up when the path is clear, reserve Notify for cases where the
// user genuinely must intervene.
export const BACKGROUND_TASK_RESULT_BLOCK_MAIN_TEMPLATE = `<background-task-result label="{label}" outcome="{success|failed|permission-denied|aborted}" dispatchId="{id}">
{result text from the dispatched run}
</background-task-result>

A background dispatch you previously scheduled has finished. The block above is its result — outcome and full text. Treat this as a delegated worker handing in their work to you, the manager.

Default mode: handle the result without escalating. The user does not see the block above directly — only what you choose to send. You are an unattended agent, so:
- If the result clearly calls for a next step and the path forward is reasonably clear, take that step yourself (option 2) and tell the user via plain reply (option 1). Don't pause for permission.
- If the result is terminal — the dispatched work delivered what was asked, the recurring check came back clean, the result is informational with no obvious follow-up — just send a plain reply (option 1). Don't manufacture work to look busy.
- Reserve Notify (option 3) for the small set of cases where the user genuinely must intervene.

1. Send a plain reply mentioning the result, and (if option 2 also applies) what you decided to do about it. This always happens regardless of outcome — it is the user's primary visibility into delegated work. One or two sentences is usually right ("the daily fetch finished — nothing unusual"; "the research came back, I'm folding it into the answer now"; "the cleanup ran and removed 12 stale files"). Plain reply is NOT a scarce resource.

2. Take the next step autonomously WHEN the result calls for one — invoke the next skill, call the relevant tool, fire a new Dispatch, or update an existing one. Pick the best plan using your judgment and just execute it; do not pause to ask the user for permission to proceed when the path forward is clear. Skip this entirely when the dispatched work was self-contained and there is no obvious follow-up; option 1 alone is the right answer there.

3. Send a Notify card ONLY when you genuinely need the user. Three triggers, no others: (a) you cannot proceed on your own and need the user's decision or input to unblock; (b) there is major information the user must know now and a plain reply might be missed (security incident, data loss, hard deadline slip); (c) the situation requires user intervention — something only they can do. If the next step is obvious enough that you could plausibly take it yourself, take it (option 2) and surface what you did via option 1 instead. Notify is the scarce attention channel; overuse makes users tune out cards.

For outcome=failed or permission-denied: read the failure detail. If there is an autonomous recovery path — UpdateDispatch (extend allowed_tools, change prompt, change schedule), CancelDispatch, or a new Dispatch with a revised plan — take it. If recovery requires user input, plain-reply the failure (option 1); escalate to Notify (option 3) only when waiting silently would actually harm them.`

// Worker-receiver template: rendered when the bg-dispatch result returns to
// a worker that spawned it (scheduler resolves spawner-aware delivery). The
// "manager / user-facing reply / Notify" framing of the main template does
// not apply — workers communicate to their requester via final-text, not
// directly to the user, and they do not have the Notify tool. The
// 2026-05-19 rewrite mirrors main's unattended-agent posture inside the
// worker's narrower channel: take autonomous follow-up when the path is
// clear, surface the result in final-text when the requester needs it,
// keep silent absorption legitimate for genuinely irrelevant exploratory
// checks.
export const BACKGROUND_TASK_RESULT_BLOCK_WORKER_TEMPLATE = `<background-task-result label="{label}" outcome="{success|failed|permission-denied|aborted}" dispatchId="{id}">
{result text from the dispatched run}
</background-task-result>

A background dispatch you fired earlier in this turn has finished. The block above is its result — outcome and full text.

Default mode: handle the result without stalling. You are mid-turn and still owe your requester a final-text summary — that is the only thing they will see from this turn. You are operating autonomously, so:
- If the result calls for a next step within this turn, take that step yourself (option 2) and reflect what you did in your final-text summary (option 3). You cannot pause for a sign-off from your requester mid-turn — handle it.
- If the result is part of what your requester needs to know, fold it into your final-text summary (option 3). Don't manufacture additional work to look productive when the dispatch already delivered what you needed.
- If the result genuinely has no bearing on what you'll hand back, silent absorption (option 1) is fine. Don't pad the summary with irrelevant dispatch history.
- There is no Notify equivalent at the worker tier; your only escalation channel is what you write into your final-text summary.

1. Continue without surfacing the dispatch in your final-text. Absorb the result silently. Pick this only when the result genuinely has no bearing on what you're about to hand back — the dispatch was an exploratory check that confirmed what you already expected. When in doubt between 1 and 3, prefer 3; silent swallow is harder for the requester to recover from than a brief mention.

2. Take the next step autonomously WHEN the result calls for one — invoke the next skill, call the relevant tool, or fire another Dispatch as part of the remaining turn. Pick the best plan using your judgment and just execute it; the worker tier has no "ask requester" path mid-turn, so when the path forward is clear, take it. Skip this entirely when the dispatched work was self-contained — option 1 or option 3 alone covers it. Combine with option 3 so your final-text reflects what you did.

3. Surface the result in your final-text summary. Your requester does not see the block above directly — only what you choose to write. Use this whenever the dispatch outcome is part of what your requester needs to act on your work: evidence, scope you couldn't cover, a failed check that affects your verdict, or an action you took based on the result. One or two sentences in the summary is usually enough.

For outcome=failed or permission-denied: read the failure detail. If there is an autonomous recovery path — UpdateDispatch (extend allowed_tools, change prompt, change schedule), CancelDispatch, or a new Dispatch with a revised plan — take it as part of this turn. Surface the failure and what you did via option 3 so your requester can act on the full picture; failures should not be silently swallowed (option 1 is for results that change nothing, not for failures).`

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
