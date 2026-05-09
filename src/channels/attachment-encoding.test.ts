import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { _resetCacheForTests, recordCapability } from '../provider/capability-cache.js'
import type { Provider } from '../provider/types.js'
import { LocalRuntime } from '../runtime/local.js'
import {
  classifyAttachment,
  encodeAttachmentsForInline,
} from './attachment-encoding.js'
import type { MaterializedAttachment } from './types.js'

let homeDir: string
let workspace: string
let runtime: LocalRuntime
let prevHome: string | undefined

beforeEach(() => {
  homeDir = mkdtempSync(path.join(tmpdir(), 'lightclaw-att-encode-home-'))
  workspace = mkdtempSync(path.join(tmpdir(), 'lightclaw-att-encode-ws-'))
  prevHome = process.env.LIGHTCLAW_HOME
  process.env.LIGHTCLAW_HOME = homeDir
  _resetCacheForTests()
  runtime = new LocalRuntime(workspace)
})

afterEach(() => {
  if (prevHome === undefined) {
    delete process.env.LIGHTCLAW_HOME
  } else {
    process.env.LIGHTCLAW_HOME = prevHome
  }
  rmSync(homeDir, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
  _resetCacheForTests()
})

function makeProvider(overrides: Partial<Provider['capabilities']['attachments']> = {}): Provider {
  return {
    name: 'anthropic',
    capabilities: {
      serverTools: { webSearch: false },
      promptCaching: false,
      attachments: {
        image: 'unknown',
        pdf: 'unknown',
        audio: false,
        video: false,
        ...overrides,
      },
    },
    streamChat: async function* () {},
  } as unknown as Provider
}

function makeConfig(imageMaxMb = 5, pdfMaxMb = 32) {
  return {
    attachments: { imageMaxMb, pdfMaxMb },
  } as unknown as Parameters<typeof encodeAttachmentsForInline>[0]['config']
}

describe('classifyAttachment', () => {
  it('classifies by mime type prefix when available', () => {
    assert.equal(
      classifyAttachment({ path: '/foo', mimeType: 'image/jpeg' }),
      'image',
    )
    assert.equal(
      classifyAttachment({ path: '/foo', mimeType: 'application/pdf' }),
      'pdf',
    )
    assert.equal(
      classifyAttachment({ path: '/foo', mimeType: 'audio/opus' }),
      'audio',
    )
  })

  it('falls back to extension when mime is generic / wrong', () => {
    assert.equal(
      classifyAttachment({ path: '/foo.pdf', mimeType: 'application/octet-stream' }),
      'pdf',
    )
    assert.equal(
      classifyAttachment({ path: '/foo.png', mimeType: 'application/octet-stream' }),
      'image',
    )
  })

  it('returns null for unrecognized files', () => {
    assert.equal(
      classifyAttachment({ path: '/foo.xyz', mimeType: 'application/octet-stream' }),
      null,
    )
  })
})

describe('encodeAttachmentsForInline', () => {
  it('encodes a small image inline as a base64 image block', async () => {
    const file = path.join(workspace, 'small.jpg')
    writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))  // jpeg magic
    const result = await encodeAttachmentsForInline({
      attachments: [{ path: file, mimeType: 'image/jpeg' }],
      provider: makeProvider(),
      endpoint: 'newapi',
      upstreamModel: 'claude-sonnet-4-6',
      runtime,
      config: makeConfig(),
    })
    assert.equal(result.inlineBlocks.length, 1)
    assert.equal(result.fallbackPaths.length, 0)
    const block = result.inlineBlocks[0] as { type: string; source: { mediaType: string; data: string } }
    assert.equal(block.type, 'image')
    assert.equal(block.source.mediaType, 'image/jpeg')
    assert.ok(block.source.data.length > 0)
  })

  it('routes to fallback when capability is cached as false', async () => {
    const file = path.join(workspace, 'photo.png')
    writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]))  // png magic
    recordCapability({
      endpoint: 'codex',
      upstreamModel: 'gpt-5.5',
      kind: 'image',
      value: false,
    })
    const result = await encodeAttachmentsForInline({
      attachments: [{ path: file, mimeType: 'image/png' }],
      provider: makeProvider(),
      endpoint: 'codex',
      upstreamModel: 'gpt-5.5',
      runtime,
      config: makeConfig(),
    })
    assert.equal(result.inlineBlocks.length, 0)
    assert.equal(result.fallbackPaths.length, 1)
    assert.equal(result.fallbackPaths[0].path, file)
  })

  it('encodes small PDF inline as a base64 document block', async () => {
    const file = path.join(workspace, 'doc.pdf')
    writeFileSync(file, Buffer.from('%PDF-1.7\n%fake'))
    const result = await encodeAttachmentsForInline({
      attachments: [{ path: file, mimeType: 'application/pdf' }],
      provider: makeProvider(),
      endpoint: 'newapi',
      upstreamModel: 'claude-sonnet-4-6',
      runtime,
      config: makeConfig(),
    })
    assert.equal(result.inlineBlocks.length, 1)
    const block = result.inlineBlocks[0] as { type: string; source: { mediaType: string } }
    assert.equal(block.type, 'document')
    assert.equal(block.source.mediaType, 'application/pdf')
  })

  it('skips inline for PDF over the configured cap', async () => {
    const file = path.join(workspace, 'big.pdf')
    // 2MB worth of bytes (cap=1MB below)
    writeFileSync(file, Buffer.alloc(2 * 1024 * 1024, '%PDF-1.7\n'.charCodeAt(0)))
    const result = await encodeAttachmentsForInline({
      attachments: [{ path: file, mimeType: 'application/pdf' }],
      provider: makeProvider(),
      endpoint: 'newapi',
      upstreamModel: 'claude-sonnet-4-6',
      runtime,
      config: makeConfig(5, 1),  // pdfMaxMb = 1
    })
    assert.equal(result.inlineBlocks.length, 0)
    assert.equal(result.fallbackPaths.length, 1)
    assert.match(result.warnings[0] ?? '', /exceeds inline cap 1MB/)
  })

  it('mixes inline + fallback when capability flags differ per kind', async () => {
    const img = path.join(workspace, 'a.jpg')
    const pdf = path.join(workspace, 'b.pdf')
    writeFileSync(img, Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
    writeFileSync(pdf, Buffer.from('%PDF-1.7'))
    // image = unknown (will inline), pdf = false (cached → fallback)
    recordCapability({ endpoint: 'e', upstreamModel: 'm', kind: 'pdf', value: false })

    const result = await encodeAttachmentsForInline({
      attachments: [
        { path: img, mimeType: 'image/jpeg' },
        { path: pdf, mimeType: 'application/pdf' },
      ],
      provider: makeProvider(),
      endpoint: 'e',
      upstreamModel: 'm',
      runtime,
      config: makeConfig(),
    })
    assert.equal(result.inlineBlocks.length, 1, 'image inlines')
    assert.equal(result.fallbackPaths.length, 1, 'pdf falls back')
    assert.equal(result.fallbackPaths[0].path, pdf)
  })

  it('routes audio / video to fallback (default capability=false)', async () => {
    const audio = path.join(workspace, 'a.opus')
    writeFileSync(audio, Buffer.from('OggS'))
    const result = await encodeAttachmentsForInline({
      attachments: [
        { path: audio, mimeType: 'audio/opus' } satisfies MaterializedAttachment,
      ],
      provider: makeProvider(),
      endpoint: 'e',
      upstreamModel: 'm',
      runtime,
      config: makeConfig(),
    })
    assert.equal(result.inlineBlocks.length, 0)
    assert.equal(result.fallbackPaths.length, 1)
  })
})
