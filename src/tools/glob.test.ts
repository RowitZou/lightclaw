import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { globTool } from './glob.js'
import type { ToolCallContext } from '../tool.js'

type ExecResult = { stdout: string; stderr: string; exitCode: number }

function buildCtx(
  execImpl: () => Promise<ExecResult>,
  fsImpl?: { glob?: () => Promise<string[]> },
): ToolCallContext {
  return {
    abortSignal: new AbortController().signal,
    runtime: {
      workspaceRoot: '/fake/workspace',
      async exec() {
        return execImpl()
      },
      fs: {
        async glob() {
          if (!fsImpl?.glob) {
            throw new Error('runtime.fs.glob not mocked')
          }
          return fsImpl.glob()
        },
      },
    },
  } as unknown as ToolCallContext
}

describe('Glob via ripgrep --files', () => {
  it('returns mtime-sorted matches with ./-prefix stripped', async () => {
    const ctx = buildCtx(async () => ({
      stdout: './src/old.ts\n./src/recent.ts\n',
      stderr: '',
      exitCode: 0,
    }))
    const result = await globTool.call({ pattern: '**/*.ts' }, ctx)
    assert.equal(result.isError, undefined)
    assert.equal(result.output, 'src/old.ts\nsrc/recent.ts')
  })

  it('returns a friendly no-match message when rg --files exits 0 with empty stdout', async () => {
    const ctx = buildCtx(async () => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }))
    const result = await globTool.call({ pattern: '**/*.nonexistent' }, ctx)
    assert.equal(result.isError, undefined)
    assert.match(result.output, /No files matched "\*\*\/\*\.nonexistent"/)
    assert.match(result.output, /under \/fake\/workspace/)
  })

  it('truncates output beyond limit with a hint trailer', async () => {
    const lines = Array.from({ length: 150 }, (_, i) => `f${i}.ts`).join('\n')
    const ctx = buildCtx(async () => ({
      stdout: lines,
      stderr: '',
      exitCode: 0,
    }))
    const result = await globTool.call({ pattern: '**/*.ts', limit: 100 }, ctx)
    assert.equal(result.isError, undefined)
    const outputLines = result.output.split('\n')
    assert.equal(outputLines[0], 'f0.ts')
    assert.equal(outputLines[99], 'f99.ts')
    assert.match(result.output, /\[showing first 100 of 150 matches/)
  })

  it('falls back to runtime.fs.glob when rg is not installed (exit 127)', async () => {
    const ctx = buildCtx(
      async () => ({
        stdout: '',
        stderr: 'sh: 1: rg: command not found',
        exitCode: 127,
      }),
      { async glob() { return ['src/a.ts', 'src/b.ts'] } },
    )
    const result = await globTool.call({ pattern: '**/*.ts' }, ctx)
    assert.equal(result.isError, undefined)
    assert.equal(result.output, 'src/a.ts\nsrc/b.ts')
  })

  it('reports rg errors with stderr as isError', async () => {
    const ctx = buildCtx(async () => ({
      stdout: '',
      stderr: 'rg: regex parse error: unclosed group',
      exitCode: 2,
    }))
    const result = await globTool.call({ pattern: '(' }, ctx)
    assert.equal(result.isError, true)
    assert.match(result.output, /regex parse error/)
  })

  it('uses the user-provided path as cwd when given', async () => {
    let observedCwd: string | undefined
    const ctx = {
      abortSignal: new AbortController().signal,
      runtime: {
        workspaceRoot: '/fake/workspace',
        async exec(input: { cwd: string }) {
          observedCwd = input.cwd
          return { stdout: 'foo.ts', stderr: '', exitCode: 0 }
        },
      },
    } as unknown as ToolCallContext
    await globTool.call({ pattern: '**/*.ts', path: 'sub/dir' }, ctx)
    assert.equal(observedCwd, '/fake/workspace/sub/dir')
  })

  it('respects absolute user-provided path', async () => {
    let observedCwd: string | undefined
    const ctx = {
      abortSignal: new AbortController().signal,
      runtime: {
        workspaceRoot: '/fake/workspace',
        async exec(input: { cwd: string }) {
          observedCwd = input.cwd
          return { stdout: 'foo.ts', stderr: '', exitCode: 0 }
        },
      },
    } as unknown as ToolCallContext
    await globTool.call({ pattern: '**/*.ts', path: '/other/abs' }, ctx)
    assert.equal(observedCwd, '/other/abs')
  })
})
