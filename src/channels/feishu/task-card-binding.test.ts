import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { setLightclawHomeOverride } from '../../paths.js'
import { taskRunDirPath } from '../../taskrun/store.js'
import { readTaskCardBinding, writeTaskCardBinding } from './task-card-binding.js'

function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(path.join(tmpdir(), 'lightclaw-taskcard-'))
  setLightclawHomeOverride(home)
  return fn().finally(() => {
    setLightclawHomeOverride(undefined)
    rmSync(home, { recursive: true, force: true })
  })
}

void describe('task-card binding sidecar', () => {
  void it('round-trips a binding beside the taskrun ledger', async () => {
    await withTempHome(async () => {
      const ok = await writeTaskCardBinding('alice', 'run-1', {
        chatId: 'oc_1',
        threadId: 'omt_1',
        replyAnchorMessageId: 'om_anchor',
        messageId: 'om_card',
      })
      assert.equal(ok, true)
      const read = await readTaskCardBinding('alice', 'run-1')
      assert.deepEqual(read, {
        chatId: 'oc_1',
        threadId: 'omt_1',
        replyAnchorMessageId: 'om_anchor',
        messageId: 'om_card',
      })
    })
  })

  void it('returns null for missing, corrupt, or incomplete sidecars', async () => {
    await withTempHome(async () => {
      assert.equal(await readTaskCardBinding('alice', 'run-none'), null)

      const dir = taskRunDirPath('alice', 'run-bad')
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, 'card.json'), '{not json', 'utf8')
      assert.equal(await readTaskCardBinding('alice', 'run-bad'), null)

      writeFileSync(
        path.join(dir, 'card.json'),
        JSON.stringify({ chatId: 'oc_1' }),
        'utf8',
      )
      assert.equal(await readTaskCardBinding('alice', 'run-bad'), null)
    })
  })

  void it('persists finalizedAt for the terminal freeze', async () => {
    await withTempHome(async () => {
      await writeTaskCardBinding('alice', 'run-2', {
        chatId: 'oc_1',
        messageId: 'om_card',
        finalizedAt: 1234,
      })
      const read = await readTaskCardBinding('alice', 'run-2')
      assert.equal(read?.finalizedAt, 1234)
      assert.equal(read?.threadId, undefined)
    })
  })
})
