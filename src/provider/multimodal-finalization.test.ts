import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  writeCacheEntry,
  _resetCacheForTests as resetCapabilityCache,
} from './capability-cache.js'
import { _resetCacheForTests as resetBatchCache } from './batch-size-cache.js'
import { _clearDescribeCacheForTests } from './describe-cache.js'
import { finalizeToolResultImageBlocks } from './multimodal-finalization.js'
import type { ApiMessage, Provider } from './types.js'
import type { LightClawConfig } from '../config.js'

let prevHome: string | undefined
let homeDir: string

beforeEach(() => {
  homeDir = mkdtempSync(path.join(tmpdir(), 'lightclaw-mmfin-'))
  prevHome = process.env.LIGHTCLAW_HOME
  process.env.LIGHTCLAW_HOME = homeDir
  resetCapabilityCache()
  resetBatchCache()
  _clearDescribeCacheForTests()
})

afterEach(() => {
  if (prevHome === undefined) {
    delete process.env.LIGHTCLAW_HOME
  } else {
    process.env.LIGHTCLAW_HOME = prevHome
  }
  rmSync(homeDir, { recursive: true, force: true })
  resetCapabilityCache()
  resetBatchCache()
  _clearDescribeCacheForTests()
})

function makeProvider(name: 'anthropic' | 'openai' | 'openai-auth'): Provider {
  return {
    name,
    capabilities: {
      serverTools: { webSearch: false },
      promptCaching: false,
    },
    streamChat: async function* () {},
  } as unknown as Provider
}

const dummyConfig = {} as LightClawConfig

function imageBlock(seq: number) {
  return {
    type: 'image' as const,
    source: {
      type: 'base64' as const,
      mediaType: 'image/jpeg',
      data: Buffer.from(`payload-${seq}`).toString('base64'),
    },
  }
}

