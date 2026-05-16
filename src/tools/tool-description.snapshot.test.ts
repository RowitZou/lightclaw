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
  AgentTool: 'ea52ab4722477401f5761db01e582568821f27075cdb65f0298dd6648386995c',
  BackgroundTask: 'acee40d7058663ef05dd710645bb5660af2c579e0d8890aa523dc04450e382b7',
  ListBackgroundTasks: 'f804d5264e2f9673e1ea1b1813bf30ba13c071fe006e550eb722b6b3c665bbe6',
  CancelBackgroundTask: 'fedc336c6b7b755df1b7d397836425b779bac30ce3a24834ee83cc8178e791e2',
  UpdateBackgroundTask: 'c51dc968e1a89d894a3b272485455c4826eebf48c4819aac21feecf19c80e2b5',
  Dispatch: 'd5449f012bda19d51d4d6fba8bd1ae2fa3d1cdbe3d7656a2f9dbfd3adb2dcc54',
  ListDispatches: '442465ddaa35dd08c00ad063412dbc2383e19fde65f9f3d58286095c9da9210c',
  CancelDispatch: '58a940232cdd12fab82126a20ddc2329b4dfb03254cfff87052402edf12aa5d9',
  UpdateDispatch: '31a41fd131dcbbd41cb11f399ebed77a42bb9b357721f1bea8e33ded6a3c2a4f',
  Notify: 'f3baeefeedb248bebd7c235e69be52da6c2485d80373cdcc0498ffb51fac7dca',
  BackgroundTaskResultBlock: '8ce383297121ca94a8139e6b9998ab1341309da38845cb3d7ce31369971ea99b',
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
