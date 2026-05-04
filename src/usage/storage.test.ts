import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { setLightclawHomeOverride } from '../paths.js'
import { appendUsage, readUsage, type UsageRecord } from './storage.js'

let tmpHome: string

function rec(over: Partial<UsageRecord>): UsageRecord {
  return {
    ts: '2026-05-04T10:00:00.000Z',
    user: 'alice',
    model: 'claude-opus-4-7',
    kind: 'main',
    input: 100,
    output: 50,
    cacheRead: 0,
    cacheCreate: 0,
    ...over,
  }
}

async function collect(filter?: { sinceTs?: string }): Promise<UsageRecord[]> {
  const out: UsageRecord[] = []
  for await (const r of readUsage(filter)) out.push(r)
  return out
}

describe('usage storage', () => {
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(tmpdir(), 'lightclaw-usage-'))
    setLightclawHomeOverride(tmpHome)
  })

  afterEach(() => {
    setLightclawHomeOverride(undefined)
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it('readUsage returns empty when usage.jsonl does not exist', async () => {
    assert.deepEqual(await collect(), [])
  })

  it('append + read round-trip', async () => {
    await appendUsage(rec({ user: 'alice', input: 100 }))
    await appendUsage(rec({ user: 'bob', input: 200 }))
    const all = await collect()
    assert.equal(all.length, 2)
    assert.equal(all[0]!.user, 'alice')
    assert.equal(all[1]!.input, 200)
  })

  it('sinceTs filter excludes earlier records', async () => {
    await appendUsage(rec({ ts: '2026-04-01T00:00:00.000Z' }))
    await appendUsage(rec({ ts: '2026-05-15T00:00:00.000Z' }))
    const may = await collect({ sinceTs: '2026-05-01T00:00:00.000Z' })
    assert.equal(may.length, 1)
    assert.equal(may[0]!.ts, '2026-05-15T00:00:00.000Z')
  })

  it('append failures are caught and not thrown', async () => {
    // make path unwritable: replace lightclawHome with a path that has the
    // jsonl file as a directory (writeFile -> EISDIR)
    const dirPath = path.join(tmpHome, 'usage.jsonl')
    fs.mkdirSync(dirPath, { recursive: true })
    // Should not throw
    await appendUsage(rec({}))
  })

  it('readUsage skips malformed lines', async () => {
    const filePath = path.join(tmpHome, 'usage.jsonl')
    fs.writeFileSync(
      filePath,
      JSON.stringify(rec({ user: 'ok' })) + '\nnot-json\n' + JSON.stringify(rec({ user: 'also-ok' })) + '\n',
      'utf8',
    )
    const all = await collect()
    assert.equal(all.length, 2)
    assert.equal(all[0]!.user, 'ok')
    assert.equal(all[1]!.user, 'also-ok')
  })
})
