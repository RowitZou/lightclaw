import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import type { FeishuClient } from './client.js'
import {
  fetchFeishuUserInfo,
  resetFeishuUserInfoWarningsForTest,
} from './contact.js'

describe('fetchFeishuUserInfo', () => {
  afterEach(() => {
    resetFeishuUserInfoWarningsForTest()
  })

  it('returns name, email, and tenant user id from a successful envelope', async () => {
    const client = fakeClient({
      code: 0,
      data: {
        user: {
          name: '邹易澄',
          en_name: '',
          email: 'zouyicheng@pjlab.org.cn',
          user_id: '62236ecd',
        },
      },
    })

    assert.deepEqual(await fetchFeishuUserInfo(client, 'ou_alice'), {
      name: '邹易澄',
      email: 'zouyicheng@pjlab.org.cn',
      userId: '62236ecd',
    })
  })

  it('falls back to en_name when primary name is empty', async () => {
    const client = fakeClient({
      code: 0,
      data: { user: { name: '', en_name: 'Alice Wong', email: 'alice@example.com', user_id: 'abcd1234' } },
    })

    assert.deepEqual(await fetchFeishuUserInfo(client, 'ou_alice'), {
      name: 'Alice Wong',
      email: 'alice@example.com',
      userId: 'abcd1234',
    })
  })

  it('returns undefined for empty user fields', async () => {
    const client = fakeClient({ code: 0, data: { user: {} } })
    assert.equal(await fetchFeishuUserInfo(client, 'ou_empty'), undefined)
  })

  it('warns only once for missing contact scope', async () => {
    const client = fakeClient({ code: 99991672, msg: 'no scope' })
    const writes = captureStderr()
    try {
      assert.equal(await fetchFeishuUserInfo(client, 'ou_a'), undefined)
      assert.equal(await fetchFeishuUserInfo(client, 'ou_b'), undefined)
    } finally {
      writes.restore()
    }
    assert.equal(writes.lines.length, 1)
    assert.match(writes.lines[0], /contact:contact\.base:readonly/)
  })

  it('swallows non-scope envelope and SDK failures', async () => {
    assert.equal(await fetchFeishuUserInfo(fakeClient({ code: 1234 }), 'ou_a'), undefined)
    assert.equal(await fetchFeishuUserInfo(fakeClient(new Error('proxy timeout')), 'ou_b'), undefined)
  })
})

function fakeClient(response: unknown): FeishuClient {
  return {
    contact: {
      v3: {
        user: {
          async get() {
            if (response instanceof Error) {
              throw response
            }
            return response
          },
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
