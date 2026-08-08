import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { bashTool } from './bash.js'
import {
  _resetTrackedCwdForTest,
  buildCwdProbePath,
  wrapCommandWithCwdProbe,
} from './bash-cwd.js'
import { LocalRuntime } from '../runtime/local.js'
import { loadMetaFromDir, saveMeta } from '../session/storage.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import type { SessionContext } from '../session-context.js'
import type { ToolCallContext } from '../tool.js'
import type { ExecInput } from '../runtime/types.js'
import type { SessionMeta } from '../types.js'

function makeTempDirs(): { workspace: string; sessions: string; memory: string; root: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'lc-bash-cwd-'))
  const workspace = path.join(root, 'workspace')
  const sessions = path.join(root, 'sessions')
  const memory = path.join(root, 'memory')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(sessions, { recursive: true })
  mkdirSync(memory, { recursive: true })
  return { workspace, sessions, memory, root }
}

function makeSessionCtx(input: {
  workspace: string
  sessions: string
  memory: string
  sessionId: string
}): SessionContext {
  return createSessionContext({
    cwd: input.workspace,
    model: 'test-model',
    sessionsDir: input.sessions,
    memoryDir: input.memory,
    sessionId: input.sessionId,
  })
}

function makeToolCtx(runtime: LocalRuntime): ToolCallContext {
  return {
    cwd: runtime.workspaceRoot,
    abortSignal: new AbortController().signal,
    runtime,
  } as ToolCallContext
}

function baseMeta(sessionId: string, cwd: string): SessionMeta {
  return {
    sessionId,
    model: 'test-model',
    cwd,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    messageCount: 0,
    compactionCount: 0,
  }
}

describe('Bash cwd persistence', () => {
  let dirs: ReturnType<typeof makeTempDirs>

  beforeEach(() => {
    _resetTrackedCwdForTest()
    dirs = makeTempDirs()
  })

  afterEach(() => {
    rmSync(dirs.root, { recursive: true, force: true })
  })

  it('a cd in one call changes where the next call runs', async () => {
    mkdirSync(path.join(dirs.workspace, 'sub'))
    const runtime = new LocalRuntime(dirs.workspace)
    const ctx = makeSessionCtx({ ...dirs, sessionId: 'cwd-test-1' })

    await runWithSessionContext(ctx, async () => {
      const first = await bashTool.call({ command: 'cd sub' }, makeToolCtx(runtime))
      assert.match(first.output, /exit_code: 0/)

      const second = await bashTool.call({ command: 'pwd' }, makeToolCtx(runtime))
      assert.match(second.output, /exit_code: 0/)
      assert.ok(
        second.output.includes(path.join(dirs.workspace, 'sub')),
        `expected pwd to report the sub directory, got:\n${second.output}`,
      )
    })
  })

  it('falls back to the workspace root with a notice when the tracked dir disappears', async () => {
    const sub = path.join(dirs.workspace, 'doomed')
    mkdirSync(sub)
    const runtime = new LocalRuntime(dirs.workspace)
    const ctx = makeSessionCtx({ ...dirs, sessionId: 'cwd-test-2' })

    await runWithSessionContext(ctx, async () => {
      await bashTool.call({ command: 'cd doomed' }, makeToolCtx(runtime))
      rmSync(sub, { recursive: true, force: true })

      const result = await bashTool.call({ command: 'pwd' }, makeToolCtx(runtime))
      assert.match(result.output, /no longer exists; running from the workspace root/)
      assert.ok(
        result.output.includes(`stdout:\n${dirs.workspace}`),
        `expected pwd to report the workspace root, got:\n${result.output}`,
      )
    })
  })

  it('persists the tracked cwd to session meta and restores it after a memory reset', async () => {
    mkdirSync(path.join(dirs.workspace, 'durable'))
    const runtime = new LocalRuntime(dirs.workspace)
    const sessionId = 'cwd-test-3'
    const ctx = makeSessionCtx({ ...dirs, sessionId })

    await runWithSessionContext(ctx, async () => {
      await saveMeta(sessionId, baseMeta(sessionId, dirs.workspace))
      await bashTool.call({ command: 'cd durable' }, makeToolCtx(runtime))

      const meta = await loadMetaFromDir(dirs.sessions, sessionId)
      assert.equal(meta?.bashCwd, path.join(dirs.workspace, 'durable'))

      // Simulate a daemon restart: in-memory tracking gone, meta survives.
      _resetTrackedCwdForTest()
      const result = await bashTool.call({ command: 'pwd' }, makeToolCtx(runtime))
      assert.ok(
        result.output.includes(path.join(dirs.workspace, 'durable')),
        `expected restored cwd after memory reset, got:\n${result.output}`,
      )
    })
  })

  it('does not create a session dir just to mirror the cwd', async () => {
    mkdirSync(path.join(dirs.workspace, 'sub'))
    const runtime = new LocalRuntime(dirs.workspace)
    const sessionId = 'cwd-test-4'
    const ctx = makeSessionCtx({ ...dirs, sessionId })

    await runWithSessionContext(ctx, async () => {
      // No saveMeta beforehand — the meta mirror must skip, not mkdir.
      await bashTool.call({ command: 'cd sub' }, makeToolCtx(runtime))
      const meta = await loadMetaFromDir(dirs.sessions, sessionId)
      assert.equal(meta, null)

      // In-memory tracking still works within the process.
      const result = await bashTool.call({ command: 'pwd' }, makeToolCtx(runtime))
      assert.ok(result.output.includes(path.join(dirs.workspace, 'sub')))
    })
  })

  it('runs the raw command outside a session scope (stateless fallback)', async () => {
    const seen: ExecInput[] = []
    const toolCtx = {
      cwd: '/fake/workspace',
      abortSignal: new AbortController().signal,
      runtime: {
        workspaceRoot: '/fake/workspace',
        async exec(input: ExecInput) {
          seen.push(input)
          return { stdout: 'ok', stderr: '', exitCode: 0 }
        },
      },
    } as unknown as ToolCallContext

    const result = await bashTool.call({ command: 'echo hi' }, toolCtx)
    assert.match(result.output, /exit_code: 0/)
    assert.equal(seen.length, 1)
    assert.equal(seen[0]?.command, 'echo hi')
  })
})

