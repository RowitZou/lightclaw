import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  dispatchTool,
  messageDispatchTool,
  updateScheduleTool,
} from './dispatch.js'
import { notifyTool } from './notify.js'
import { showSlashCatalogTool } from './show-slash-catalog.js'
import { skillDeleteTool } from './skill-delete.js'
import { skillWriteTool } from './skill-write.js'
import { brainppClusterTool } from './cluster-job.js'
import {
  BACKGROUND_TASK_RESULT_BLOCK_MAIN_TEMPLATE,
  BACKGROUND_TASK_RESULT_BLOCK_WORKER_TEMPLATE,
} from '../signal-bus/background-result-block.js'

test('Phase 4 tool descriptions and background-result block match snapshot hashes', () => {
  const actual = {
    Dispatch: hash(dispatchTool.description),
    MessageDispatch: hash(messageDispatchTool.description),
    UpdateSchedule: hash(updateScheduleTool.description),
    Notify: hash(notifyTool.description),
    ShowSlashCatalog: hash(showSlashCatalogTool.description),
    SkillDelete: hash(skillDeleteTool.description),
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
  Dispatch: '50d2c4cbd286421dfcac5390e222340d14f7271eac265886676c27eb259883fc',
  // Collab phase3 PR14: MessageDispatch now routes by TaskRun runId (`to`)
  // and supports ask/resume semantics instead of dispatch-entry-only nudges.
  MessageDispatch: 'edc88ca1ec083786544b28ddb879559f9feb43df534ed14e892d18243b2bfdd0',
  // Collab PR17: UpdateDispatch renamed to UpdateSchedule and limited to
  // queued one-shots / future recurring fires.
  UpdateSchedule: '13dba5ecc2ec4791452758971c34cca85a84c6d524f1fbc1b2dedc7350487e9c',
  Notify: '4bc24f896080e4a15f85815ded7a92f56a1740645235785d29509788fe9ec4df',
  // Phase 18 PR6: main-only tool for discovering channel slash commands
  // the user can run when setup must happen outside agent tools.
  ShowSlashCatalog: '46d6a98076f769638533981dfbc1476a5a3e0b89ed439543badcb5939e84ee5f',
  SkillDelete: 'f8f9da730224aabfd40390c009ce3fefdf8f014bacea508ccdc425e0687b58a6',
  // Phase 19 PR2: SkillWrite documents supporting `files` under scripts/
  // and references/, plus overwrite as whole-skill replacement.
  SkillWrite: 'd5ebf7d6cf38704524bf34e4bc3dfcb255faade7843370a0b56470644414c7bb',
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
  BackgroundTaskResultBlockMain: '772dab9338c3ca629d1b14243f4c54675857b4371327fd14162421e881be32eb',
  // Worker template rewritten in the same pass to mirror main's
  // unattended-agent posture inside the worker's narrower channel
  // (final-text only, no Notify equivalent). 2026-05-20: opening sentence
  // widened the same way as the main template for orphan-result accuracy.
  BackgroundTaskResultBlockWorker: 'ad6803aae7a3a450444d5e01c25bdd065cfe79276c460ae7ef678c1a11dbbdd2',
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
