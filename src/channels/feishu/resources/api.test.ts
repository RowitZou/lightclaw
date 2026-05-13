import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  callFeishu,
  detectFeishuScopeMissing,
  feishuErrorMessage,
  formatFeishuScopeMissing,
} from './api.js'

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

describe('detectFeishuScopeMissing', () => {
  // Real body shape captured from the 2026-05-12 drive:drive incident.
  const realDriveError = {
    response: {
      status: 400,
      data: {
        code: 99991672,
        msg: 'Access denied. One of the following scopes is required: [drive:drive, drive:drive:readonly, space:document:retrieve].应用尚未开通所需的应用身份权限：[drive:drive, drive:drive:readonly, space:document:retrieve]',
        error: {
          log_id: '202605122210452C42A410F7F77D7E3BE8',
          permission_violations: [
            { type: 'action_scope_required', subject: 'drive:drive' },
            { type: 'action_scope_required', subject: 'drive:drive:readonly' },
            { type: 'action_scope_required', subject: 'space:document:retrieve' },
          ],
        },
      },
      headers: { 'x-tt-logid': '202605122210452C42A410F7F77D7E3BE8' },
    },
  }

  it('extracts required scopes from structured permission_violations', () => {
    const info = detectFeishuScopeMissing(realDriveError)
    assert.ok(info, 'expected scope-missing detection')
    assert.deepEqual(info.requiredScopes, [
      'drive:drive',
      'drive:drive:readonly',
      'space:document:retrieve',
    ])
    assert.equal(info.logId, '202605122210452C42A410F7F77D7E3BE8')
  })

  it('falls back to bracketed-list parsing when permission_violations is absent', () => {
    const info = detectFeishuScopeMissing({
      response: {
        status: 400,
        data: {
          code: 99999999,
          msg: 'Access denied. One of the following scopes is required: [im:message.group_msg, im:message]',
        },
      },
    })
    assert.ok(info)
    assert.deepEqual(info.requiredScopes, ['im:message.group_msg', 'im:message'])
  })

  it('matches the Chinese phrasing when English structure is missing', () => {
    const info = detectFeishuScopeMissing({
      response: {
        status: 400,
        data: { code: 12345, msg: '应用尚未开通所需的应用身份权限：[contact:user.base]' },
      },
    })
    assert.ok(info)
    assert.deepEqual(info.requiredScopes, ['contact:user.base'])
  })

  it('parses JSON string body shapes (some axios configs return data as string)', () => {
    const info = detectFeishuScopeMissing({
      response: {
        status: 400,
        data: JSON.stringify({
          msg: 'scope is required',
          error: { permission_violations: [{ type: 'action_scope_required', subject: 'drive:drive' }] },
        }),
      },
    })
    assert.ok(info)
    assert.deepEqual(info.requiredScopes, ['drive:drive'])
  })

  it('returns null for unrelated 4xx errors', () => {
    assert.equal(detectFeishuScopeMissing({
      response: { status: 400, data: { code: 99992402, msg: 'field validation failed' } },
    }), null)
    assert.equal(detectFeishuScopeMissing({
      response: { status: 404, data: { code: 1064001, msg: 'document not found' } },
    }), null)
    assert.equal(detectFeishuScopeMissing(new Error('network down')), null)
    assert.equal(detectFeishuScopeMissing(null), null)
  })

  it('formatFeishuScopeMissing produces a self-contained admin-facing message', () => {
    const out = formatFeishuScopeMissing({
      requiredScopes: ['drive:drive', 'drive:drive:readonly'],
      logId: 'X1',
      message: '...',
    })
    assert.match(out, /Feishu app scope missing/)
    assert.match(out, /drive:drive or drive:drive:readonly/)
    assert.match(out, /Re-?publish the app version/i)
    assert.match(out, /x-tt-logid=X1/)
  })

  it('formatFeishuScopeMissing degrades gracefully without parsed scopes', () => {
    const out = formatFeishuScopeMissing({ requiredScopes: [], message: 'unknown' })
    assert.match(out, /\(see Feishu Developer Console\)/)
  })
})

describe('callFeishu (scope-missing translation)', () => {
  it('rethrows scope-missing axios errors as a friendly admin-facing Error', async () => {
    const axiosLike = {
      response: {
        status: 400,
        data: {
          code: 99991672,
          msg: 'Access denied. One of the following scopes is required: [drive:drive]',
          error: { permission_violations: [{ type: 'action_scope_required', subject: 'drive:drive' }] },
        },
        headers: { 'x-tt-logid': 'ABC123' },
      },
    }
    await assert.rejects(
      callFeishu(async () => { throw axiosLike }),
      (e: Error & { feishuScopeMissing?: { requiredScopes: string[] } }) => {
        assert.match(e.message, /Feishu app scope missing/)
        assert.match(e.message, /drive:drive/)
        assert.match(e.message, /x-tt-logid=ABC123/)
        assert.deepEqual(e.feishuScopeMissing?.requiredScopes, ['drive:drive'])
        return true
      },
    )
  })

  it('passes through unrelated errors unchanged', async () => {
    const original = new Error('connection reset')
    await assert.rejects(
      callFeishu(async () => { throw original }),
      (e: Error) => e === original,
    )
  })

  it('still raises envelope code != 0 errors as before', async () => {
    await assert.rejects(
      callFeishu(async () => ({ code: 42, msg: 'something else' })),
      /Feishu API error 42: something else/,
    )
  })
})
