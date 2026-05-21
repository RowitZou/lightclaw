import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { z } from 'zod'

import {
  awaitAbortable,
  dispatchToolCall,
  throwIfAborted,
  type DispatchContext,
  type ToolUseBlock,
} from './query-tool-dispatch.js'
import { createSessionContext, runWithSessionContext } from './session-context.js'
import { installTestConfigHome } from './test-support/config-fixture.js'
import { buildTool, type ToolCallResult } from './tool.js'
import type { LightClawConfig } from './config.js'
import type { Runtime } from './runtime/types.js'

describe('throwIfAborted', () => {
  it('throws with the canonical abort message when the signal is aborted', () => {
    const controller = new AbortController()
    controller.abort()
    assert.throws(() => throwIfAborted(controller.signal), /Request was aborted/)
  })

  it('is a no-op when the signal is not aborted', () => {
    assert.doesNotThrow(() => throwIfAborted(new AbortController().signal))
  })
})

describe('awaitAbortable', () => {
  it('rejects promptly when an in-flight operation ignores AbortSignal', async () => {
    const controller = new AbortController()
    const started = Date.now()
    const pending = awaitAbortable(new Promise<string>(() => {}), controller.signal)

    setTimeout(() => controller.abort(), 10)

    await assert.rejects(pending, /Request was aborted/)
    assert.ok(
      Date.now() - started < 500,
      'abort wrapper must not wait for the underlying promise to settle',
    )
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    await assert.rejects(
      awaitAbortable(Promise.resolve('late'), controller.signal),
      /Request was aborted/,
    )
  })

  it('resolves with the underlying value when the signal never aborts', async () => {
    const value = await awaitAbortable(
      Promise.resolve('ok'),
      new AbortController().signal,
    )
    assert.equal(value, 'ok')
  })
})

describe('dispatchToolCall abort integration', () => {
  // dispatchToolCall's hook / permission gates call the global getConfig(),
  // which throws when no config.json exists — install a minimal one so the
  // dispatch reaches the tool call instead of bailing out early.
  let restoreConfigHome: () => void
  before(() => {
    restoreConfigHome = installTestConfigHome()
  })
  after(() => {
    restoreConfigHome()
  })

  it('preempts a tool call that ignores its abortSignal and returns an error result', async () => {
    let toolEntered = false
    let signalEntered: (() => void) | undefined
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve
    })
    const stuckTool = buildTool({
      name: 'StuckTool',
      description: 'A tool whose call never settles and ignores abortSignal.',
      domain: 'host',
      riskLevel: 'safe',
      inputSchema: z.object({}),
      call() {
        toolEntered = true
        signalEntered?.()
        // Never resolves and never checks abortSignal — the misbehaving-tool
        // case awaitAbortable exists to backstop.
        return new Promise<ToolCallResult<string>>(() => {})
      },
    })

    const controller = new AbortController()
    const ctx: DispatchContext = {
      tools: [stuckTool],
      allTools: [stuckTool],
      deferredTools: [],
      roleKind: 'orchestrator',
      maxToolOutputBytes: 10_000,
      config: {} as unknown as LightClawConfig,
      signal: controller.signal,
    }
    const toolUse: ToolUseBlock = {
      type: 'tool_use',
      id: 'call-1',
      name: 'StuckTool',
      input: {},
    }

    const sessionCtx = createSessionContext({
      cwd: '/tmp',
      model: 'test-model',
      sessionsDir: '/tmp/sessions',
      memoryDir: '/tmp/memory',
      sessionId: 'feishu:dm:stuck-tool-test',
      permissionMode: 'bypassPermissions',
      runtime: {} as unknown as Runtime,
    })

    const started = Date.now()
    const dispatch = runWithSessionContext(sessionCtx, () =>
      dispatchToolCall(toolUse, ctx),
    )
    // Abort only once the stuck tool is actually inside call(). A fixed-delay
    // timer would race the hook + permission gates that run before the tool
    // is entered — on a slow/cold run the abort lands during those gates and
    // the tool is never reached.
    await entered
    controller.abort()
    const result = await dispatch

    assert.equal(toolEntered, true, 'the stuck tool call should have been entered')
    assert.ok(
      Date.now() - started < 1000,
      '/stop must not wait for a stuck tool call to settle',
    )
    assert.equal(result.type, 'tool_result')
    assert.equal(result.tool_use_id, 'call-1')
    assert.equal(result.is_error, true)
    assert.match(
      typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
      /Request was aborted/,
    )
  })
})