describe('finalizeToolResultImageBlocks', () => {
  it('returns input unchanged when no tool_result image blocks present', async () => {
    const messages: ApiMessage[] = [
      { role: 'user', content: 'plain text' },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'just text' },
        ],
      },
    ]
    let described = 0
    const out = await finalizeToolResultImageBlocks(messages, {
      provider: makeProvider('anthropic'),
      endpoint: 'e',
      upstreamModel: 'm',
      config: dummyConfig,
      describeAdapter: async () => {
        described += 1
        return { text: 'should not run' }
      },
      describeEndpoint: 'e',
      describeUpstreamModel: 'm',
    })
    assert.equal(out, messages, 'identity passthrough')
    assert.equal(described, 0)
  })

  it('keeps Anthropic image blocks when image cache is unset / true', async () => {
    const messages: ApiMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [
              { type: 'text', text: 'header' },
              imageBlock(1),
            ],
          },
        ],
      },
    ]
    let described = 0
    const out = await finalizeToolResultImageBlocks(messages, {
      provider: makeProvider('anthropic'),
      endpoint: 'e',
      upstreamModel: 'm',
      config: dummyConfig,
      describeAdapter: async () => {
        described += 1
        return { text: 'never' }
      },
      describeEndpoint: 'd',
      describeUpstreamModel: 'd',
    })
    assert.equal(out, messages, 'no transform when cache is unset for anthropic')
    assert.equal(described, 0)

    writeCacheEntry({
      endpoint: 'e',
      upstreamModel: 'm',
      kind: 'image',
      position: 'inToolResult',
      entry: { enabled: true, failures: 0 },
    })
    const out2 = await finalizeToolResultImageBlocks(messages, {
      provider: makeProvider('anthropic'),
      endpoint: 'e',
      upstreamModel: 'm',
      config: dummyConfig,
      describeAdapter: async () => {
        described += 1
        return { text: 'never' }
      },
      describeEndpoint: 'd',
      describeUpstreamModel: 'd',
    })
    assert.equal(out2, messages)
  })

  it('replaces Anthropic image blocks when image cache is false', async () => {
    writeCacheEntry({
      endpoint: 'e',
      upstreamModel: 'm',
      kind: 'image',
      position: 'inToolResult',
      entry: { enabled: false, failures: 0 },
    })
    const messages: ApiMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [
              { type: 'text', text: 'header' },
              imageBlock(1),
              imageBlock(2),
            ],
          },
        ],
      },
    ]
    let described = 0
    const out = await finalizeToolResultImageBlocks(messages, {
      provider: makeProvider('anthropic'),
      endpoint: 'e',
      upstreamModel: 'm',
      config: dummyConfig,
      describeAdapter: async ({ images }) => {
        described += 1
        return { text: `described ${images.length} images` }
      },
      describeEndpoint: 'd',
      describeUpstreamModel: 'd',
    })
    assert.equal(described, 1, 'batch describe call once for two consecutive image blocks')
    const userMsg = out[0]
    assert.ok(Array.isArray(userMsg.content))
    const trBlock = (userMsg.content as Array<Record<string, unknown>>)[0]
    const innerContent = trBlock.content as Array<Record<string, unknown>>
    assert.equal(innerContent.length, 2, 'header text + describe text')
    assert.equal(innerContent[0].type, 'text')
    assert.equal(innerContent[0].text, 'header')
    assert.equal(innerContent[1].type, 'text')
    assert.match(String(innerContent[1].text), /described 2 images/)
  })

  it('replaces image blocks when image@inToolResult cache is false', async () => {
    // Provider construction precharges OpenAI Chat tool-result image support
    // to false. The finalizer keys off that cache fact, not provider name.
    writeCacheEntry({
      endpoint: 'e',
      upstreamModel: 'm',
      kind: 'image',
      position: 'inToolResult',
      entry: { enabled: false, failures: 0 },
    })
    const messages: ApiMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [imageBlock(1)],
          },
        ],
      },
    ]
    let described = 0
    await finalizeToolResultImageBlocks(messages, {
      provider: makeProvider('openai'),
      endpoint: 'e',
      upstreamModel: 'm',
      config: dummyConfig,
      describeAdapter: async () => {
        described += 1
        return { text: 'descr' }
      },
      describeEndpoint: 'd',
      describeUpstreamModel: 'd',
    })
    assert.equal(described, 1)
  })

  it('preserves order around mixed text + image sequences', async () => {
    writeCacheEntry({
      endpoint: 'e',
      upstreamModel: 'm',
      kind: 'image',
      position: 'inToolResult',
      entry: { enabled: false, failures: 0 },
    })
    const messages: ApiMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [
              { type: 'text', text: 'A' },
              imageBlock(1),
              { type: 'text', text: 'B' },
              imageBlock(2),
              imageBlock(3),
              { type: 'text', text: 'C' },
            ],
          },
        ],
      },
    ]
    let calls = 0
    const out = await finalizeToolResultImageBlocks(messages, {
      provider: makeProvider('anthropic'),
      endpoint: 'e',
      upstreamModel: 'm',
      config: dummyConfig,
      describeAdapter: async ({ images }) => {
        calls += 1
        return { text: `desc-${images.length}` }
      },
      describeEndpoint: 'd',
      describeUpstreamModel: 'd',
    })
    // Two consecutive image segments → two batched describe calls
    // ([img1] alone between A and B, then [img2,img3] between B and C).
    assert.equal(calls, 2)
    const userMsg = out[0]
    const trBlock = (userMsg.content as Array<Record<string, unknown>>)[0]
    const inner = trBlock.content as Array<Record<string, unknown>>
    assert.deepEqual(
      inner.map(b => b.type),
      ['text', 'text', 'text', 'text', 'text'],
    )
    assert.equal(inner[0].text, 'A')
    assert.match(String(inner[1].text), /desc-1/)
    assert.equal(inner[2].text, 'B')
    assert.match(String(inner[3].text), /desc-2/)
    assert.equal(inner[4].text, 'C')
  })
})
