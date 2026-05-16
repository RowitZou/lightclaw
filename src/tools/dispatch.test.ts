import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { getAllTools } from '../tools.js'
import { dispatchTool, listDispatchesTool, updateDispatchTool } from './dispatch.js'

describe('Dispatch tool family', () => {
  it('registers all dispatch tools in the builtin catalog', () => {
    const names = new Set(getAllTools().map(tool => tool.name))
    assert.equal(names.has('Dispatch'), true)
    assert.equal(names.has('ListDispatches'), true)
    assert.equal(names.has('CancelDispatch'), true)
    assert.equal(names.has('UpdateDispatch'), true)
  })

  it('requires mode and restricts role enum', () => {
    assert.equal(dispatchTool.inputSchema?.safeParse({
      role: 'general',
      prompt: 'Do a focused task for me.',
    }).success, false)
    assert.equal(dispatchTool.inputSchema?.safeParse({
      role: 'main',
      prompt: 'Do a focused task for me.',
      mode: 'blocking',
    }).success, false)
  })

  it('accepts now-blocking and scheduled-background shapes', () => {
    assert.equal(dispatchTool.inputSchema?.safeParse({
      role: 'web',
      prompt: 'Research one current fact and report briefly.',
      schedule: 'now',
      mode: 'blocking',
    }).success, true)
    assert.equal(dispatchTool.inputSchema?.safeParse({
      role: 'general',
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
})