describe('wrapCommandWithCwdProbe', () => {
  it('preserves the wrapped command exit code and skips cd at the workspace root', () => {
    const wrapped = wrapCommandWithCwdProbe({
      command: 'exit 42',
      cwd: '/ws',
      workspaceRoot: '/ws',
      probeFile: '/ws/.lightclaw/exec/u-1.cwd',
    })
    assert.ok(!wrapped.startsWith('cd '), 'no cd prelude at workspace root')
    assert.match(wrapped, /exit "\$__lc_cwd_rc"/)
  })

  it('prefixes a guarded cd when the tracked cwd differs from the workspace root', () => {
    const wrapped = wrapCommandWithCwdProbe({
      command: 'pwd',
      cwd: '/ws/sub dir',
      workspaceRoot: '/ws',
      probeFile: '/ws/.lightclaw/exec/u-2.cwd',
    })
    assert.match(wrapped, /^cd '\/ws\/sub dir' 2>\/dev\/null \|\| \{/)
    assert.match(wrapped, /no longer exists; running from the workspace root/)
  })

  it('tolerates a background-suffixed command via the newline before the brace close', () => {
    const wrapped = wrapCommandWithCwdProbe({
      command: 'sleep 1 &',
      cwd: '/ws',
      workspaceRoot: '/ws',
      probeFile: '/ws/.lightclaw/exec/u-3.cwd',
    })
    assert.match(wrapped, /\{ sleep 1 &\n\}/)
  })

  it('buildCwdProbePath sanitizes the user prefix and lands under .lightclaw/exec', () => {
    const probe = buildCwdProbePath('/ws', 'user/../evil')
    assert.ok(probe.startsWith('/ws/.lightclaw/exec/user____evil-'))
    assert.ok(probe.endsWith('.cwd'))
  })
})
