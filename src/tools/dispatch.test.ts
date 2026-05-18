import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { getAllTools } from '../tools.js'
import { dispatchTool, listDispatchesTool, resolveEffectiveResumeFrom, updateDispatchTool } from './dispatch.js'

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

  it('keeps notify fields out of Dispatch and UpdateDispatch schemas', () => {
    assert.equal(dispatchTool.description.includes('notify_to'), false)
    assert.equal(updateDispatchTool.description.includes('notify_to'), false)
    assert.equal(listDispatchesTool.description.includes('notify_to'), false)
  })

  it('resolves defaultResumePolicy without regressing explicit caller resumeFrom', () => {
    assert.equal(resolveEffectiveResumeFrom({}, 'dispatch-1'), 'dispatch-1')
    assert.equal(resolveEffectiveResumeFrom({ defaultResumePolicy: 'always' }, undefined), 'last')
    assert.equal(resolveEffectiveResumeFrom({ defaultResumePolicy: 'always' }, 'dispatch-2'), 'dispatch-2')
    assert.equal(resolveEffectiveResumeFrom({ defaultResumePolicy: 'never' }, 'dispatch-3'), undefined)
    assert.equal(resolveEffectiveResumeFrom({ defaultResumePolicy: 'auto' }, 'dispatch-4'), undefined)
  })
})
