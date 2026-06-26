import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { globTool } from './glob.js'
import type { ToolCallContext } from '../tool.js'
import { runWithSessionContext } from '../session-context.js'
import type { SessionContext } from '../session-context.js'

type ExecResult = { stdout: string; stderr: string; exitCode: number }

function buildCtx(execImpl: () => Promise<ExecResult>): ToolCallContext {
  return {
    abortSignal: new AbortController().signal,
    runtime: {
      workspaceRoot: '/fake/workspace',
      async exec() {
        return execImpl()
      },
    },
  } as unknown as ToolCallContext
}

// Captures the rg command string so tests can assert which flags were emitted.
function buildCapturingCtx(
  execImpl: () => Promise<ExecResult>,
): { ctx: ToolCallContext; commands: string[] } {
  const commands: string[] = []
  const ctx = {
    abortSignal: new AbortController().signal,
    runtime: {
      workspaceRoot: '/fake/workspace',
      async exec(input: { command: string }) {
        commands.push(input.command)
        return execImpl()
      },
    },
  } as unknown as ToolCallContext
  return { ctx, commands }
}

// Minimal ALS stub: callerCanDispatchLocalExplorer() only reads
// currentRole.reachableRoles, mirroring the existing `as unknown as` pattern.
function withRole<T>(
  reachableRoles: string[] | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return runWithSessionContext(
    { currentRole: { reachableRoles } } as unknown as SessionContext,
    fn,
  )
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

  it('passes maxDepth through to rg as --max-depth', async () => {
    const { ctx, commands } = buildCapturingCtx(async () => ({
      stdout: 'foo.ts',
      stderr: '',
      exitCode: 0,
    }))
    await globTool.call({ pattern: '*', maxDepth: 1 }, ctx)
    assert.equal(commands.length, 1)
    assert.match(commands[0], /--max-depth' '1'/)
  })

  it('omits --max-depth when maxDepth is not provided', async () => {
    const { ctx, commands } = buildCapturingCtx(async () => ({
      stdout: 'foo.ts',
      stderr: '',
      exitCode: 0,
    }))
    await globTool.call({ pattern: '**/*.ts' }, ctx)
    assert.equal(commands.length, 1)
    assert.doesNotMatch(commands[0], /--max-depth/)
  })

  it('truncation trailer signposts maxDepth as a way to bound the result', async () => {
    const lines = Array.from({ length: 150 }, (_, i) => `f${i}.ts`).join('\n')
    const ctx = buildCtx(async () => ({ stdout: lines, stderr: '', exitCode: 0 }))
    const result = await globTool.call({ pattern: '**/*.ts', limit: 100 }, ctx)
    assert.match(result.output, /maxDepth/)
  })

  it('truncation trailer suggests localExplorer only when the role can dispatch it', async () => {
    const lines = Array.from({ length: 150 }, (_, i) => `f${i}.ts`).join('\n')
    const ctx = buildCtx(async () => ({ stdout: lines, stderr: '', exitCode: 0 }))

    // main / dispatcher role (reachableRoles includes '*' or localExplorer)
    const reachable = await withRole(['*'], () =>
      globTool.call({ pattern: '**/*.ts', limit: 100 }, ctx),
    )
    assert.match(reachable.output, /dispatch localExplorer/)

    // leaf role (no reachableRoles) gets no dispatch suggestion
    const leaf = await withRole(undefined, () =>
      globTool.call({ pattern: '**/*.ts', limit: 100 }, ctx),
    )
    assert.doesNotMatch(leaf.output, /dispatch localExplorer/)
  })

  it('returns a Bash-fallback hint when rg is not installed (exit 127)', async () => {
    const ctx = buildCtx(async () => ({
      stdout: '',
      stderr: 'sh: 1: rg: command not found',
      exitCode: 127,
    }))
    const result = await globTool.call({ pattern: '**/*.ts' }, ctx)
    assert.equal(result.isError, true)
    assert.match(result.output, /rg not found/)
    assert.match(result.output, /Bash/)
    assert.match(result.output, /find/)
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
