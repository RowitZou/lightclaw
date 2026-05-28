import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { bashTool } from './bash.js'
import type { ToolCallContext } from '../tool.js'
import { FakeRuntime } from '../background-exec/test-helpers.js'
import { BackgroundJobRegistry, getBackgroundJobRegistry } from '../background-exec/registry.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import type { ExecInput, ExecResult } from '../runtime/types.js'

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

class EnvCapturingRuntime extends FakeRuntime {
  override async exec(input: ExecInput): Promise<ExecResult> {
    this.execCalls.push(input)
    return {
      stdout: input.env?.GH_TOKEN ? `token=${input.env.GH_TOKEN}` : 'missing-token',
      stderr: '',
      exitCode: 0,
    }
  }
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

  it('exit 0 reports exit_code: 0 and includes no hint', async () => {
    const result = await bashTool.call(
      { command: 'echo hi' },
      buildCtx({ stdout: 'hi', stderr: '', exitCode: 0 }),
    )
    assert.equal(result.isError, undefined)
    assert.match(result.output, /stdout:\s*hi/)
    assert.match(result.output, /exit_code: 0/)
    assert.doesNotMatch(result.output, /Hint/)
  })

  it('exit 0 with only stderr (e.g. git clone progress) still reports completion', async () => {
    const result = await bashTool.call(
      { command: 'git clone https://example.com/repo.git' },
      buildCtx({ stdout: '', stderr: "Cloning into 'repo'...", exitCode: 0 }),
    )
    assert.equal(result.isError, undefined)
    assert.match(result.output, /Cloning into 'repo'/)
    assert.match(result.output, /exit_code: 0/)
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
      enabledSecrets: new Map([['GH_TOKEN', 'background-secret']]),
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
    assert.equal(runtime.execCalls[1].env?.GH_TOKEN, 'background-secret')
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

  it('sandbox-watchdog timeout also includes the background-mode hint', async () => {
    const result = await bashTool.call(
      { command: 'git clone https://example.invalid/large.git' },
      buildCtx({
        stdout: '',
        stderr: 'lightclaw: command exceeded the 300s sandbox time limit; terminating',
        exitCode: 143,
      }),
    )
    assert.equal(result.isError, true)
    assert.match(result.output, /run_in_background: true/)
  })

  it('regression: injects enabled secrets via ExecInput.env without putting values in model-visible command text', async () => {
    const secretValue = 'ghp_extremely_secret_dogfood_value_xyz'
    const command = 'echo "$GH_TOKEN"'
    const runtime = new EnvCapturingRuntime()
    const ctx = createSessionContext({
      sessionId: 'secret-session',
      currentUserId: 'alice',
      cwd: '/workspace',
      model: 'test',
      sessionsDir: '/sessions',
      memoryDir: '/memory',
      enabledSecrets: new Map([['GH_TOKEN', secretValue]]),
      runtime: runtime.asRuntime(),
    })

    const result = await runWithSessionContext(ctx, () =>
      bashTool.call(
        { command },
        {
          abortSignal: new AbortController().signal,
          runtime: runtime.asRuntime(),
        } as ToolCallContext,
      )
    )

    const modelVisiblePayload = JSON.stringify({
      transcript: [{ type: 'tool_use', name: 'Bash', input: { command } }],
      apiLog: { request: { messages: [{ role: 'assistant', content: command }] } },
    })
    assert.equal(modelVisiblePayload.includes(secretValue), false)
    assert.equal(runtime.execCalls[0].command.includes(secretValue), false)
    assert.equal(runtime.execCalls[0].env?.GH_TOKEN, secretValue)
    assert.match(result.output, new RegExp(secretValue))
  })
})
