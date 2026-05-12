import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { FeishuClient } from '../client.js'
import { grantChatPermission, grantUserPermission } from './doc.js'

describe('grantPermission error reporting', () => {
  it('unwraps axios 400 response body and x-tt-logid into the returned error', async () => {
    const client = fakeClient({
      kind: 'axios-error',
      response: {
        status: 400,
        statusText: 'Bad Request',
        data: { code: 1069902, msg: 'no permission to share with chat' },
        headers: { 'x-tt-logid': '20260512123456abcdef' },
      },
    })

    const result = await grantChatPermission({
      client,
      documentId: 'docxABC',
      chatId: 'oc_group_1',
      perm: 'view',
    })

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.alreadyExists, false)
    assert.match(result.error, /Feishu HTTP 400 Bad Request/)
    assert.match(result.error, /1069902/)
    assert.match(result.error, /no permission to share with chat/)
    assert.match(result.error, /x-tt-logid=20260512123456abcdef/)
  })

  it('logs a stderr line on real failure but stays quiet on already-exists', async () => {
    const failClient = fakeClient({
      kind: 'axios-error',
      response: { status: 400, data: { code: 1069902, msg: 'bad scope' } },
    })
    const idempotentClient = fakeClient({
      kind: 'callfeishu-throw',
      throw: new Error('Feishu API error 1061004: member has already been added'),
    })

    const stderr = captureStderr()
    try {
      await grantChatPermission({ client: failClient, documentId: 'docxA', chatId: 'oc_x', perm: 'view' })
      await grantUserPermission({ client: idempotentClient, documentId: 'docxA', openId: 'ou_y', perm: 'full_access' })
    } finally {
      stderr.restore()
    }

    assert.equal(stderr.lines.length, 1)
    assert.match(stderr.lines[0], /feishu permission grant failed: openchat\/oc_x on docx docxA \(perm=view\)/)
    assert.match(stderr.lines[0], /1069902/)
  })

  it('detects 1061xxx already-exists from the unwrapped Feishu code', async () => {
    const client = fakeClient({
      kind: 'callfeishu-throw',
      throw: new Error('Feishu API error 1061004: member already exists'),
    })

    const result = await grantUserPermission({
      client,
      documentId: 'docxABC',
      openId: 'ou_already',
      perm: 'full_access',
    })

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.alreadyExists, true)
  })

  it('returns ok when SDK call succeeds', async () => {
    const client = fakeClient({ kind: 'ok' })
    const result = await grantChatPermission({
      client,
      documentId: 'docxOK',
      chatId: 'oc_ok',
      perm: 'view',
    })
    assert.equal(result.ok, true)
  })
})

type FakeResponse =
  | { kind: 'ok' }
  | { kind: 'axios-error'; response: { status: number; statusText?: string; data: unknown; headers?: Record<string, unknown> } }
  | { kind: 'callfeishu-throw'; throw: Error }

function fakeClient(spec: FakeResponse): FeishuClient {
  return {
    drive: {
      permissionMember: {
        async create() {
          if (spec.kind === 'ok') {
            return { code: 0, msg: '', data: {} }
          }
          if (spec.kind === 'callfeishu-throw') {
            // Simulates the Feishu SDK returning a non-zero envelope, which
            // callFeishu wraps into an Error.
            return { code: 1061004, msg: 'member has already been added' }
          }
          // Simulates axios's own ERR_BAD_REQUEST: response.* fields are on the error object.
          const error = new Error('Request failed with status code ' + String(spec.response.status))
          ;(error as { response?: unknown }).response = spec.response
          throw error
        },
      },
    },
  } as unknown as FeishuClient
}

function captureStderr(): { lines: string[]; restore(): void } {
  const old = process.stderr.write
  const lines: string[] = []
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  return {
    lines,
    restore() {
      process.stderr.write = old
    },
  }
}
