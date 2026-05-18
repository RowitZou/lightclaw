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
import { BACKGROUND_TASK_RESULT_BLOCK_TEMPLATE } from '../signal-bus/background-result-block.js'

test('Phase 4 tool descriptions and background-result block match snapshot hashes', () => {
  const actual = {
    Dispatch: hash(dispatchTool.description),
    ListDispatches: hash(listDispatchesTool.description),
    CancelDispatch: hash(cancelDispatchTool.description),
    UpdateDispatch: hash(updateDispatchTool.description),
    Notify: hash(notifyTool.description),
    BackgroundTaskResultBlock: hash(BACKGROUND_TASK_RESULT_BLOCK_TEMPLATE),
  }
  assert.deepEqual(actual, EXPECTED)
})

const EXPECTED = {
  Dispatch: '099e2c61e2551f9992a0f21adb488d23989d1c1450ea7746735b388a4df2cdcf',
  ListDispatches: 'da49c1dd13f59696253688581ff42eed5469adbf9cf6d82b18f6a8eb0e9bba58',
  CancelDispatch: 'cab41843f426e403d9fc0362c0cdb5b5a4093a78c68fa0ffbb19c77771d5df07',
  UpdateDispatch: 'a823f127ab8b773f1cf94217bdb80b5f75037e7ad83462881f6cf996b405fa3b',
  Notify: '4bc24f896080e4a15f85815ded7a92f56a1740645235785d29509788fe9ec4df',
  BackgroundTaskResultBlock: '5e7c00f274656c36eab17ab59b6dc61f7b945b5b86386ff659e2dbed9ae99a18',
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
