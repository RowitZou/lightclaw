import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { bashTool } from './bash.js'
import type { ToolCallContext } from '../tool.js'
import { FakeRuntime } from '../background-exec/test-helpers.js'
import { BackgroundJobRegistry, getBackgroundJobRegistry } from '../background-exec/registry.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'

function buildCtx(execResult: {
  stdout: string
  stderr: string
  exitCode: number
}): ToolCallContext {
  return {
    abortSignal: new AbortController().signal,
    runtime: {
      workspaceRoot: '/fake/workspace',
      async exec() {
        return execResult
      },
    },
  } as unknown as ToolCallContext
}

describe('Bash error-recovery hints', () => {
  it('exit 127 result includes command-not-found hint with the missing binary name', async () => {
    const result = await bashTool.call(
      { command: 'nonexistent-binary --help' },
      buildCtx({
        stdout: '',
        stderr: 'bash: nonexistent-binary: command not found',
        exitCode: 127,
      }),
    )
    assert.equal(result.isError, true)
    assert.match(result.output, /exit_code: 127/)
    assert.match(result.output, /\[Hint: exit 127 = command not found/)
    assert.match(result.output, /'nonexistent-binary'/)
    assert.match(result.output, /apt-get install/)
  })

  it('exit 1 (non-127) does NOT include the command-not-found hint', async () => {
    const result = await bashTool.call(
      { command: 'false' },
      buildCtx({ stdout: '', stderr: '', exitCode: 1 }),
    )
    assert.equal(result.isError, true)
    assert.match(result.output, /exit_code: 1/)
    assert.doesNotMatch(result.output, /command not found/)
  })

  it('exit 0 does not include any hint at all', async () => {
    const result = await bashTool.call(
      { command: 'echo hi' },
      buildCtx({ stdout: 'hi', stderr: '', exitCode: 0 }),
    )
    assert.equal(result.isError, undefined)
    assert.match(result.output, /stdout:\s*hi/)
    assert.doesNotMatch(result.output, /Hint/)
  })

  it('run_in_background launches a detached job and returns output file paths', async () => {
    getBackgroundJobRegistry().clear()
    const runtime = new FakeRuntime()
    runtime.queueExec({ stdout: '', stderr: '', exitCode: 0 })
    runtime.queueExec({ stdout: 'LIGHTCLAW_BG_PGID:4321\n', stderr: '', exitCode: 0 })
    const ctx = createSessionContext({
      sessionId: 's1',
      currentUserId: 'alice',
      cwd: '/workspace',
      model: 'test',
      sessionsDir: '/sessions',
      memoryDir: '/memory',
      runtime: runtime.asRuntime(),
    })

    const result = await runWithSessionContext(ctx, () =>
      bashTool.call(
        { command: 'sleep 400 && echo done', run_in_background: true },
        {
          abortSignal: new AbortController().signal,
          runtime: runtime.asRuntime(),
        } as ToolCallContext,
      )
    )

    assert.equal(result.isError, undefined)
    assert.match(result.output, /Started background Bash job bg-/)
    assert.match(result.output, /stdout: \/workspace\/\.lightclaw\/bg-exec\/bg-/)
    assert.match(runtime.execCalls[1].command, /setsid bash -c/)
    assert.equal(getBackgroundJobRegistry().listForSession('s1').length, 1)
    getBackgroundJobRegistry().clear()
  })

  it('timeout failures include the background-mode hint', async () => {
    const result = await bashTool.call(
      { command: 'git clone https://example.invalid/large.git' },
      buildCtx({
        stdout: '',
        stderr: 'command timed out after 300000ms.',
        exitCode: -1,
      }),
    )
    assert.equal(result.isError, true)
    assert.match(result.output, /run_in_background: true/)
  })
})
