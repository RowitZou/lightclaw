import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  getActiveApiLogger,
  openApiLogger,
  runWithApiLogger,
  type ApiLogTurnRecord,
} from './storage.js'

let tmpDir: string

function rec(over: Partial<ApiLogTurnRecord>): ApiLogTurnRecord {
  return {
    kind: 'main',
    sessionId: 'feishu-alice',
    turn: 0,
    attempt: 0,
    ts: '2026-05-04T08:50:13.123Z',
    model: 'claude-sonnet-4-6',
    request: {
      system: 'system prompt',
      tools: [{ name: 'Bash' }],
      messages: [{ role: 'user', content: 'hi' }],
    },
    response: {
      content: [{ type: 'text', text: 'hello' }],
      stopReason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    ...over,
  }
}

describe('api-logs storage', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), 'lightclaw-api-logs-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('disabled logger writes nothing', async () => {
    const logger = openApiLogger({ enabled: false, dir: tmpDir, sessionId: 'feishu-alice' })
    await logger.appendTurn(rec({ turn: 0 }))
    await logger.appendTurn(rec({ turn: 1 }))
    assert.deepEqual(fs.readdirSync(tmpDir), [], 'no files created when disabled')
    assert.equal(logger.filePath(), '', 'noop logger reports empty filePath')
  })

  it('enabled logger creates day-dir + jsonl on first append', async () => {
    const logger = openApiLogger({ enabled: true, dir: tmpDir, sessionId: 'feishu-alice' })
    await logger.appendTurn(rec({ turn: 0 }))
    await logger.appendTurn(rec({ turn: 1, attempt: 0 }))

    const file = logger.filePath()
    assert.ok(file.length > 0)
    assert.ok(fs.existsSync(file), 'jsonl file exists')
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    const parsed = lines.map(l => JSON.parse(l) as ApiLogTurnRecord)
    assert.equal(parsed[0]!.turn, 0)
    assert.equal(parsed[1]!.turn, 1)
  })

  it('file path includes day directory + sessionId + HHMMSS + uuid', () => {
    const logger = openApiLogger({ enabled: true, dir: tmpDir, sessionId: 'feishu-alice' })
    const file = logger.filePath()
    const rel = path.relative(tmpDir, file)
    assert.match(rel, /^\d{4}-\d{2}-\d{2}\/feishu-alice-\d{6}-[0-9a-f]{8}\.jsonl$/)
  })

  it('sanitizes sessionId chars unsafe for filenames', () => {
    const logger = openApiLogger({ enabled: true, dir: tmpDir, sessionId: 'foo/bar:baz qux' })
    const file = logger.filePath()
    const base = path.basename(file)
    assert.ok(base.startsWith('foo_bar_baz_qux-'), `got: ${base}`)
  })

  it('preserves complete request fields verbatim (system + tools + messages)', async () => {
    const longSystem = 'You are LightClaw.\n'.repeat(50)  // ~1KB
    const tools = Array.from({ length: 8 }, (_, i) => ({
      name: `Tool${i}`,
      description: `desc ${i}`,
      input_schema: { type: 'object', properties: { x: { type: 'string' } } },
    }))
    const messages = Array.from({ length: 6 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `msg ${i}`,
    }))
    const logger = openApiLogger({ enabled: true, dir: tmpDir, sessionId: 'sess' })
    await logger.appendTurn(rec({ request: { system: longSystem, tools, messages } }))
    const parsed = JSON.parse(
      fs.readFileSync(logger.filePath(), 'utf8').trim(),
    ) as ApiLogTurnRecord
    assert.equal(parsed.request.system, longSystem)
    assert.deepEqual(parsed.request.tools, tools)
    assert.deepEqual(parsed.request.messages, messages)
  })

  it('error records have error field and no response', async () => {
    const logger = openApiLogger({ enabled: true, dir: tmpDir, sessionId: 'sess' })
    await logger.appendTurn({
      kind: 'main',
      sessionId: 'sess',
      turn: 0,
      attempt: 0,
      ts: '2026-05-04T08:50:13.123Z',
      model: 'claude-sonnet-4-6',
      request: { system: 's', tools: [], messages: [] },
      error: { name: 'ValidationException', message: 'messages.7: bad' },
    })
    const parsed = JSON.parse(
      fs.readFileSync(logger.filePath(), 'utf8').trim(),
    ) as ApiLogTurnRecord
    assert.equal(parsed.error?.name, 'ValidationException')
    assert.equal(parsed.response, undefined)
  })

  it('append failure does not throw — writes to stderr instead', async () => {
    // make dir un-creatable: pass a path that already exists as a file.
    const blockerFile = path.join(tmpDir, 'blocker')
    fs.writeFileSync(blockerFile, '')
    const logger = openApiLogger({ enabled: true, dir: blockerFile, sessionId: 'sess' })
    // Should not throw.
    await logger.appendTurn(rec({}))
  })

  it('persists kind / sessionId / user / subagentLabel', async () => {
    const logger = openApiLogger({ enabled: true, dir: tmpDir, sessionId: 'feishu-bob' })
    await logger.appendTurn(
      rec({
        kind: 'subagent',
        subagentLabel: 'extract_memories',
        sessionId: 'feishu-bob',
        user: 'bob',
      }),
    )
    const parsed = JSON.parse(
      fs.readFileSync(logger.filePath(), 'utf8').trim(),
    ) as ApiLogTurnRecord
    assert.equal(parsed.kind, 'subagent')
    assert.equal(parsed.subagentLabel, 'extract_memories')
    assert.equal(parsed.sessionId, 'feishu-bob')
    assert.equal(parsed.user, 'bob')
  })

  it('one-shot kinds (recall / compact / session-memory) round-trip', async () => {
    const kinds = ['recall', 'compact', 'session-memory'] as const
    const logger = openApiLogger({ enabled: true, dir: tmpDir, sessionId: 'sess' })
    for (const kind of kinds) {
      await logger.appendTurn(rec({ kind, sessionId: 'sess' }))
    }
    const lines = fs.readFileSync(logger.filePath(), 'utf8').trim().split('\n')
    const parsed = lines.map(l => JSON.parse(l) as ApiLogTurnRecord)
    assert.deepEqual(
      parsed.map(p => p.kind),
      [...kinds],
    )
  })
})

