import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

import { PendingQuestionsStore, type PendingQuestionRecord } from './pending-questions-store.js'

let tmpRoot: string
let store: PendingQuestionsStore

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'lightclaw-pending-questions-'))
  store = new PendingQuestionsStore(tmpRoot)
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

test('PendingQuestionsStore writes and reads pending records', async () => {
  await store.writePending(record('ask_1'))
  const all = await store.readAllPending()
  assert.equal(all.length, 1)
  assert.equal(all[0]!.id, 'ask_1')
})

test('PendingQuestionsStore claimPending is single-winner', async () => {
  await store.writePending(record('ask_2'))
  const results = await Promise.all([
    store.claimPending('ask_2', 'user'),
    store.claimPending('ask_2', 'timeout'),
  ])
  assert.equal(results.filter(Boolean).length, 1)
  assert.equal(await store.claimPending('ask_2', 'cancel'), null)
})

test('PendingQuestionsStore moves corrupt records aside', async () => {
  writeFileSync(path.join(tmpRoot, 'bad.json'), '{not-json')
  const all = await store.readAllPending()
  assert.deepEqual(all, [])
  assert.equal((await store.claimPending('bad', 'cancel')), null)
})

function record(id: string): PendingQuestionRecord {
  return {
    id,
    schemaVersion: 1,
    sessionId: 'feishu:dm:oc_chat',
    turnId: 'toolu_1',
    questions: [{
      header: 'Name',
      question: 'Pick a name',
      options: [{ label: 'A' }, { label: 'B' }],
      defaultOptionIndex: 0,
    }],
    deadline: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
    chatId: 'oc_chat',
    cardMessageId: 'om_card',
  }
}
