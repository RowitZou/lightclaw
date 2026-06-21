import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { appendFile } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { userSessionsRoot } from '../identity/paths.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import {
  appendMessages,
  getTranscriptPath,
  loadTranscript,
  saveMeta,
} from '../session/storage.js'
import { createUserMessage } from '../messages.js'
import type { Message, SessionMeta } from '../types.js'
import {
  channelFromSessionId,
  listOwnedSessionMetas,
  searchOwnedSessions,
} from './_session-helpers.js'

let tmpHome: string
let savedHome: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-convsearch-test-'))
  savedHome = process.env.LIGHTCLAW_HOME
  process.env.LIGHTCLAW_HOME = tmpHome
})

afterEach(() => {
  if (savedHome === undefined) {
    delete process.env.LIGHTCLAW_HOME
  } else {
    process.env.LIGHTCLAW_HOME = savedHome
  }
  rmSync(tmpHome, { recursive: true, force: true })
})

// Sessions now live under the per-user root (`users/<u>/sessions/...`), and
// storage helpers resolve their dir from the active SessionContext. Bind one
// for the owning user so writes / reads land under that user's sessions tree —
// which is exactly where the per-user enumerators (searchOwnedSessions /
// listOwnedSessionMetas) look.
async function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return runWithSessionContext(
    createSessionContext({
      cwd: '/tmp',
      model: 'test-model',
      sessionsDir: userSessionsRoot(userId),
      memoryDir: '',
      currentUserId: userId,
    }),
    fn,
  )
}

function saveMetaAs(userId: string, sessionId: string, meta: SessionMeta): Promise<void> {
  return asUser(userId, () => saveMeta(sessionId, meta))
}

function appendMessagesAs(
  userId: string,
  sessionId: string,
  messages: Message[],
): Promise<void> {
  return asUser(userId, () => appendMessages(sessionId, messages))
}

function makeMeta(sessionId: string, userId: string, lastActiveAt: number): SessionMeta {
  return {
    sessionId,
    model: 'test-model',
    cwd: '/tmp',
    createdAt: lastActiveAt,
    lastActiveAt,
    messageCount: 0,
    compactionCount: 0,
    userId,
  }
}

const DAY = 24 * 60 * 60 * 1000

describe('searchOwnedSessions (streaming transcript grep)', () => {
  it('finds matches scoped to the user, formatted as sessionId:index: snippet', async () => {
    const now = Date.now()
    await saveMetaAs('u1', 'feishu:dm:a', makeMeta('feishu:dm:a', 'u1', now))
    await appendMessagesAs('u1', 'feishu:dm:a', [
      createUserMessage('we discussed the vector index last week'),
      createUserMessage('unrelated chatter'),
      createUserMessage('the vector index again'),
    ])
    // A different user's session that also contains the needle — must not leak.
    await saveMetaAs('u2', 'feishu:dm:b', makeMeta('feishu:dm:b', 'u2', now))
    await appendMessagesAs('u2', 'feishu:dm:b', [
      createUserMessage('u2 also mentions the vector index'),
    ])

    const hits = await searchOwnedSessions('u1', { query: 'vector index', limit: 50 })

    assert.equal(hits.length, 2)
    assert.match(hits[0]!, /^feishu:dm:a:0: /)
    assert.match(hits[1]!, /^feishu:dm:a:2: /)
    assert.ok(hits.every(line => !line.includes('feishu:dm:b')))
  })

  it('reports indices that align with loadTranscript even across skipped JSONL lines', async () => {
    const now = Date.now()
    await saveMetaAs('u1', 'feishu:dm:idx', makeMeta('feishu:dm:idx', 'u1', now))
    await appendMessagesAs('u1', 'feishu:dm:idx', [
      createUserMessage('alpha one'),
      createUserMessage('beta filler'),
    ])
    // A non-message marker line (the shape fork transcripts prepend) — both
    // loadTranscript and the streaming searcher must skip it identically, so
    // it must not shift the index of the message that follows.
    await asUser('u1', () =>
      appendFile(
        getTranscriptPath('feishu:dm:idx'),
        `${JSON.stringify({ kind: 'fork-transcript-meta', forkContextEndIndex: 0 })}\n`,
        'utf8',
      ),
    )
    await appendMessagesAs('u1', 'feishu:dm:idx', [createUserMessage('alpha two')])

    const transcript = await asUser('u1', () => loadTranscript('feishu:dm:idx'))
    const hits = await searchOwnedSessions('u1', { query: 'alpha', limit: 50 })

    // Each reported index must point at a message that actually contains the
    // needle — the contract ConversationRead's offset relies on.
    assert.equal(hits.length, 2)
    for (const line of hits) {
      const match = /^feishu:dm:idx:(\d+): /.exec(line)
      assert.ok(match, `unexpected hit shape: ${line}`)
      const index = Number(match![1])
      const text =
        typeof transcript[index]!.message.content === 'string'
          ? (transcript[index]!.message.content as string)
          : JSON.stringify(transcript[index]!.message.content)
      assert.match(text, /alpha/)
    }
    assert.deepEqual(
      hits.map(line => /:(\d+): /.exec(line)![1]),
      ['0', '2'],
    )
  })

  it('respects the daysBack cutoff and channel filter', async () => {
    const now = Date.now()
    await saveMetaAs('u1', 'feishu:dm:recent', makeMeta('feishu:dm:recent', 'u1', now))
    await appendMessagesAs('u1', 'feishu:dm:recent', [createUserMessage('needle here')])
    await saveMetaAs('u1', 'feishu:dm:old', makeMeta('feishu:dm:old', 'u1', now - 10 * DAY))
    await appendMessagesAs('u1', 'feishu:dm:old', [createUserMessage('needle here too')])
    await saveMetaAs('u1', 'terminal-x', makeMeta('terminal-x', 'u1', now))
    await appendMessagesAs('u1', 'terminal-x', [createUserMessage('needle in terminal')])

    const recent = await searchOwnedSessions('u1', { query: 'needle', daysBack: 3, limit: 50 })
    assert.equal(recent.length, 2) // recent dm + terminal; old dm excluded
    assert.ok(recent.every(line => !line.startsWith('feishu:dm:old')))

    const feishuOnly = await searchOwnedSessions('u1', { query: 'needle', channel: 'feishu', limit: 50 })
    assert.ok(feishuOnly.every(line => line.startsWith('feishu:')))
  })

  it('stops at the limit', async () => {
    const now = Date.now()
    await saveMetaAs('u1', 'feishu:dm:many', makeMeta('feishu:dm:many', 'u1', now))
    await appendMessagesAs(
      'u1',
      'feishu:dm:many',
      Array.from({ length: 10 }, (_, i) => createUserMessage(`hit ${i}`)),
    )

    const hits = await searchOwnedSessions('u1', { query: 'hit', limit: 4 })
    assert.equal(hits.length, 4)
  })
})