describe('api-logs AsyncLocalStorage scope', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(tmpdir(), 'lightclaw-api-logs-scope-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('getActiveApiLogger returns null outside any scope', () => {
    assert.equal(getActiveApiLogger(), null)
  })

  it('runWithApiLogger pushes the active logger for the duration of the callback', async () => {
    const logger = openApiLogger({ enabled: true, dir: tmpDir, sessionId: 'outer' })
    let inside: ReturnType<typeof getActiveApiLogger> = null
    await runWithApiLogger(logger, async () => {
      inside = getActiveApiLogger()
    })
    assert.equal(inside, logger)
    assert.equal(getActiveApiLogger(), null, 'pops after callback returns')
  })

  it('nested runWithApiLogger swaps the active logger (subagent fork shape)', async () => {
    const outer = openApiLogger({ enabled: true, dir: tmpDir, sessionId: 'outer' })
    const inner = openApiLogger({ enabled: true, dir: tmpDir, sessionId: 'inner' })
    let seenOuterBefore: ReturnType<typeof getActiveApiLogger> = null
    let seenInner: ReturnType<typeof getActiveApiLogger> = null
    let seenOuterAfter: ReturnType<typeof getActiveApiLogger> = null

    await runWithApiLogger(outer, async () => {
      seenOuterBefore = getActiveApiLogger()
      await runWithApiLogger(inner, async () => {
        seenInner = getActiveApiLogger()
      })
      seenOuterAfter = getActiveApiLogger()
    })

    assert.equal(seenOuterBefore, outer)
    assert.equal(seenInner, inner)
    assert.equal(seenOuterAfter, outer, 'restored after inner pops')
  })
})
