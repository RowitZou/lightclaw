import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { safeWriteFile, safeWriteJson } from './atomic-write.js'

let workdir: string

beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), 'lightclaw-atomic-'))
})

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true })
})

describe('safeWriteFile', () => {
  it('writes string content to the target path', () => {
    const target = path.join(workdir, 'out.txt')
    safeWriteFile(target, 'hello\n')
    assert.equal(readFileSync(target, 'utf8'), 'hello\n')
  })

  it('writes Buffer content', () => {
    const target = path.join(workdir, 'out.bin')
    safeWriteFile(target, Buffer.from([0x01, 0x02, 0x03]))
    const buf = readFileSync(target)
    assert.deepEqual([...buf], [0x01, 0x02, 0x03])
  })

  it('creates parent directories recursively', () => {
    const target = path.join(workdir, 'a', 'b', 'c', 'nested.txt')
    safeWriteFile(target, 'deep')
    assert.equal(readFileSync(target, 'utf8'), 'deep')
  })

  it('leaves no .tmp files behind after a successful write', () => {
    const target = path.join(workdir, 'out.txt')
    safeWriteFile(target, 'first')
    safeWriteFile(target, 'second')
    safeWriteFile(target, 'third')
    const entries = readdirSync(workdir)
    assert.deepEqual(entries, ['out.txt'])
  })

  it('overwrites existing content via rename (no append)', () => {
    const target = path.join(workdir, 'out.txt')
    safeWriteFile(target, 'long original content')
    safeWriteFile(target, 'short')
    assert.equal(readFileSync(target, 'utf8'), 'short')
  })

  it('honors the mode option for the published file', () => {
    const target = path.join(workdir, 'secret.txt')
    safeWriteFile(target, 'sensitive', { mode: 0o600 })
    const mode = statSync(target).mode & 0o777
    assert.equal(mode, 0o600)
  })
})

describe('safeWriteJson', () => {
  it('writes pretty JSON with a trailing newline', () => {
    const target = path.join(workdir, 'data.json')
    safeWriteJson(target, { a: 1, b: [2, 3] })
    const text = readFileSync(target, 'utf8')
    assert.equal(text, '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}\n')
  })

  it('round-trips via JSON.parse', () => {
    const target = path.join(workdir, 'data.json')
    const payload = { version: 2, flags: { x: true }, list: [1, 'two', null] }
    safeWriteJson(target, payload)
    const parsed = JSON.parse(readFileSync(target, 'utf8'))
    assert.deepEqual(parsed, payload)
  })

  it('leaves no .tmp files behind across concurrent writers to the same path', async () => {
    const target = path.join(workdir, 'concurrent.json')
    // Fire 10 overlapping writes in the same tick. POSIX rename is atomic so
    // some last-writer wins, and there should be no leftover .tmp once all
    // finished.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        Promise.resolve().then(() => safeWriteJson(target, { i })),
      ),
    )
    const entries = readdirSync(workdir).sort()
    assert.deepEqual(entries, ['concurrent.json'])
    const final = JSON.parse(readFileSync(target, 'utf8')) as { i: number }
    assert.ok(typeof final.i === 'number' && final.i >= 0 && final.i < 10)
  })
})