describe('listOwnedSessionMetas', () => {
  it('returns only the user\'s sessions, newest-active first, without loading transcripts', async () => {
    const now = Date.now()
    await saveMetaAs('u1', 'feishu:dm:old', makeMeta('feishu:dm:old', 'u1', now - 5 * DAY))
    await saveMetaAs('u1', 'feishu:dm:new', makeMeta('feishu:dm:new', 'u1', now))
    await saveMetaAs('u2', 'feishu:dm:other', makeMeta('feishu:dm:other', 'u2', now))
    // A session with meta but no transcript file must not throw.
    const metas = await listOwnedSessionMetas('u1')

    assert.deepEqual(
      metas.map(meta => meta.sessionId),
      ['feishu:dm:new', 'feishu:dm:old'],
    )
  })

  it('excludes background fires and dispatched-worker leaf sessions', async () => {
    const now = Date.now()
    // Real conversations.
    await saveMetaAs('u1', 'feishu:dm:real', makeMeta('feishu:dm:real', 'u1', now))
    await saveMetaAs(
      'u1',
      'feishu:group:oc_x:ou_y',
      makeMeta('feishu:group:oc_x:ou_y', 'u1', now),
    )
    // Framework execution sessions that carry the SAME userId.
    await saveMetaAs(
      'u1',
      'bg-u1-u1-01a0dd78-deadbeef',
      makeMeta('bg-u1-u1-01a0dd78-deadbeef', 'u1', now),
    )
    await saveMetaAs('u1', 'u1-4f530b81', makeMeta('u1-4f530b81', 'u1', now)) // dispatched leaf
    await appendMessagesAs('u1', 'bg-u1-u1-01a0dd78-deadbeef', [
      createUserMessage('internal worker chatter mentioning the needle'),
    ])

    const metas = await listOwnedSessionMetas('u1')
    assert.deepEqual(
      metas.map(meta => meta.sessionId).sort(),
      ['feishu:dm:real', 'feishu:group:oc_x:ou_y'],
    )

    // And the grep path (which goes through the same enumerator) must not
    // surface content from those execution sessions.
    const hits = await searchOwnedSessions('u1', { query: 'needle', limit: 50 })
    assert.deepEqual(hits, [])
  })
})

describe('channelFromSessionId', () => {
  it('labels colon-scheme Feishu sessions correctly (regression)', () => {
    assert.equal(channelFromSessionId('feishu:dm:oc_b16eb987a021d327'), 'feishu')
    assert.equal(channelFromSessionId('feishu:group:oc_x:ou_y'), 'feishu')
    assert.equal(channelFromSessionId('terminal-console'), 'terminal')
  })
})
