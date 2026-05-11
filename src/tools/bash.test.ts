import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { bashTool } from './bash.js'
import type { ToolCallContext } from '../tool.js'

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
})
