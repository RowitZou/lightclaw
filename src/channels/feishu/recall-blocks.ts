/**
 * Model-facing text blocks for the soft recall paths. Isolated here so the two
 * prompt strings the recall handler injects are reviewable in one place,
 * separate from the runner's control flow.
 *
 * Both follow the phenomenology principle: state the observable fact (the user
 * recalled something) and what to do, without narrating framework structure.
 */

/**
 * Piece A — a genuine user interjection was recalled AFTER it had already been
 * drained into the model. It cannot be un-injected, so the next interjection
 * boundary carries this withdrawal note. The text is wrapped by
 * `buildInterjectionBlock` (`<user-interjection>…</user-interjection>`), so it
 * is phrased to read coherently inside that wrapper: a recall withdraws the
 * earlier follow-up, it does NOT cancel the task in progress.
 */
export function formatRecalledInterjectionNote(recalledText: string): string {
  const quoted = JSON.stringify(recalledText)
  return [
    '(System note — the user RECALLED an earlier message they had sent you. This is not a new request.)',
    `The withdrawn message was: ${quoted}`,
    'Treat it as retracted: if you have not acted on it yet, skip it; if you already did, keep any completed work but stop treating that withdrawn message as a standing instruction.',
    'This does NOT cancel the task you are currently working on — continue it.',
  ].join('\n')
}

/**
 * Piece B — the user recalled the message that started one or more root task
 * runs. Delivered to main via the wake path (interjection if live, synthetic
 * turn if idle). A recall is a soft signal; main decides whether it means
 * "stop the work" and acts via the ledger.
 */
export function formatRecalledRootBlock(
  roots: Array<{ runId: string; title: string }>,
): string {
  const lines = [
    '<recalled-task-kickoff>',
    'The user recalled the message that started the following task run(s):',
  ]
  for (const root of roots) {
    lines.push(`  - ${root.runId} ${JSON.stringify(root.title)}`)
  }
  lines.push(
    'A recall is a soft signal, not an automatic cancellation. Decide what they meant:',
    "  - If it reads as \"I don't want this work anymore\", cancel it via TaskUpdate {action:'cancel', runId:'<runId>'}.",
    '  - If the work is still wanted, already delivered value, or you are unsure, keep going (confirm with the user if helpful).',
    '</recalled-task-kickoff>',
  )
  return lines.join('\n')
}
