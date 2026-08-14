import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  dispatchTool,
  messageTool,
  updateScheduleTool,
} from './dispatch.js'
import { notifyTool } from './notify.js'
import { showSlashCatalogTool } from './show-slash-catalog.js'
import { skillDeleteTool } from './skill-delete.js'
import { skillEditTool } from './skill-edit.js'
import { skillWriteTool } from './skill-write.js'
import { brainppClusterTool } from './cluster-job.js'
import {
  BACKGROUND_TASK_RESULT_BLOCK_MAIN_TEMPLATE,
  BACKGROUND_TASK_RESULT_BLOCK_WORKER_TEMPLATE,
} from '../signal-bus/background-result-block.js'

test('Phase 4 tool descriptions and background-result block match snapshot hashes', () => {
  const actual = {
    Dispatch: hash(dispatchTool.description),
    Message: hash(messageTool.description),
    UpdateSchedule: hash(updateScheduleTool.description),
    Notify: hash(notifyTool.description),
    ShowSlashCatalog: hash(showSlashCatalogTool.description),
    SkillDelete: hash(skillDeleteTool.description),
    SkillEdit: hash(skillEditTool.description),
    SkillWrite: hash(skillWriteTool.description),
    BrainppCluster: hash(brainppClusterTool.description),
    BackgroundTaskResultBlockMain: hash(BACKGROUND_TASK_RESULT_BLOCK_MAIN_TEMPLATE),
    BackgroundTaskResultBlockWorker: hash(BACKGROUND_TASK_RESULT_BLOCK_WORKER_TEMPLATE),
  }
  assert.deepEqual(actual, EXPECTED)
})

