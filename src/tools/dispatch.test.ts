import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { builtinTools, getAllTools } from '../tools.js'
import { partitionTools } from './is-deferred.js'
import { dispatchTool, listDispatchesTool, updateDispatchTool } from './dispatch.js'

describe('Dispatch tool family', () => {
  it('registers all dispatch tools in the builtin catalog', () => {
    const names = new Set(getAllTools().map(tool => tool.name))
    assert.equal(names.has('Dispatch'), true)
    assert.equal(names.has('ListDispatches'), true)
    assert.equal(names.has('CancelDispatch'), true)
    assert.equal(names.has('UpdateDispatch'), true)
  })

  it('requires mode but accepts open role strings (orchestrator / internal / unknown rejected at runtime)', () => {
    // mode is required by the schema
    assert.equal(dispatchTool.inputSchema?.safeParse({
      role: 'generalist',
      prompt: 'Do a focused task for me.',
    }).success, false)
    // role is z.string().min(1) so user-defined names (or any string) parse;
    // runtime executeDispatch rejects orchestrator / internal / unknown roles.
    // See "rejects orchestrator / internal / unknown dispatch targets at runtime".
    assert.equal(dispatchTool.inputSchema?.safeParse({
      role: 'paper-coordinator',
      prompt: 'Do a focused task for me.',
      mode: 'blocking',
    }).success, true)
    assert.equal(dispatchTool.inputSchema?.safeParse({
      role: 'main',
      prompt: 'Do a focused task for me.',
      mode: 'blocking',
    }).success, true)
  })

  it('accepts now-blocking and scheduled-background shapes', () => {
    assert.equal(dispatchTool.inputSchema?.safeParse({
      role: 'webSearcher',
      prompt: 'Research one current fact and report briefly.',
      schedule: 'now',
      mode: 'blocking',
    }).success, true)
    assert.equal(dispatchTool.inputSchema?.safeParse({
      role: 'generalist',
      prompt: 'Check this later and report back.',
      schedule: { kind: 'after', afterMinutes: 5 },
      mode: 'background',
      allowed_tools: ['Read(*)'],
    }).success, true)
  })

  it('accepts an optional attachments array of absolute paths', () => {
    assert.equal(dispatchTool.inputSchema?.safeParse({
      role: 'webSearcher',
      prompt: 'Translate this PDF excerpt.',
      schedule: 'now',
      mode: 'blocking',
      attachments: ['/tmp/ws/.lightclaw/inbox/c/foo.pdf'],
    }).success, true)
    assert.equal(dispatchTool.inputSchema?.safeParse({
      role: 'webSearcher',
      prompt: 'No attachments here.',
      schedule: 'now',
      mode: 'blocking',
    }).success, true)
    assert.equal(dispatchTool.inputSchema?.safeParse({
      role: 'webSearcher',
      prompt: 'Empty string entries are rejected.',
      schedule: 'now',
      mode: 'blocking',
      attachments: [''],
    }).success, false)
  })

  it('keeps notify fields out of Dispatch and UpdateDispatch schemas', () => {
    assert.equal(dispatchTool.description.includes('notify_to'), false)
    assert.equal(updateDispatchTool.description.includes('notify_to'), false)
    assert.equal(listDispatchesTool.description.includes('notify_to'), false)
  })

  it('keeps the retired context-inheritance field out of the Dispatch schema output', () => {
    const retiredKey = 'resume' + 'From'
    const parsed = dispatchTool.inputSchema?.parse({
      role: 'webSearcher',
      prompt: 'Research one current fact and report briefly.',
      schedule: 'now',
      mode: 'blocking',
      [retiredKey]: 'last',
    }) as Record<string, unknown>

    assert.equal(Object.hasOwn(parsed, retiredKey), false)
  })

  it('Dispatch is inline; its management trio stays deferred', () => {
    // Dispatch is the orchestrator's core per-turn verb. Keeping it behind
    // ToolSearch (shouldDefer) imposed a search → wait → call round-trip that
    // suppressed delegation, so it is alwaysLoad. The post-hoc management tools
    // are genuinely low-frequency and stay deferred. This pins both sides so a
    // future tag churn can't silently re-defer Dispatch.
    const { alwaysLoaded, deferred } = partitionTools(builtinTools)
    const inlineNames = new Set(alwaysLoaded.map(tool => tool.name))
    const deferredNames = new Set(deferred.map(tool => tool.name))
    assert.equal(inlineNames.has('Dispatch'), true)
    for (const name of ['ListDispatches', 'CancelDispatch', 'UpdateDispatch']) {
      assert.equal(deferredNames.has(name), true)
    }
  })
})
