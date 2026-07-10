import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { mkdirSync, writeFileSync } from 'node:fs'

import {
  appendMessage,
  appendMessages,
  clearPendingTurn,
  loadMeta,
  loadMetaFromDir,
  loadTranscript,
  markPendingTurn,
  mutateMeta,
  touchMeta,
  updateMetaLastExtractedAt,
  updateMetaSessionMemoryAt,
} from './storage.js'
import { createUserMessage } from '../messages.js'
import { setLightclawHomeOverride } from '../paths.js'
import {
  createEmptySessionContext,
  runWithSessionContext,
} from '../session-context.js'

// §十: sessions derive from <home>; isolate via the home override (the old
// LIGHTCLAW_SESSIONS_DIR per-subdir env was removed).
let tmpHome: string

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-storage-test-'))
  setLightclawHomeOverride(tmpHome)
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
})

describe('appendMessages (atomic batch transcript append)', () => {
  it('writes a batch as JSONL that loadTranscript reads back in order', async () => {
    const sid = 'feishu:dm:batch'
    const batch = [
      createUserMessage('m0', null),
      createUserMessage('m1', null),
      createUserMessage('m2', null),
    ]
    await appendMessages(sid, batch)
    assert.deepEqual(await loadTranscript(sid), batch)
  })

  it('is a no-op on an empty batch — creates no session directory', async () => {
    const sid = 'feishu:dm:empty'
    await appendMessages(sid, [])
    assert.equal(existsSync(path.join(tmpHome, 'sessions', sid)), false)
    assert.deepEqual(await loadTranscript(sid), [])
  })

  it('interleaves with appendMessage, preserving global order', async () => {
    const sid = 'feishu:dm:mixed'
    const a = createUserMessage('a', null)
    const b = createUserMessage('b', null)
    const c = createUserMessage('c', null)
    const d = createUserMessage('d', null)
    await appendMessage(sid, a)
    await appendMessages(sid, [b, c])
    await appendMessage(sid, d)
    assert.deepEqual(await loadTranscript(sid), [a, b, c, d])
  })

  it('a batch append produces the same transcript as message-by-message appends', async () => {
    const batch = [
      createUserMessage('x', null),
      createUserMessage('y', null),
      createUserMessage('z', null),
    ]
    await appendMessages('feishu:dm:one-write', batch)
    for (const message of batch) {
      await appendMessage('feishu:dm:n-writes', message)
    }
    assert.deepEqual(
      await loadTranscript('feishu:dm:one-write'),
      await loadTranscript('feishu:dm:n-writes'),
    )
  })
})

describe('getSessionDir ambient-context mismatch guard', () => {
  // Production shape (2026-07-03): AsyncLocalStorage leaks the startup
  // bootstrap SessionContext into channel socket handlers, so a bare
  // loadTranscript(sessionId) there resolved another user's session into the
  // bootstrap identity's sessions dir and read empty — every non-bootstrap
  // user's turn reached the model with zero history while writes (made inside
  // the correctly-hydrated per-turn scope) kept accumulating on disk.
  it('reads a session living under a user dir even when the ambient context points at another identity', async () => {
    const sid = 'feishu:dm:oc_alice_chat'
    const aliceSessions = path.join(tmpHome, 'users', 'alice', 'sessions')
    const bootstrapSessions = path.join(tmpHome, 'users', 'admin', 'sessions')
    const batch = [createUserMessage('hello', null)]
    await runWithSessionContext(
      createEmptySessionContext({ sessionsDir: aliceSessions }),
      () => appendMessages(sid, batch),
    )
    const loaded = await runWithSessionContext(
      createEmptySessionContext({ sessionsDir: bootstrapSessions }),
      () => loadTranscript(sid),
    )
    assert.deepEqual(loaded, batch)
  })

  it('still creates a genuinely new session under the ambient context dir', async () => {
    const sid = 'feishu:dm:brand_new'
    const bobSessions = path.join(tmpHome, 'users', 'bob', 'sessions')
    await runWithSessionContext(
      createEmptySessionContext({ sessionsDir: bobSessions }),
      () => appendMessages(sid, [createUserMessage('hi', null)]),
    )
    assert.ok(existsSync(path.join(bobSessions, sid, 'transcript.jsonl')))
  })
})

