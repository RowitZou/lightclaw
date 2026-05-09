import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { LocalRuntime } from '../runtime/local.js'
import type { ToolCallContext } from '../tool.js'

import { inspectImageTool } from './image-inspect.js'

let tmp: string
let runtime: LocalRuntime

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'lightclaw-image-inspect-'))
  runtime = new LocalRuntime(tmp)
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('InspectImage', () => {
  it('rejects non-image files before calling a provider', async () => {
    await runtime.fs.writeFile('note.txt', 'hello')
    const result = await inspectImageTool.call({ file_path: 'note.txt' }, context())

    assert.equal(result.isError, true)
    assert.match(String(result.output), /supported image/)
  })
})

function context(): ToolCallContext {
  return {
    cwd: tmp,
    abortSignal: new AbortController().signal,
    runtime,
  }
}

