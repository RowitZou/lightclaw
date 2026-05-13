import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { classifyFeishuError, FeishuApiError } from './errors.js'

describe('classifyFeishuError', () => {
  it('classifies scope-missing from permission violations', () => {
    const c = classifyFeishuError(axiosLike({
      status: 400,
      data: {
        code: 99991672,
        msg: 'Access denied. One of the following scopes is required: [drive:drive]',
        error: {
          log_id: 'scope-log',
          permission_violations: [{ type: 'action_scope_required', subject: 'drive:drive' }],
        },
      },
      headers: { 'x-tt-logid': 'scope-log' },
    }))
    assert.equal(c.kind, 'scope-missing')
    assert.equal(c.admin, true)
    assert.equal(c.retryable, false)
    assert.deepEqual(c.scopeMissing?.requiredScopes, ['drive:drive'])
    assert.match(c.agentMessage, /Required scopes: drive:drive/)
  })

  it('classifies auth-failure', () => {
    const c = classifyFeishuError(axiosLike({
      status: 401,
      data: { code: 99991543, msg: 'invalid app credentials' },
    }))
    assert.equal(c.kind, 'auth-failure')
    assert.equal(c.admin, true)
    assert.match(c.adminMessage, /channels\.json/)
  })

  it('classifies rate-limited by code and HTTP 429', () => {
    assert.equal(classifyFeishuError(axiosLike({
      status: 400,
      data: { code: 90217, msg: 'too many requests' },
    })).kind, 'rate-limited')
    assert.equal(classifyFeishuError(axiosLike({
      status: 429,
      data: { code: 1, msg: 'too many requests' },
    })).kind, 'rate-limited')
  })

  it('classifies validation-failed and renders field violations', () => {
    const c = classifyFeishuError(axiosLike({
      status: 400,
      data: {
        code: 99992402,
        msg: 'field validation failed',
        error: {
          field_violations: [{ field: 'member_type', value: 'chatid', description: 'expected openchat' }],
        },
      },
    }))
    assert.equal(c.kind, 'validation-failed')
    assert.match(c.agentMessage, /field=member_type value="chatid" description=expected openchat/)
  })

  it('classifies already-exists', () => {
    assert.equal(classifyFeishuError(axiosLike({
      status: 400,
      data: { code: 1061004, msg: 'member has already been added' },
    })).kind, 'already-exists')
  })

  it('classifies not-found', () => {
    assert.equal(classifyFeishuError(axiosLike({
      status: 404,
      data: { code: 90304, msg: 'file deleted' },
    })).kind, 'not-found')
  })

  it('classifies permission-denied', () => {
    assert.equal(classifyFeishuError(axiosLike({
      status: 403,
      data: { code: 91002, msg: 'permission denied' },
    })).kind, 'permission-denied')
  })

  it('classifies internal-server', () => {
    assert.equal(classifyFeishuError(axiosLike({
      status: 500,
      data: { code: 1500, msg: 'internal error' },
    })).kind, 'internal-server')
    assert.equal(classifyFeishuError(axiosLike({
      status: 400,
      data: { code: 95201, msg: 'docx service error' },
    })).kind, 'internal-server')
  })

  it('classifies transient-network', () => {
    const error = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
    const c = classifyFeishuError(error)
    assert.equal(c.kind, 'transient-network')
    assert.equal(c.retryable, true)
  })

  it('classifies withdrawn-target', () => {
    assert.equal(classifyFeishuError(axiosLike({
      status: 400,
      data: { code: 230011, msg: 'message has been withdrawn' },
    })).kind, 'withdrawn-target')
  })

  it('falls back to unknown and unwraps FeishuApiError', () => {
    const unknown = classifyFeishuError(new Error('totally unrelated'))
    assert.equal(unknown.kind, 'unknown')
    assert.equal(classifyFeishuError(new FeishuApiError(unknown)), unknown)
  })
})

function axiosLike(input: {
  status: number
  statusText?: string
  data: unknown
  headers?: Record<string, unknown>
}): unknown {
  return {
    message: `Request failed with status code ${input.status}`,
    response: input,
  }
}
