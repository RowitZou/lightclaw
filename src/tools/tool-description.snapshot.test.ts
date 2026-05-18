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
  Dispatch: '64721c4389deb56f65eea362f99cce3b37756b911ff6a40c374b2b58a735c523',
  ListDispatches: 'da49c1dd13f59696253688581ff42eed5469adbf9cf6d82b18f6a8eb0e9bba58',
  CancelDispatch: 'cab41843f426e403d9fc0362c0cdb5b5a4093a78c68fa0ffbb19c77771d5df07',
  UpdateDispatch: 'a823f127ab8b773f1cf94217bdb80b5f75037e7ad83462881f6cf996b405fa3b',
  Notify: '4bc24f896080e4a15f85815ded7a92f56a1740645235785d29509788fe9ec4df',
  // Main template is byte-identical to the pre-split BACKGROUND_TASK_RESULT_BLOCK_TEMPLATE.
  BackgroundTaskResultBlockMain: '5e7c00f274656c36eab17ab59b6dc61f7b945b5b86386ff659e2dbed9ae99a18',
  // Worker template (new — see PR2 design write-up).
  BackgroundTaskResultBlockWorker: '3f76e5d79fef3b9978c5111b0885fed2ffef8517711ec828aec4b6187d7cfef3',
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
