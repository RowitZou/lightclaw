import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { recallRootIndex } from './recall-index.js'

afterEach(() => recallRootIndex.clear())

describe('recallRootIndex', () => {
  it('maps an opener messageId to the root it started', () => {
    recallRootIndex.register('om_1', 'alice', 'feishu:dm:oc_a', 'tr_root_1')
    const hit = recallRootIndex.lookup('om_1')
    assert.ok(hit)
    assert.equal(hit.owner, 'alice')
    assert.equal(hit.callerSessionId, 'feishu:dm:oc_a')
    assert.deepEqual([...hit.rootRunIds], ['tr_root_1'])
    assert.equal(recallRootIndex.lookup('unknown'), undefined)
  })

  it('accumulates multiple roots opened by the same message', () => {
    recallRootIndex.register('om_1', 'alice', 'feishu:dm:oc_a', 'tr_root_1')
    recallRootIndex.register('om_1', 'alice', 'feishu:dm:oc_a', 'tr_root_2')
    assert.deepEqual([...recallRootIndex.lookup('om_1')!.rootRunIds].sort(), [
      'tr_root_1',
      'tr_root_2',
    ])
  })

  it('ignores an empty messageId', () => {
    recallRootIndex.register('', 'alice', 'feishu:dm:oc_a', 'tr_root_1')
    assert.equal(recallRootIndex.lookup(''), undefined)
  })
})
