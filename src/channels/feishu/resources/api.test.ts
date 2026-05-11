import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { feishuErrorMessage } from './api.js'

describe('feishuErrorMessage', () => {
  it('formats axios HTTP errors with status, body, and x-tt-logid', () => {
    const error = {
      message: 'Request failed with status code 403',
      response: {
        status: 403,
        statusText: 'Forbidden',
        data: { code: 99991663, msg: 'ScopeAccessDenied' },
        headers: { 'x-tt-logid': '20260512040000010203040506070809ab' },
      },
    }
    const msg = feishuErrorMessage(error)
    assert.match(msg, /Feishu HTTP 403 Forbidden/)
    assert.match(msg, /body=.*99991663/)
    assert.match(msg, /body=.*ScopeAccessDenied/)
    assert.match(msg, /x-tt-logid=20260512040000010203040506070809ab/)
  })

  it('handles string body responses', () => {
    const error = {
      response: {
        status: 502,
        data: 'upstream gateway timeout',
      },
    }
    const msg = feishuErrorMessage(error)
    assert.match(msg, /Feishu HTTP 502/)
    assert.match(msg, /body=upstream gateway timeout/)
  })

  it('falls back to error.message for plain Error', () => {
    assert.equal(
      feishuErrorMessage(new Error('Feishu client is only available while the Feishu channel is running.')),
      'Feishu client is only available while the Feishu channel is running.',
    )
  })

  it('falls back to String() for non-Error rejections', () => {
    assert.equal(feishuErrorMessage('boom'), 'boom')
    assert.equal(feishuErrorMessage(42), '42')
    assert.equal(feishuErrorMessage(null), 'null')
  })

  it('handles axios x-tt-log-id alternative header spelling', () => {
    const error = {
      response: {
        status: 401,
        headers: { 'x-tt-log-id': 'altSpellingLogId' },
      },
    }
    const msg = feishuErrorMessage(error)
    assert.match(msg, /x-tt-logid=altSpellingLogId/)
  })
})
