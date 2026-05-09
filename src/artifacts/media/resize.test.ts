import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { LocalRuntime } from '../../runtime/local.js'

import { resizeImageForVision } from './resize.js'

let tmp: string
let runtime: LocalRuntime

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'lightclaw-resize-'))
  runtime = new LocalRuntime(tmp)
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('resizeImageForVision', () => {
  it('returns the original buffer unchanged when size is under target', async () => {
    const filePath = path.join(tmp, 'small.jpg')
    writeFileSync(filePath, Buffer.alloc(1024, 0xab))
    const exec = async () => ({ stdout: '', stderr: '', exitCode: 0 })

    const result = await resizeImageForVision({
      filePath,
      fs: runtime.fs,
      workspaceRoot: tmp,
      exec,
      targetBytes: 5 * 1024 * 1024,
    })

    assert.equal(result.resized, false)
    assert.equal(result.buffer.length, 1024)
    assert.equal(result.warnings.length, 0)
  })

  it('reads back the resized output when exec succeeds', async () => {
    const filePath = path.join(tmp, 'big.jpg')
    writeFileSync(filePath, Buffer.alloc(8 * 1024 * 1024, 0xcd))

    let resizedOutPath: string | undefined
    const fakeResizedBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]) // JPEG magic prefix
    const exec = async (params: { env?: Record<string, string> }) => {
      const out = params.env?.LIGHTCLAW_RESIZE_OUT
      if (out && !resizedOutPath) {
        resizedOutPath = out
        // Simulate Pillow writing the resized JPEG
        const dir = path.dirname(out)
        await runtime.fs.writeFile(out, fakeResizedBuffer)
      }
      return { stdout: '256x256@q70=1024', stderr: '', exitCode: 0 }
    }

    const result = await resizeImageForVision({
      filePath,
      fs: runtime.fs,
      workspaceRoot: tmp,
      exec,
      targetBytes: 5 * 1024 * 1024,
    })

    assert.equal(result.resized, true)
    assert.deepEqual(Array.from(result.buffer.subarray(0, 4)), [0xff, 0xd8, 0xff, 0xe0])
    assert.equal(result.mimeType, 'image/jpeg')
  })

  it('falls back to original buffer with a warning when Pillow is missing (exit 127)', async () => {
    const filePath = path.join(tmp, 'big.jpg')
    writeFileSync(filePath, Buffer.alloc(8 * 1024 * 1024, 0x00))

    const exec = async () => ({ stdout: '', stderr: 'no module Pillow', exitCode: 127 })

    const result = await resizeImageForVision({
      filePath,
      fs: runtime.fs,
      workspaceRoot: tmp,
      exec,
      targetBytes: 5 * 1024 * 1024,
    })

    assert.equal(result.resized, false)
    assert.equal(result.buffer.length, 8 * 1024 * 1024)
    assert.match(result.warnings[0] ?? '', /Pillow is not installed/)
  })

  it('emits a "best effort" warning when Pillow returns exit 2 (could not fit)', async () => {
    const filePath = path.join(tmp, 'huge.jpg')
    writeFileSync(filePath, Buffer.alloc(8 * 1024 * 1024, 0x00))
    const fakeResizedBuffer = Buffer.alloc(6 * 1024 * 1024, 0xff)
    let resizedOutPath: string | undefined

    const exec = async (params: { env?: Record<string, string> }) => {
      const out = params.env?.LIGHTCLAW_RESIZE_OUT
      if (out && !resizedOutPath) {
        resizedOutPath = out
        await runtime.fs.writeFile(out, fakeResizedBuffer)
      }
      return { stdout: '64x64@q50=6291456', stderr: '', exitCode: 2 }
    }

    const result = await resizeImageForVision({
      filePath,
      fs: runtime.fs,
      workspaceRoot: tmp,
      exec,
      targetBytes: 5 * 1024 * 1024,
    })

    assert.equal(result.resized, true)
    assert.equal(result.buffer.length, 6 * 1024 * 1024)
    assert.match(result.warnings[0] ?? '', /best-effort/)
  })
})
