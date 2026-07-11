import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

import { streamChat } from './api.js'
import { getConfig } from './config.js'
import { setLightclawHomeOverride } from './paths.js'
import { readUsage, type UsageRecord } from './usage/storage.js'

// Regression for the 07-10 review §1.6 accounting gap: usage.jsonl was
// appended only from the query.ts agent loop, so sub-LLM streamChat callers
// (session-memory / compact / web-fetch-summarize) showed up in api-logs but
// never in usage.jsonl — /cost systematically under-reported. The fix moves
// accounting into streamChat itself (the same chokepoint the api logger
// uses), keyed off apiLogContext. These tests drive the real streamChat
// through a real anthropic SSE round-trip against an in-process server and
// assert the usage.jsonl record lands.

type SseScript = { frames: string[] }

let script: SseScript = { frames: [] }

const server = http.createServer((_req, res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  })
  for (const frame of script.frames) {
    res.write(frame)
  }
  res.end()
})

await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as AddressInfo).port

function sse(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
}

const CLEAN_TEXT_TURN: string[] = [
  sse('message_start', {
    message: { usage: { input_tokens: 120, cache_read_input_tokens: 30 } },
  }),
  sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } }),
  sse('content_block_stop', { index: 0 }),
  sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }),
  sse('message_stop', {}),
]

const TRUNCATED_TOOL_USE_TURN: string[] = [
  sse('message_start', { message: { usage: { input_tokens: 12 } } }),
  sse('content_block_start', {
    index: 0,
    content_block: { type: 'tool_use', id: 'tu_1', name: 'Dispatch', input: {} },
  }),
  sse('content_block_delta', {
    index: 0,
    delta: { type: 'input_json_delta', partial_json: '{"label": "truncated mid-w' },
  }),
]

let home: string

before(() => {
  home = mkdtempSync(path.join(tmpdir(), 'lightclaw-usage-acct-'))
  writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({
      endpoints: {
        test: { apiKey: 'sk-test', baseUrl: `http://127.0.0.1:${port}` },
      },
      models: {
        'test-model': { endpoint: 'test', schema: 'anthropic', upstreamModel: 'test-upstream' },
      },
      defaultModel: 'test-model',
    }),
  )
  setLightclawHomeOverride(home)
})

after(() => {
  setLightclawHomeOverride(undefined)
  rmSync(home, { recursive: true, force: true })
  server.closeAllConnections?.()
  server.close()
})

beforeEach(() => {
  rmSync(path.join(home, 'usage.jsonl'), { force: true })
})

async function collectUsage(): Promise<UsageRecord[]> {
  const out: UsageRecord[] = []
  for await (const r of readUsage()) out.push(r)
  return out
}

async function drain(kind: string, ephemeral?: boolean): Promise<void> {
  const gen = streamChat({
    model: 'test-model',
    messages: [{ role: 'user', content: 'hi' }],
    system: 'test system',
    tools: [],
    config: getConfig(),
    apiLogContext: { kind: kind as never, ...(ephemeral ? { ephemeral: true } : {}) },
  })
  for await (const _event of gen) {
    // consume
  }
}

describe('streamChat usage accounting chokepoint', () => {
  it('records a sub-LLM call (kind session-memory) to usage.jsonl', async () => {
    script = { frames: CLEAN_TEXT_TURN }
    await drain('session-memory')
    const records = await collectUsage()
    assert.equal(records.length, 1)
    const r = records[0]!
    assert.equal(r.kind, 'session-memory')
    assert.equal(r.model, 'test-model')
    assert.equal(r.input, 120)
    assert.equal(r.output, 9)
    assert.equal(r.cacheRead, 30)
    // No ALS session context in this test → terminal attribution fallback.
    assert.equal(r.user, '__terminal__')
  })

  it('records ephemeral main-loop invocations as kind fresh', async () => {
    script = { frames: CLEAN_TEXT_TURN }
    await drain('main', true)
    const records = await collectUsage()
    assert.equal(records.length, 1)
    assert.equal(records[0]!.kind, 'fresh')
  })

  it('does not record an errored stream (no successful stop)', async () => {
    script = { frames: TRUNCATED_TOOL_USE_TURN }
    await assert.rejects(drain('compact'))
    const records = await collectUsage()
    assert.equal(records.length, 0)
  })

  it('does not record untagged calls (no apiLogContext)', async () => {
    script = { frames: CLEAN_TEXT_TURN }
    const gen = streamChat({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      system: 'test system',
      tools: [],
      config: getConfig(),
    })
    for await (const _event of gen) {
      // consume
    }
    const records = await collectUsage()
    assert.equal(records.length, 0)
  })
})
