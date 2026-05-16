import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { getAllTools } from '../tools.js'
import { buildNotifyCard, notifyTool } from './notify.js'

describe('Notify tool', () => {
  it('registers in the builtin catalog', () => {
    assert.equal(getAllTools().some(tool => tool.name === 'Notify'), true)
  })

  it('validates severity and target enums', () => {
    assert.equal(notifyTool.inputSchema?.safeParse({
      title: 'Quota warning',
      body: 'API quota crossed 80%.',
      severity: 'warning',
      target: 'user-dm',
    }).success, true)
    assert.equal(notifyTool.inputSchema?.safeParse({
      title: 'Bad',
      body: 'Nope',
      severity: 'success',
      target: 'admin-dm',
    }).success, false)
  })

  it('maps severity to Feishu card header colors', () => {
    assert.equal((buildNotifyCard({
      title: 'Info',
      body: 'Done.',
      severity: 'info',
    }).header as { template: string }).template, 'green')
    assert.equal((buildNotifyCard({
      title: 'Warning',
      body: 'Look soon.',
      severity: 'warning',
    }).header as { template: string }).template, 'yellow')
    assert.equal((buildNotifyCard({
      title: 'Urgent',
      body: 'Look now.',
      severity: 'urgent',
    }).header as { template: string }).template, 'red')
  })
})

