import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import type { FeishuClient } from './client.js'
import { createFeishuTypingReaction } from './typing-reaction.js'

type CreatePayload = {
  path: { message_id: string }
  data: { reaction_type: { emoji_type: string } }
}
type DeletePayload = {
  path: { message_id: string; reaction_id: string }
}

function makeFakeClient(opts: {
  createImpl: (p?: CreatePayload) => Promise<unknown>
  deleteImpl?: (p?: DeletePayload) => Promise<unknown>
}): { client: FeishuClient; createCalls: CreatePayload[]; deleteCalls: DeletePayload[] } {
  const createCalls: CreatePayload[] = []
  const deleteCalls: DeletePayload[] = []
  const client = {
    im: {
      messageReaction: {
        create: async (p?: CreatePayload) => {
          if (p) createCalls.push(p)
          return opts.createImpl(p) as never
        },
        delete: async (p?: DeletePayload) => {
          if (p) deleteCalls.push(p)
          return (opts.deleteImpl ?? (async () => ({ code: 0 })))(p) as never
        },
      },
    },
  } as unknown as FeishuClient
  return { client, createCalls, deleteCalls }
}

describe('FeishuTypingReaction', () => {
  it('start posts a Typing reaction and returns the reaction_id', async () => {
    const { client, createCalls } = makeFakeClient({
      createImpl: async () => ({ code: 0, data: { reaction_id: 'r123' } }),
    })
    const typing = createFeishuTypingReaction(client)
    const state = await typing.start('om_msg_42')
    assert.equal(state.reactionId, 'r123')
    assert.equal(state.messageId, 'om_msg_42')
    assert.equal(createCalls.length, 1)
    assert.equal(createCalls[0]?.path.message_id, 'om_msg_42')
    assert.equal(createCalls[0]?.data.reaction_type.emoji_type, 'Typing')
  })

  it('start swallows thrown errors and returns null reactionId', async () => {
    const { client } = makeFakeClient({
      createImpl: async () => {
        throw new Error('network down')
      },
    })
    const typing = createFeishuTypingReaction(client)
    const state = await typing.start('om_x')
    assert.equal(state.reactionId, null)
    assert.equal(state.messageId, 'om_x')
  })

  it('start treats backoff response codes as null reactionId without throwing', async () => {
    const { client } = makeFakeClient({
      createImpl: async () => ({ code: 99991400, msg: 'rate limited' }),
    })
    const typing = createFeishuTypingReaction(client)
    const state = await typing.start('om_x')
    assert.equal(state.reactionId, null)
  })

  it('stop deletes when reactionId is non-null', async () => {
    const { client, deleteCalls } = makeFakeClient({
      createImpl: async () => ({ code: 0, data: { reaction_id: 'r1' } }),
    })
    const typing = createFeishuTypingReaction(client)
    const state = await typing.start('om_x')
    await typing.stop(state)
    assert.equal(deleteCalls.length, 1)
    assert.equal(deleteCalls[0]?.path.reaction_id, 'r1')
    assert.equal(deleteCalls[0]?.path.message_id, 'om_x')
  })

  it('stop is a no-op when reactionId is null (e.g. add failed)', async () => {
    const { client, deleteCalls } = makeFakeClient({
      createImpl: async () => ({ code: 0, data: {} }),
    })
    const typing = createFeishuTypingReaction(client)
    const state = await typing.start('om_x')
    await typing.stop(state)
    assert.equal(deleteCalls.length, 0)
  })

  it('stop is a no-op on null state input', async () => {
    const { client, deleteCalls } = makeFakeClient({
      createImpl: async () => ({ code: 0, data: { reaction_id: 'r1' } }),
    })
    const typing = createFeishuTypingReaction(client)
    await typing.stop(null)
    assert.equal(deleteCalls.length, 0)
  })

  it('stop swallows thrown errors', async () => {
    const { client } = makeFakeClient({
      createImpl: async () => ({ code: 0, data: { reaction_id: 'r1' } }),
      deleteImpl: async () => {
        throw new Error('message deleted')
      },
    })
    const typing = createFeishuTypingReaction(client)
    const state = await typing.start('om_x')
    await typing.stop(state)
    // no throw == pass
  })

  it('stop logs a benign skip (not "failed") when the target message was recalled', async () => {
    const { client } = makeFakeClient({
      createImpl: async () => ({ code: 0, data: { reaction_id: 'r1' } }),
      deleteImpl: async () => {
        // Feishu 400 with a withdrawn-target code (230011) — what
        // messageReaction.delete returns once the message is recalled.
        throw { response: { status: 400, data: { code: 230011, msg: 'message withdrawn' } } }
      },
    })
    const capture = captureStderr()
    try {
      const typing = createFeishuTypingReaction(client)
      const state = await typing.start('om_recalled')
      await typing.stop(state)
    } finally {
      capture.restore()
    }
    const joined = capture.lines.join('')
    assert.match(joined, /delete skipped for om_recalled \(message gone: withdrawn-target\)/)
    assert.doesNotMatch(joined, /delete failed/)
  })

  it('stop still logs "failed" for an unexpected (non-recall) delete error', async () => {
    const { client } = makeFakeClient({
      createImpl: async () => ({ code: 0, data: { reaction_id: 'r1' } }),
      deleteImpl: async () => {
        throw new Error('network down')
      },
    })
    const capture = captureStderr()
    try {
      const typing = createFeishuTypingReaction(client)
      const state = await typing.start('om_x')
      await typing.stop(state)
    } finally {
      capture.restore()
    }
    const joined = capture.lines.join('')
    assert.match(joined, /delete failed for om_x/)
    assert.doesNotMatch(joined, /delete skipped/)
  })
})

function captureStderr(): { lines: string[]; restore: () => void } {
  const original = process.stderr.write.bind(process.stderr)
  const lines: string[] = []
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }) as typeof process.stderr.write
  return {
    lines,
    restore: () => {
      process.stderr.write = original
    },
  }
}
