import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { lsTool } from './ls.js'
import { isToolVisibleToRole } from '../agents/role-tool-gate.js'
import { getMainRole } from '../agents/registry.js'
import { BUNDLED_AGENTS } from '../agents/bundled/index.js'
import type { ToolCallContext } from '../tool.js'

type ExecResult = { stdout: string; stderr: string; exitCode: number }

function buildCtx(execImpl: () => Promise<ExecResult>): {
  ctx: ToolCallContext
  commands: string[]
  cwds: string[]
} {
  const commands: string[] = []
  const cwds: string[] = []
  const ctx = {
    abortSignal: new AbortController().signal,
    runtime: {
      workspaceRoot: '/fake/workspace',
      async exec(input: { command: string; cwd: string }) {
        commands.push(input.command)
        cwds.push(input.cwd)
        return execImpl()
      },
    },
  } as unknown as ToolCallContext
  return { ctx, commands, cwds }
}

describe('LS via ls -1Ap', () => {
  it('lists entries with directories grouped before files', async () => {
    const { ctx } = buildCtx(async () => ({
      stdout: 'topfile_b.txt\nsubdir1/\ntopfile_a.txt\nsubdir2/\n',
      stderr: '',
      exitCode: 0,
    }))
    const result = await lsTool.call({}, ctx)
    assert.equal(result.isError, undefined)
    // dirs first (ls alpha order preserved within each group), then files
    assert.equal(result.output, 'subdir1/\nsubdir2/\ntopfile_b.txt\ntopfile_a.txt')
  })

  it('runs `ls -1Ap -- <dir>` against workspace root by default', async () => {
    const { ctx, commands, cwds } = buildCtx(async () => ({
      stdout: 'a.txt',
      stderr: '',
      exitCode: 0,
    }))
    await lsTool.call({}, ctx)
    assert.equal(commands.length, 1)
    assert.equal(commands[0], `ls -1Ap -- '/fake/workspace'`)
    assert.equal(cwds[0], '/fake/workspace')
  })

  it('resolves a relative path against the workspace root', async () => {
    const { ctx, commands } = buildCtx(async () => ({
      stdout: 'x',
      stderr: '',
      exitCode: 0,
    }))
    await lsTool.call({ path: 'sub/dir' }, ctx)
    assert.equal(commands[0], `ls -1Ap -- '/fake/workspace/sub/dir'`)
  })

  it('passes an absolute path through unchanged', async () => {
    const { ctx, commands } = buildCtx(async () => ({
      stdout: 'x',
      stderr: '',
      exitCode: 0,
    }))
    await lsTool.call({ path: '/etc' }, ctx)
    assert.equal(commands[0], `ls -1Ap -- '/etc'`)
  })

  it('returns a friendly message for an empty directory', async () => {
    const { ctx } = buildCtx(async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    const result = await lsTool.call({ path: '/empty' }, ctx)
    assert.equal(result.isError, undefined)
    assert.match(result.output, /\/empty is empty\./)
  })

  it('surfaces ls stderr as isError on a non-zero exit', async () => {
    const { ctx } = buildCtx(async () => ({
      stdout: '',
      stderr: 'ls: cannot access /nope: No such file or directory',
      exitCode: 2,
    }))
    const result = await lsTool.call({ path: '/nope' }, ctx)
    assert.equal(result.isError, true)
    assert.match(result.output, /cannot access/)
  })

  it('truncates beyond limit with a hint', async () => {
    const entries = Array.from({ length: 250 }, (_, i) => `f${i}.txt`).join('\n')
    const { ctx } = buildCtx(async () => ({ stdout: entries, stderr: '', exitCode: 0 }))
    const result = await lsTool.call({ path: '/big', limit: 200 }, ctx)
    assert.match(result.output, /\[showing first 200 of 250 entries/)
    assert.match(result.output, /use Glob with a pattern to narrow/)
  })
})

describe('LS visibility is bound to Glob scope', () => {
  it('is visible to main (a Glob-having role)', () => {
    assert.equal(isToolVisibleToRole(getMainRole(), 'LS'), true)
  })

  it('is visible to every bundled role that can see Glob, and invisible to the rest', () => {
    for (const role of BUNDLED_AGENTS) {
      const lsVisible = isToolVisibleToRole(role, 'LS')
      const globVisible = isToolVisibleToRole(role, 'Glob')
      assert.equal(
        lsVisible,
        globVisible,
        `LS visibility (${lsVisible}) must track Glob visibility (${globVisible}) for role ${role.agentType}`,
      )
    }
  })
})
