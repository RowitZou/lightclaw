import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildApprovalWelcomeCard } from './welcome-card.js'

// 07-10 review §1.9: on a BYO-only deployment a freshly-approved user has no
// usable model, and the default welcome's "just send a message to begin" is a
// trap — the first message only earns a "no model" warning. The `noModel`
// variant must lead with the two-step /config setup instead.
describe('buildApprovalWelcomeCard noModel variant', () => {
  it('leads with the /config setup steps when the user has no model', () => {
    const rendered = JSON.stringify(buildApprovalWelcomeCard({ noModel: true }))
    assert.ok(rendered.includes('/config endpoint'), 'must name the endpoint step')
    assert.ok(rendered.includes('/config backend'), 'must name the backend step')
  })

  it('keeps the admin noModel variant admin-flavored', () => {
    const rendered = JSON.stringify(buildApprovalWelcomeCard({ isAdmin: true, noModel: true }))
    assert.ok(rendered.includes('/config endpoint'))
    assert.ok(rendered.includes('/admin'), 'admin variant keeps the /admin command pointer')
  })

  it('leaves the normal welcome untouched when a model exists', () => {
    const nonAdmin = JSON.stringify(buildApprovalWelcomeCard({}))
    const admin = JSON.stringify(buildApprovalWelcomeCard({ isAdmin: true }))
    assert.ok(!nonAdmin.includes('/config endpoint'))
    assert.ok(!admin.includes('/config endpoint'))
  })
})
