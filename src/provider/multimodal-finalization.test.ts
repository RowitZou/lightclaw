import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  // Minimal config so `getConfig()` calls inside the downgrade path (e.g.
  // resolveResizeTarget reading attachments.imageMaxMb) don't throw on
  // "No models configured". The downgrade orchestration we test here
  // doesn't read endpoints/models — it just needs a valid file present.
  writeFileSync(
    path.join(homeDir, 'config.json'),
    JSON.stringify({
      endpoints: { a: { apiKey: 'sk-x' } },
      models: { m: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' } },
    }),
  )
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

  it('downgrades document blocks to actionable text when no runtime is provided', async () => {
    // pdf@inToolResult disabled + no Runtime in FinalizationContext → the
    // documentDowngrade path falls back to an actionable text marker (not
    // a silent drop). Agents reading the fallback know to re-Read with
    // pages + visual:true to recover the visual content as image pages.
    writeCacheEntry({
      endpoint: 'e',
      upstreamModel: 'm',
      kind: 'pdf',
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
              {
                type: 'document',
                source: {
                  type: 'base64',
                  mediaType: 'application/pdf',
                  data: 'JVBERi0xLjQK',
                },
              },
            ],
          },
        ],
      },
    ]
    const out = await finalizeToolResultImageBlocks(messages, {
      provider: makeProvider('openai'),
      endpoint: 'e',
      upstreamModel: 'm',
      config: dummyConfig,
      describeAdapter: async () => ({ text: 'never' }),
      describeEndpoint: 'd',
      describeUpstreamModel: 'd',
      // No runtime → documentDowngrade falls back to text marker.
    })
    const trBlock = (out[0].content as Array<Record<string, unknown>>)[0]
    const inner = trBlock.content as Array<Record<string, unknown>>
    assert.equal(inner.length, 2, 'header text + downgrade text marker')
    assert.equal(inner[0].type, 'text')
    assert.equal(inner[0].text, 'header')
    assert.equal(inner[1].type, 'text', 'document block replaced by text')
    assert.match(
      String(inner[1].text),
      /PDF document.*application\/pdf.*Re-run `Read`.*visual: true.*no runtime/,
    )
  })

  it('downgrades document blocks via pdftoppm to image blocks when runtime is provided', async () => {
    writeCacheEntry({
      endpoint: 'e',
      upstreamModel: 'm',
      kind: 'pdf',
      position: 'inToolResult',
      entry: { enabled: false, failures: 0 },
    })
    // Minimal Runtime stub: write/read/stat/readdir + exec that fakes the
    // pdfinfo + pdftoppm commands plus a no-op cleanup. The point of the
    // test is the orchestration (write source.pdf → pdfinfo → pdftoppm
    // → readdir → emit text+image blocks), not the real binaries.
    const writes = new Map<string, Buffer | string>()
    const pageNames = ['page-1.jpg', 'page-2.jpg']
    const minimalJpeg = Buffer.from([
      0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00,
      0x01, 0x01, 0x00, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00, 0xFF, 0xD9,
    ])
    const fakeRuntime = {
      workspaceRoot: '/ws',
      fs: {
        writeFile: async (p: string, c: Buffer | string) => { writes.set(p, c) },
        readFile: async (p: string) => {
          if (p.endsWith('.jpg')) return minimalJpeg
          throw new Error(`unexpected readFile ${p}`)
        },
        readdir: async () => pageNames,
        stat: async () => ({ size: minimalJpeg.length, isFile: true, isDirectory: false, mtimeMs: 0 }),
      },
      exec: async (params: { command: string }) => {
        if (params.command.includes('pdfinfo')) {
          return { exitCode: 0, stdout: 'Pages:           2\n', stderr: '', killedBySignal: null }
        }
        if (params.command.includes('pdftoppm')) {
          return { exitCode: 0, stdout: '', stderr: '', killedBySignal: null }
        }
        if (params.command.includes('rm -rf')) {
          return { exitCode: 0, stdout: '', stderr: '', killedBySignal: null }
        }
        throw new Error(`unexpected exec: ${params.command}`)
      },
    } as unknown as import('../runtime/types.js').Runtime

    const messages: ApiMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [
              { type: 'text', text: 'header' },
              {
                type: 'document',
                source: {
                  type: 'base64',
                  mediaType: 'application/pdf',
                  data: Buffer.from('%PDF-1.4\nfake').toString('base64'),
                },
              },
            ],
          },
        ],
      },
    ]
    const out = await finalizeToolResultImageBlocks(messages, {
      provider: makeProvider('openai'),
      endpoint: 'e',
      upstreamModel: 'm',
      config: dummyConfig,
      describeAdapter: async () => ({ text: 'never' }),
      describeEndpoint: 'd',
      describeUpstreamModel: 'd',
      runtime: fakeRuntime,
    })
    const trBlock = (out[0].content as Array<Record<string, unknown>>)[0]
    const inner = trBlock.content as Array<Record<string, unknown>>
    // Expected shape: original header + downgrade lead-text + (page1 label, page1 image) + (page2 label, page2 image)
    assert.equal(inner[0].text, 'header')
    assert.equal(inner[1].type, 'text')
    assert.match(String(inner[1].text), /downgraded to 2 page images/)
    const types = inner.map(b => b.type)
    assert.equal(types.filter(t => t === 'image').length, 2, 'two image blocks emitted')
    assert.ok(writes.size > 0, 'PDF body written to sandbox tmp file')
  })

  it('forceFallbackInToolResult overrides cache and triggers downgrade', async () => {
    // Cache says enabled=true (pdf in tool_result accepted), but the
    // channel autopilot's per-call override flag forces downgrade for
    // THIS request — the previously-emitted document block still gets
    // replaced. Counter-state on disk doesn't matter here; only the
    // per-call override.
    writeCacheEntry({
      endpoint: 'e',
      upstreamModel: 'm',
      kind: 'pdf',
      position: 'inToolResult',
      entry: { enabled: true, failures: 0 },
    })
    const messages: ApiMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [
              {
                type: 'document',
                source: { type: 'base64', mediaType: 'application/pdf', data: 'JVBE' },
              },
            ],
          },
        ],
      },
    ]
    const out = await finalizeToolResultImageBlocks(messages, {
      provider: makeProvider('anthropic'),
      endpoint: 'e',
      upstreamModel: 'm',
      config: dummyConfig,
      describeAdapter: async () => ({ text: 'never' }),
      describeEndpoint: 'd',
      describeUpstreamModel: 'd',
      forceFallbackInToolResult: new Set<import('./types.js').AttachmentKind>(['pdf']),
      // No runtime → text marker fallback (still proves the override
      // triggered the replace path).
    })
    const trBlock = (out[0].content as Array<Record<string, unknown>>)[0]
    const inner = trBlock.content as Array<Record<string, unknown>>
    assert.equal(inner.length, 1)
    assert.equal(inner[0].type, 'text', 'document replaced even though cache says enabled=true')
    assert.match(String(inner[0].text), /PDF document/)
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