describe('meta.json write serialization (per-session mutateMeta lock)', () => {
  // Production shape (2026-07-01, family): the runner's end-of-turn
  // clearPendingTurn raced a delayed memory-extraction meta write. Both were
  // load-modify-write with no lock; the extraction side loaded meta before
  // the clear landed and wrote after it, re-persisting the cleared
  // pendingTurn marker — arming a fake crash-resume for a turn that had
  // completed normally. Same lost-update shape threatens todos and both
  // watermarks. All meta writers now serialize per sessionId via mutateMeta.
  const inCtx = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithSessionContext(
      createEmptySessionContext({
        sessionsDir: path.join(tmpHome, 'sessions'),
      }),
      fn,
    )

  it('a concurrent watermark write cannot resurrect a cleared pendingTurn marker', async () => {
    await inCtx(async () => {
      for (let i = 0; i < 25; i++) {
        const sid = `feishu:dm:race-${i}`
        await markPendingTurn(sid)
        // Alternate launch order across iterations so either interleaving
        // direction of the old unlocked write pair would have been caught.
        const clear = (): Promise<unknown> => clearPendingTurn(sid)
        const extract = (): Promise<void> =>
          updateMetaLastExtractedAt(sid, 1000 + i)
        await Promise.all(i % 2 === 0 ? [clear(), extract()] : [extract(), clear()])
        const meta = await loadMeta(sid)
        assert.ok(meta, `iteration ${i}: meta missing`)
        assert.equal(
          meta.pendingTurn,
          undefined,
          `iteration ${i}: pendingTurn resurrected by a concurrent meta write`,
        )
        assert.equal(
          meta.lastExtractedAt,
          1000 + i,
          `iteration ${i}: lastExtractedAt lost to a concurrent meta write`,
        )
      }
    })
  })

  it('concurrent mutateMeta calls never lose updates', async () => {
    await inCtx(async () => {
      const sid = 'feishu:dm:counter'
      await touchMeta(sid, 0)
      await Promise.all(
        Array.from({ length: 50 }, () =>
          mutateMeta(sid, current =>
            current === null
              ? null
              : { ...current, messageCount: current.messageCount + 1 },
          ),
        ),
      )
      const meta = await loadMeta(sid)
      assert.equal(meta?.messageCount, 50)
    })
  })

  it('loadMeta degrades a corrupt meta.json to null instead of throwing', async () => {
    await inCtx(async () => {
      const sid = 'feishu:dm:corrupt'
      const sessionDir = path.join(tmpHome, 'sessions', sid)
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(path.join(sessionDir, 'meta.json'), '{"torn', 'utf8')
      assert.equal(await loadMeta(sid), null)
      // The next full write recovers the file.
      await touchMeta(sid, 3)
      assert.equal((await loadMeta(sid))?.messageCount, 3)
    })
  })
})

describe('meta access outside the per-turn context (2026-07-07/10 prod pendingTurn residue)', () => {
  // Production shape: markPendingTurn runs INSIDE the per-turn
  // runWithSessionContext scope; the runner's clearing finally runs OUTSIDE
  // it. Under a leaked or absent ambient context the old loadMeta read a
  // phantom "no meta" from the wrong sessions dir, clearPendingTurn silently
  // no-op'd, and the completed turn's crash-resume marker stayed armed —
  // a daemon restart within RESUME_MAX_AGE would fake-resume the turn.
  const userScoped = (user: string) => path.join(tmpHome, 'users', user, 'sessions')

  const markUnder = async (sessionsDir: string, sid: string): Promise<void> => {
    await runWithSessionContext(
      createEmptySessionContext({ sessionsDir }),
      async () => {
        await touchMeta(sid, 5)
        await markPendingTurn(sid)
      },
    )
  }

  it('clearPendingTurn finds a user-dir session even with no ambient context at all', async () => {
    const sid = 'feishu:dm:oc_residue_no_ctx'
    const carol = userScoped('carol')
    await markUnder(carol, sid)
    // The runner finally resumed on a bare async chain — no context.
    const outcome = await clearPendingTurn(sid)
    assert.equal(outcome, 'cleared')
    assert.equal((await loadMetaFromDir(carol, sid))?.pendingTurn, undefined)
  })

  it('clearPendingTurn with an explicit sessionsDir clears under a foreign ambient context', async () => {
    const sid = 'feishu:dm:oc_residue_foreign_ctx'
    const dave = userScoped('dave')
    const bootstrap = userScoped('admin')
    await markUnder(dave, sid)
    const outcome = await runWithSessionContext(
      createEmptySessionContext({ sessionsDir: bootstrap }),
      () => clearPendingTurn(sid, { sessionsDir: dave }),
    )
    assert.equal(outcome, 'cleared')
    assert.equal((await loadMetaFromDir(dave, sid))?.pendingTurn, undefined)
    // Nothing materialized under the foreign identity's dir.
    assert.equal(existsSync(path.join(bootstrap, sid)), false)
  })

  it('clearPendingTurn reports no-marker instead of silently no-opping', async () => {
    const sid = 'feishu:dm:oc_no_marker'
    const erin = userScoped('erin')
    await runWithSessionContext(
      createEmptySessionContext({ sessionsDir: erin }),
      () => touchMeta(sid, 1),
    )
    assert.equal(await clearPendingTurn(sid, { sessionsDir: erin }), 'no-marker')
  })

  it('a meta writer under a foreign ambient context updates the real meta instead of default-rebuilding it', async () => {
    // Same unguarded-read class, worse consequence: a wrong-ctx mutateMeta
    // writer sees current=null, rebuilds meta from defaults (messageCount 0,
    // todos dropped), and saveMeta's guarded dir resolution then lands that
    // hollow rebuild ON TOP of the real meta.
    const sid = 'feishu:dm:oc_clobber'
    const frank = userScoped('frank')
    await runWithSessionContext(
      createEmptySessionContext({ sessionsDir: frank }),
      () => touchMeta(sid, 7),
    )
    await runWithSessionContext(
      createEmptySessionContext({ sessionsDir: userScoped('admin') }),
      () => updateMetaSessionMemoryAt(sid, 12345),
    )
    const meta = await loadMetaFromDir(frank, sid)
    assert.equal(meta?.messageCount, 7)
    assert.equal(meta?.sessionMemoryUpdatedAt, 12345)
  })
})
