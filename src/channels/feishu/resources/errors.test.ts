import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { classifyFeishuError, FeishuApiError, formatFeishuErrorForLog } from './errors.js'

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

  // 2026-07-10 prod: drive move rejected our malformed request with
  // code=1061002 "params error." and the old blanket /^1061\d{3}$/ rule
  // dressed it up as already-exists ("treat as success") — agents chased
  // phantom name conflicts instead of seeing a request-shape bug. 1061xxx
  // is the whole drive error space, not an already-exists family.
  it('classifies drive params error 1061002 as validation-failed, never already-exists', () => {
    assert.equal(classifyFeishuError(axiosLike({
      status: 400,
      data: { code: 1061002, msg: 'params error.' },
    })).kind, 'validation-failed')
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

  it('classifies a past-edit-window message (230031) as withdrawn-target', () => {
    // Feishu refuses updates on messages older than 14 days. The target is
    // permanently un-editable — same remedy as a recalled target: create a
    // fresh message instead of retrying the patch.
    assert.equal(classifyFeishuError(axiosLike({
      status: 400,
      data: { code: 230031, msg: 'Message has expired when updating message, ext=Message can only be updated within fourteen days.' },
    })).kind, 'withdrawn-target')
  })

  it('classifies a rejected card payload (230099 / 230025) as card-content-rejected', () => {
    // The message id is fine — the CARD is what Feishu refuses: 230099 carries
    // the card builder's own ceiling in ext ("ErrCode: 11310; ErrMsg: element
    // exceeds the limit"), 230025 is the 30 KB message-length cap. Distinct
    // from withdrawn-target: the same target accepts a SMALLER card, so the
    // remedy is shrink-and-retry, not create-a-new-message.
    for (const data of [
      { code: 230099, msg: 'Failed to create card content' },
      { code: 230025, msg: 'the length of the message content reaches its limit' },
    ]) {
      const c = classifyFeishuError(axiosLike({ status: 400, data }))
      assert.equal(c.kind, 'card-content-rejected')
      assert.equal(c.retryable, false, 'retrying the same payload is pointless')
    }
  })

  it('classifies an invalid/nonexistent open_message_id (99992354) as withdrawn-target', () => {
    // bg-wake synthetic messageIds the platform never saw 400 with this code;
    // the reply path treats it like a withdrawn target and falls back to create.
    assert.equal(classifyFeishuError(axiosLike({
      status: 400,
      data: { code: 99992354, msg: 'The request you send is not a valid open_message_id or not exists' },
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

describe('formatFeishuErrorForLog: circular response.data', () => {
  it('does not throw on an axios error whose response.data is a circular stream', () => {
    // A binary endpoint (im.messageResource.get) 502 hands axios the raw Node
    // IncomingMessage as response.data, which is circular
    // (socket -> _httpMessage(ClientRequest) -> res). Pre-fix the error
    // formatter's JSON.stringify(response.data) threw `Converting circular
    // structure to JSON` straight out of the catch handler, masking the 502 and
    // surfacing as `materializeAttachment threw` (2026-06-27 dogfood).
    const socket: Record<string, unknown> = {}
    const incoming: Record<string, unknown> = { socket }
    const clientRequest: Record<string, unknown> = { res: incoming }
    socket._httpMessage = clientRequest
    incoming.req = clientRequest

    const err = axiosLike({ status: 502, statusText: 'Bad Gateway', data: incoming, headers: {} })

    let line = ''
    assert.doesNotThrow(() => {
      line = formatFeishuErrorForLog(err, 'im.messageResource.get')
    })
    assert.match(line, /op=im\.messageResource\.get/)
    // classifyFeishuError walks the same formatter chain — must also not throw.
    assert.doesNotThrow(() => classifyFeishuError(err))
  })
})
