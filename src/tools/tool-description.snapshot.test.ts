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
    BackgroundTaskResultBlockMain: hash(BACKGROUND_TASK_RESULT_BLOCK_MAIN_TEMPLATE),
    BackgroundTaskResultBlockWorker: hash(BACKGROUND_TASK_RESULT_BLOCK_WORKER_TEMPLATE),
  }
  assert.deepEqual(actual, EXPECTED)
})

const EXPECTED = {
  // Dispatch description rewritten Phase 11 PR1 (2026-05-20): removed the
  // old context-inheritance section and parenthetical. Dispatch workers are
  // now always fresh-context workers.
  Dispatch: 'c9c489df68610a8de8dd8b53e546f25bf5aab9739c8d6006b5a3dccee5603934',
  ListDispatches: '88c6d590ebce67a09022cb6b142bbef0a82da23557b31832584a83dd7d71030a',
  CancelDispatch: 'cab41843f426e403d9fc0362c0cdb5b5a4093a78c68fa0ffbb19c77771d5df07',
  UpdateDispatch: '0257356cfbea31368f649f245cf39b0df21b015c3abfa78fc82afdc7ef3cbc54',
  Notify: '4bc24f896080e4a15f85815ded7a92f56a1740645235785d29509788fe9ec4df',
  // Main template rewritten 2026-05-19 to push the default toward an
  // unattended-agent posture: surface every result via plain reply, take
  // autonomous follow-up when the path is clear, reserve Notify for the
  // narrow cases where the user genuinely must intervene. Outcome=aborted
  // section dropped — /stop and CancelDispatch do not abort in-flight bg
  // fires (chain-abort-propagation skips bg-* sessions), so the path was
  // unreachable through user actions.
  BackgroundTaskResultBlockMain: '9ad1e2c62a3965dfe9af85e6e08fe636714b3ca596e5039584ead1d62f5d7033',
  // Worker template rewritten in the same pass to mirror main's
  // unattended-agent posture inside the worker's narrower channel
  // (final-text only, no Notify equivalent).
  BackgroundTaskResultBlockWorker: 'c5abd2cc7b0ba5418143caa683be5ef5fdf5f98da886cd7686ae6461d9c14676',
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
