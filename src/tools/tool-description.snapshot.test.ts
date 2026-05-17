import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { agentTool } from './agent.js'
import {
  backgroundTaskTool,
  cancelBackgroundTaskTool,
  listBackgroundTasksTool,
  updateBackgroundTaskTool,
} from './background-task.js'
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
    AgentTool: hash(agentTool.description),
    BackgroundTask: hash(backgroundTaskTool.description),
    ListBackgroundTasks: hash(listBackgroundTasksTool.description),
    CancelBackgroundTask: hash(cancelBackgroundTaskTool.description),
    UpdateBackgroundTask: hash(updateBackgroundTaskTool.description),
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
  AgentTool: '64b7051bcfdecc7c74e9768f1d8c8c5babcc4fe0c52b32d8e92509f8baa00fdf',
  BackgroundTask: 'acee40d7058663ef05dd710645bb5660af2c579e0d8890aa523dc04450e382b7',
  ListBackgroundTasks: 'f804d5264e2f9673e1ea1b1813bf30ba13c071fe006e550eb722b6b3c665bbe6',
  CancelBackgroundTask: 'fedc336c6b7b755df1b7d397836425b779bac30ce3a24834ee83cc8178e791e2',
  UpdateBackgroundTask: 'c51dc968e1a89d894a3b272485455c4826eebf48c4819aac21feecf19c80e2b5',
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
