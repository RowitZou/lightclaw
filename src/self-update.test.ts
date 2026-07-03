import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import { t } from './i18n/index.js'
import { setLightclawHomeOverride } from './paths.js'
import { UPDATE_RESTART_EXIT_CODE } from './restart-coordinator.js'
import {
  beginUpdateSingleFlight,
  classifyGitState,
  endUpdateSingleFlight,
  readAndClearRestartSentinel,
  runUpdate,
  writeRestartSentinel,
  type RestartSentinel,
} from './self-update.js'

describe('classifyGitState', () => {
  const base = { headSha: 'aaaaaaaaaaaa', upstreamSha: 'bbbbbbbbbbbb' }

  test('a dirty tree refuses regardless of behind/ahead (a pull would clobber)', () => {
    // Even when there is a real update waiting, an uncommitted change blocks it.
    const state = classifyGitState({ ...base, dirty: true, behind: 5, ahead: 0 })
    assert.equal(state.kind, 'dirty')
  })

  test('behind 0 is up-to-date even with local-ahead commits', () => {
    const state = classifyGitState({ ...base, dirty: false, behind: 0, ahead: 3 })
    assert.deepEqual(state, { kind: 'up-to-date', sha: base.headSha })
  })

  test('behind > 0 with local-ahead commits is diverged (not a fast-forward)', () => {
    const state = classifyGitState({ ...base, dirty: false, behind: 4, ahead: 2 })
    assert.deepEqual(state, { kind: 'diverged', behind: 4, ahead: 2 })
  })

  test('clean and strictly behind is updatable', () => {
    const state = classifyGitState({ ...base, dirty: false, behind: 7, ahead: 0 })
    assert.deepEqual(state, {
      kind: 'updatable',
      fromSha: base.headSha,
      toSha: base.upstreamSha,
      behind: 7,
    })
  })
})

describe('restart sentinel', () => {
  let home: string

  before(() => {
    home = mkdtempSync(path.join(tmpdir(), 'lightclaw-update-'))
    setLightclawHomeOverride(home)
  })

  after(() => {
    rmSync(home, { recursive: true, force: true })
  })

  test('write → read returns the record, and it is single-use', () => {
    const sentinel: RestartSentinel = {
      requestedAt: '2026-06-30T00:00:00.000Z',
      fromVersion: '0.4.2',
      fromBuildId: 'oldoldoldold',
      toBuildId: 'newnewnewnew',
      byUser: 'admin',
    }
    writeRestartSentinel(sentinel)

    assert.deepEqual(readAndClearRestartSentinel(), sentinel)
    // Consumed: the boot that read it must not read it again on the next boot.
    assert.equal(readAndClearRestartSentinel(), null)
  })

  test('absent sentinel reads as null', () => {
    assert.equal(readAndClearRestartSentinel(), null)
  })
})

describe('update single-flight', () => {
  test('the lock admits exactly one holder until released', () => {
    assert.equal(beginUpdateSingleFlight(), true)
    try {
      assert.equal(beginUpdateSingleFlight(), false)
    } finally {
      endUpdateSingleFlight()
    }
    assert.equal(beginUpdateSingleFlight(), true)
    endUpdateSingleFlight()
  })

  test('runUpdate refuses while another update holds the lock (no git/build spawned)', async () => {
    // Concurrent `/admin version update` (two admins, or a double-send) racing
    // pnpm install/build on the same node_modules / dist.next can corrupt the
    // staged bundle; the second call must bail out BEFORE collectGitState —
    // this test would hang on a real `git fetch` if it did not.
    assert.equal(beginUpdateSingleFlight(), true)
    try {
      const result = await runUpdate()
      assert.equal(result.severity, 'warning')
      assert.equal(result.text, `${t('admin.update.inProgress')}\n`)
    } finally {
      endUpdateSingleFlight()
    }
  })
})

test('UPDATE_RESTART_EXIT_CODE is the EX_TEMPFAIL convention the supervisor matches', () => {
  // run.sh hard-codes 75; drift here would silently turn an
  // update restart into a "clean exit" (loop ends) or a crash-restart.
  assert.equal(UPDATE_RESTART_EXIT_CODE, 75)
})
