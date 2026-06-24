import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { setLightclawHomeOverride } from '../paths.js'
import { appendUsage, type UsageRecord } from '../usage/storage.js'
import { formatCost } from './builtin.js'

let tmpHome: string

// ts inside the current month (== month-start, which passes formatCost's
// `>= monthStart` filter) so the record is always in scope regardless of when
// the test runs.
function thisMonthTs(): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
}

function rec(over: Partial<UsageRecord>): UsageRecord {
  return {
    ts: thisMonthTs(),
    user: 'alice',
    model: 'pub-model',
    kind: 'main',
    input: 100,
    output: 50,
    cacheRead: 0,
    cacheCreate: 0,
    ...over,
  }
}

// A minimal but boot-valid `<home>/config.json` with exactly one PUBLIC model.
function writeConfig(): void {
  fs.writeFileSync(
    path.join(tmpHome, 'config.json'),
    JSON.stringify({
      endpoints: { ep: { apiKey: 'sk-x' } },
      models: { 'pub-model': { endpoint: 'ep', schema: 'openai', upstreamModel: 'gpt-x' } },
    }),
    'utf8',
  )
}

describe('formatCost public-model filtering', () => {
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(tmpdir(), 'lightclaw-cost-'))
    setLightclawHomeOverride(tmpHome)
    writeConfig()
  })

  afterEach(() => {
    setLightclawHomeOverride(undefined)
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it('tallies public-registry models and excludes users-only BYO models', async () => {
    await appendUsage(rec({ user: 'alice', model: 'pub-model', input: 1000 }))
    // carol used ONLY a BYO model not present in the public registry.
    await appendUsage(rec({ user: 'carol', model: 'byo-model', input: 5000 }))

    const out = await formatCost()

    assert.ok(out.includes('pub-model'), 'public model must appear in the report')
    assert.ok(!out.includes('byo-model'), 'BYO model must be excluded from the report')
    assert.ok(out.includes('alice'), 'a user of a public model must appear')
    assert.ok(!out.includes('carol'), 'a BYO-only user must be excluded')
  })

  it('reports empty when only BYO-model usage exists', async () => {
    await appendUsage(rec({ user: 'carol', model: 'byo-model', input: 5000 }))
    const out = await formatCost()
    // cost.empty string differs by locale; assert the BYO traces are absent and
    // no by-model/by-user numbers leaked through.
    assert.ok(!out.includes('byo-model'))
    assert.ok(!out.includes('carol'))
  })
})
