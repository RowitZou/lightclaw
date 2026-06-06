import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  cancelDispatchTool,
  dispatchTool,
  listDispatchesTool,
  updateDispatchTool,
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
    ListDispatches: hash(listDispatchesTool.description),
    CancelDispatch: hash(cancelDispatchTool.description),
    UpdateDispatch: hash(updateDispatchTool.description),
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
  // Dispatch description rewritten Phase 11 PR1 (2026-05-20): removed the
  // old context-inheritance section and parenthetical. Dispatch workers are
  // now always fresh-context workers. 2026-05-20: appended the "## Reporting
  // in-flight background dispatches" section so a dispatcher names any bg
  // dispatch still running in what it hands back — its result surfaces up
  // the chain after the dispatcher is gone, and an unannounced one reaches
  // the receiver with no record of why it exists. 2026-05-28 (dispatch-nudge):
  // reframed the schedule='now' mode-choice block (dropped "background is
  // rarer", added the long-running → background trigger + blocking-freeze
  // cost) and turned the "## Parallelism" caveat into a positive fan-out
  // pattern with a worked example.
  Dispatch: 'eec5b10c5ba4ffc272ca07149e50e354dbe03d7aefcb023a1d238ac12e0f17a5',
  // ListDispatches description updated Phase 12 PR2 (2026-05-20): documents
  // the new `scope` param (default lists only the caller's own dispatches;
  // `scope: 'all'` is main-orchestrator-only) and the `caller` output field.
  ListDispatches: '246a6e8ae95d21feef8d8ed908bd58aa469c0ac6e71a1f8b4535699da0baba73',
  CancelDispatch: 'cab41843f426e403d9fc0362c0cdb5b5a4093a78c68fa0ffbb19c77771d5df07',
  UpdateDispatch: '0257356cfbea31368f649f245cf39b0df21b015c3abfa78fc82afdc7ef3cbc54',
  Notify: '4bc24f896080e4a15f85815ded7a92f56a1740645235785d29509788fe9ec4df',
  // Phase 18 PR6: main-only tool for discovering channel slash commands
  // the user can run when setup must happen outside agent tools.
  ShowSlashCatalog: '46d6a98076f769638533981dfbc1476a5a3e0b89ed439543badcb5939e84ee5f',
  SkillDelete: 'f8f9da730224aabfd40390c009ce3fefdf8f014bacea508ccdc425e0687b58a6',
  // Phase 19 PR2: SkillWrite documents supporting `files` under scripts/
  // and references/, plus overwrite as whole-skill replacement.
  SkillWrite: 'd5ebf7d6cf38704524bf34e4bc3dfcb255faade7843370a0b56470644414c7bb',
  // Phase 41 PR2: cluster inspection + job submit/manage tool. The description
  // stays mechanism-only and does not name the underlying cluster CLIs.
  BrainppCluster: 'f6c62cf852b89b3542d4310a1390cd6d72fc36c4ce933fe172cd041abf5ba23f',
  // Main template rewritten 2026-05-19 to push the default toward an
  // unattended-agent posture: surface every result via plain reply, take
  // autonomous follow-up when the path is clear, reserve Notify for the
  // narrow cases where the user genuinely must intervene. Outcome=aborted
  // section dropped — /stop and CancelDispatch do not abort in-flight bg
  // fires (chain-abort-propagation skips bg-* sessions), so the path was
  // unreachable through user actions. 2026-05-20: opening sentence widened
  // so it reads correctly when the receiver is not the role that scheduled
  // the dispatch (orphan result fell back up the chain to main).
  BackgroundTaskResultBlockMain: 'e4ba103c86e31fb009680b50f9e6cdaff3f1461796b02334bdd943f6bca7b9fb',
  // Worker template rewritten in the same pass to mirror main's
  // unattended-agent posture inside the worker's narrower channel
  // (final-text only, no Notify equivalent). 2026-05-20: opening sentence
  // widened the same way as the main template for orphan-result accuracy.
  BackgroundTaskResultBlockWorker: 'abe6ad1cbed8f017db1901549d01c46347d68408cc5adafecdb868b96840c0a1',
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
