import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { summarizeFeishuSdkLog } from './client.js'

// The Lark SDK forwards its logger varargs as a single array arg, and
// `formatErrors` itself returns an array, so the payload reaching the logger
// is nested a couple of levels deep. summarizeFeishuSdkLog walks that and
// collapses it to a one-line `status/code/msg/url` breadcrumb.
describe('summarizeFeishuSdkLog', () => {
  it('extracts status + url from a nested AxiosError dump and never echoes the request body', () => {
    const formatted = [[{
      message: 'Request failed with status code 400',
      config: {
        url: 'https://open.feishu.cn/open-apis/im/v1/messages',
        method: 'post',
        data: 'BIG_REQUEST_BODY_PAYLOAD',
      },
      request: { protocol: 'https:', host: 'open.feishu.cn' },
      response: { status: 400, statusText: 'Bad Request', data: { code: 230011, msg: 'withdrawn' } },
    }]]
    const summary = summarizeFeishuSdkLog(formatted)
    assert.match(summary, /status=400/)
    assert.match(summary, /url=https:\/\/open\.feishu\.cn\/open-apis\/im\/v1\/messages/)
    assert.match(summary, /code=230011/)
    assert.doesNotMatch(summary, /BIG_REQUEST_BODY_PAYLOAD/)
  })

  it('extracts the Feishu error envelope code + msg', () => {
    const summary = summarizeFeishuSdkLog([[{ code: 230011, msg: 'message has been withdrawn' }]])
    assert.match(summary, /code=230011/)
    assert.match(summary, /msg=message has been withdrawn/)
  })

  it('dedupes overlapping fields across the formatErrors pair', () => {
    // formatErrors pushes [filteredErrorInfo, specificError(envelope)] — both
    // can carry the same status / code; the summary must not list them twice.
    const summary = summarizeFeishuSdkLog([[
      { response: { status: 400, data: { code: 230011, msg: 'withdrawn' } } },
      { code: 230011, msg: 'withdrawn' },
    ]])
    assert.equal(summary.match(/code=230011/g)?.length, 1)
  })

  it('stringifies a plain non-Axios error', () => {
    assert.match(summarizeFeishuSdkLog([[new Error('boom')]]), /boom/)
  })

  it('returns a placeholder for empty / detail-less input', () => {
    assert.equal(summarizeFeishuSdkLog([]), '(no detail)')
    assert.equal(summarizeFeishuSdkLog([[{}]]), '(no detail)')
  })

  it('never throws on a circular structure', () => {
    const circular: Record<string, unknown> = { code: 1 }
    circular.self = circular
    circular.response = circular
    assert.doesNotThrow(() => summarizeFeishuSdkLog([[circular]]))
  })

  it('caps an over-long msg to a single truncated line', () => {
    const summary = summarizeFeishuSdkLog([[{ msg: `${'x'.repeat(500)}\nsecond line` }]])
    assert.ok(summary.length < 220, 'summary stays short')
    assert.match(summary, /…$/)
    assert.doesNotMatch(summary, /\n/)
  })
})