const EXPECTED = {
  // Collab phase3 PR16 (2026-06-10): Dispatch is background-only; blocking
  // mode is retired in favor of background Dispatch plus TaskUpdate pause
  // child-join when the caller needs to resume on the result.
  // Dispatch-brief PR2.1 (2026-06-16): unfamiliar roles are routed through
  // ListRoleSkill before Dispatch so the caller learns what to settle first.
  // Brief-handles dose-calibration (2026-07-26): Writing-the-prompt gains an
  // unconditional handle rule — inputs the brief references that the caller
  // already holds a handle for (paths / URLs / tokens / run ids) are named
  // verbatim, never described; scoped to brief-referenced inputs so it does
  // not read as dump-every-handle.
  Dispatch: '909300814c6ba410c7512787caffa7340f6f3200fadb186080bf0db93b0b6ac8',
  // Uplink short-reply (2026-06-16): Message gained the no-`to` `reply_code`
  // mode (worker replies to a requester's message with the info it asked for),
  // the `to` paragraph now prefers TaskInspect for status and notes the
  // <worker-reply> that may come back, and the no-`to` ask path split into
  // `default` (decision) vs `reply_code` (reply) bullets.
  // Collab phase3 PR14: Message now routes by TaskRun runId (`to`)
  // and supports ask/resume semantics instead of dispatch-entry-only nudges.
  // ask-prompt cost-framing (2026-06-14): no-`to` ask description reframed
  // from "reserve it / routine calls are yours" to a cost-of-wrong-guess
  // judgment ("reach for it early when guessing wrong would be expensive").
  // Standing report code (2026-08-14): the no-`to` face is now three ways, not
  // two — report / ask / reply. Reporting a result the requester is waiting on
  // used to have no verb: `reply_code` only existed as an answer to a message
  // they sent, so a worker with a finding either dressed it as an ask (which
  // blocks its turn to the ask timeout) or concluded its run to be heard. The
  // ask bullet tightened to "cannot proceed without their decision" for the
  // same reason, and report carries the restraint the framework deliberately
  // does not enforce by rate limit ("would act on or are waiting for"; do not
  // restate progress).
  // report/deliver boundary (2026-08-14, same day): once a finished subtask's
  // result reaches the user on its own, reporting it right before delivering
  // it would say the same thing twice — so report narrowed from "a result they
  // would act on" to "a result that cannot wait until you finish".
  Message: '1850a191d138fbf95fbf2acdb5bfb2630d955f4ea1be2a2ee32f015ea24518f5',
  // Collab PR17: UpdateDispatch renamed to UpdateSchedule and limited to
  // queued one-shots / future recurring fires.
  UpdateSchedule: '800382aa25b34e022148eacf42ac953b92df76149e93a456c658110563499a33',
  Notify: '4bc24f896080e4a15f85815ded7a92f56a1740645235785d29509788fe9ec4df',
  // Phase 18 PR6: main-only tool for discovering channel slash commands
  // the user can run when setup must happen outside agent tools.
  ShowSlashCatalog: '46d6a98076f769638533981dfbc1476a5a3e0b89ed439543badcb5939e84ee5f',
  SkillDelete: 'f8f9da730224aabfd40390c009ce3fefdf8f014bacea508ccdc425e0687b58a6',
  SkillEdit: 'f282734cbc195799ec73ddf6c4da640cc147ba5f9670a0f605ca5640faf4387f',
  // Phase 19 PR2: SkillWrite documents supporting `files` under scripts/
  // and references/, plus overwrite as whole-skill replacement.
  // Dispatch-brief PR5: SkillWrite now lists optional dispatch_brief in
  // frontmatter so skillify-authored skills can carry manager-facing contracts.
  SkillWrite: '21c1aa4224b32599b208dab39731496a469b487c316b97b563c46c4cd431937a',
  // Phase 41 PR3: description stays mechanism-only, drops sandbox wording, and
  // points the model to load brainpp-batch-job for workflow/judgment.
  BrainppCluster: '0019d560d6c86acc7fbb803c0f44bc836f1d94d1063e8cd51b05c0a3d56981fa',
  // Main template rewritten 2026-05-19 to push the default toward an
  // unattended-agent posture: surface every result via plain reply, take
  // autonomous follow-up when the path is clear, reserve Notify for the
  // narrow cases where the user genuinely must intervene. Outcome=aborted
  // prose stays dropped: collab-phase2 PR9/PR10 abort paths suppress delivery
  // before this block is rendered, so the model-facing fallback is enough for
  // any legacy/internal aborted envelope. 2026-05-20: opening sentence widened
  // so it reads correctly when the receiver is not the role that scheduled
  // the dispatch (orphan result fell back up the chain to main).
  // 2026-06-13 final-text-delivery re-frame: after the routing fix made a
  // concluding wake's final block reach the user in full, the two lines that
  // said "your deliver summary is sent to the user — write it for them" were
  // factually wrong. Now: your final reply is the user-facing answer (write
  // the full result there); the deliver summary is just a short card label.
  // 2026-06-14 recap addition: the default-mode paragraph now tells the agent
  // to make its final reply a self-contained recap of the turn (deliverables,
  // links, decisions), not just its last step — the mid-turn notes are
  // breadcrumbs, the final reply is the account the user reads. Option 1 drops
  // "when you finish the root" so it no longer reads as root-close-only (the
  // routing fix also sends concluding/interjection finals to chat).
  // Subtask results reach chat (2026-08-14): the routing that folded main's
  // relay of a finished subtask onto the task card is gone, so the paragraph
  // that told main "the user follows the work on its task card" was now
  // factually wrong in the other direction — it would have kept main writing
  // bookkeeping ("accepted subtask 2") into a message the user actually reads.
  // Option 1 now asks for the result itself, and names the bookkeeping
  // anti-example outright.
  BackgroundTaskResultBlockMain: '977fa9683233d16592eaca050ded86fe051b62eaa7a44caa5e09e200c0b73f21',
  // Worker template rewritten in the same pass to mirror main's
  // unattended-agent posture inside the worker's narrower channel
  // (final-text only, no Notify equivalent). 2026-05-20: opening sentence
  // widened the same way as the main template for orphan-result accuracy.
  BackgroundTaskResultBlockWorker: '938c37f1fa403d2bf4797a9b6f70a0c00f082053bc53f12f1bb4d7f5a9d47107',
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
