import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import type { FeishuClient } from './client.js'
import { ParentMessageFetcher } from './parent-fetch.js'
import { resetFeishuUserInfoWarningsForTest } from './contact.js'

describe('ParentMessageFetcher', () => {
  afterEach(() => {
    resetFeishuUserInfoWarningsForTest()
  })

  it('fetches, parses, and resolves sender names for text parents', async () => {
    const calls: string[] = []
    const fetcher = new ParentMessageFetcher(fakeClient({
      onGetMessage: id => {
        calls.push(id)
        return parentEnvelope({
          text: 'hello parent',
          senderOpenId: 'ou_alice',
        })
      },
      userName: 'Alice',
    }))

    const result = await fetcher.fetch('om_parent')

    assert.deepEqual(calls, ['om_parent'])
    assert.deepEqual(result, {
      text: 'hello parent',
      mediaKeys: [],
      senderOpenId: 'ou_alice',
      senderName: 'Alice',
    })
    assert.equal(await fetcher.fetch('om_parent'), result)
    assert.deepEqual(calls, ['om_parent'], 'cache hit must not refetch')
  })

  it('truncates long text and caps media keys', async () => {
    const long = 'x'.repeat(25)
    const fetcher = new ParentMessageFetcher(fakeClient({
      onGetMessage: () => parentEnvelope({
        text: long,
        senderOpenId: 'ou_alice',
        mediaKeys: Array.from({ length: 5 }, (_, i) => ({ kind: 'image' as const, key: `img_${i}` })),
      }),
    }), {
      maxTextChars: 10,
      maxMediaKeys: 2,
    })

    const result = await fetcher.fetch('om_parent')

    assert.ok(result)
    assert.equal(result.text, 'x'.repeat(10))
    assert.equal(result.truncated, true)
    assert.deepEqual(result.mediaKeys.map(item => item.key), ['img_0', 'img_1'])
  })

  it('returns null and caches permanent failures', async () => {
    let calls = 0
    const writes = captureStderr()
    try {
      const fetcher = new ParentMessageFetcher(fakeClient({
        onGetMessage: () => {
          calls += 1
          throw new Error('not found')
        },
      }))

      assert.equal(await fetcher.fetch('om_missing'), null)
      assert.equal(await fetcher.fetch('om_missing'), null)
    } finally {
      writes.restore()
    }

    assert.equal(calls, 1)
    assert.match(writes.text(), /feishu parent-fetch: failed parentId=om_missing reason=not found/)
  })

  it('deduplicates concurrent fetches for the same parent', async () => {
    let calls = 0
    const fetcher = new ParentMessageFetcher(fakeClient({
      onGetMessage: async () => {
        calls += 1
        await new Promise(resolve => setTimeout(resolve, 10))
        return parentEnvelope({ text: 'same', senderOpenId: 'ou_alice' })
      },
    }))

    const [a, b] = await Promise.all([
      fetcher.fetch('om_parent'),
      fetcher.fetch('om_parent'),
    ])

    assert.equal(calls, 1)
    assert.equal(a, b)
    assert.equal(a?.text, 'same')
  })

  it('times out and returns null', async () => {
    const writes = captureStderr()
    try {
      const fetcher = new ParentMessageFetcher(fakeClient({
        onGetMessage: () => new Promise(() => undefined),
      }), { fetchTimeoutMs: 5 })

      assert.equal(await fetcher.fetch('om_slow'), null)
    } finally {
      writes.restore()
    }

    assert.match(writes.text(), /timeout after 5ms/)
  })

  it('evicts old cache entries when the LRU is full', async () => {
    let calls = 0
    const fetcher = new ParentMessageFetcher(fakeClient({
      onGetMessage: id => {
        calls += 1
        return parentEnvelope({ text: id, senderOpenId: 'ou_alice' })
      },
    }), { cacheSize: 2 })

    await fetcher.fetch('om_1')
    await fetcher.fetch('om_2')
    await fetcher.fetch('om_3')
    await fetcher.fetch('om_1')

    assert.equal(calls, 4)
  })

  it('marks bot self-quotes without resolving contact names', async () => {
    let contactCalls = 0
    const fetcher = new ParentMessageFetcher(fakeClient({
      onGetMessage: () => parentEnvelope({
        text: 'previous assistant answer',
        senderOpenId: 'ou_bot',
      }),
      onGetUser: () => {
        contactCalls += 1
        return { code: 0, data: { user: { name: 'Should not be called' } } }
      },
    }))

    const result = await fetcher.fetch('om_parent', 'ou_bot')

    assert.equal(result?.isFromBot, true)
    assert.equal(result?.senderName, undefined)
    assert.equal(contactCalls, 0)
  })
})

function fakeClient(input: {
  onGetMessage(id: string): unknown | Promise<unknown>
  userName?: string
  onGetUser?(openId: string): unknown | Promise<unknown>
}): FeishuClient {
  return {
    im: {
      v1: {
        message: {
          get: ({ path }: { path: { message_id: string } }) =>
            input.onGetMessage(path.message_id),
        },
      },
    },
    contact: {
      v3: {
        user: {
          get: ({ path }: { path: { user_id: string } }) => {
            if (input.onGetUser) {
              return input.onGetUser(path.user_id)
            }
            return input.userName
              ? { code: 0, data: { user: { name: input.userName } } }
              : { code: 0, data: { user: {} } }
          },
        },
      },
    },
  } as unknown as FeishuClient
}

function parentEnvelope(input: {
  text?: string
  senderOpenId: string
  mediaKeys?: Array<{ kind: 'image'; key: string }>
}): unknown {
  const mediaKeys = input.mediaKeys ?? []
  return {
    code: 0,
    data: {
      items: [{
        msg_type: mediaKeys.length ? 'post' : 'text',
        sender: { id: input.senderOpenId },
        body: {
          content: mediaKeys.length
            ? JSON.stringify({
                content: [[
                  ...(input.text ? [{ tag: 'text', text: input.text }] : []),
                  ...mediaKeys.map(key => ({ tag: 'img', image_key: key.key })),
                ]],
              })
            : JSON.stringify({ text: input.text ?? '' }),
        },
      }],
    },
  }
}

function captureStderr(): { text(): string; restore(): void } {
  const old = process.stderr.write
  const chunks: string[] = []
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  return {
    text: () => chunks.join(''),
    restore() {
      process.stderr.write = old
    },
  }
}
