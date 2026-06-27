import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Readable } from 'node:stream'

import type { ChannelFileSender, ChannelFileSendOutput } from '../session-context.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import type { Runtime } from '../runtime/index.js'
import { sendFileTool } from './send-file.js'

describe('SendFile tool', () => {
  it('surfaces the IM attachment success path', async () => {
    const sends: Array<{ name: string; size: number }> = []
    const sender: ChannelFileSender = {
      channelId: 'feishu',
      sendFile: async (file): Promise<ChannelFileSendOutput> => {
        sends.push({ name: file.name, size: (await file.read()).byteLength })
        return { kind: 'im-attachment' }
      },
    }
    const result = await runWithSender(sender, () => sendFileTool.call(
      { file_path: '/workspace/notes.pdf' },
      buildContext(makeRuntime({ '/workspace/notes.pdf': Buffer.from('hello pdf') })),
    ))
    assert.equal(result.isError, undefined)
    assert.match(String(result.output), /Sent notes\.pdf to feishu\./)
    assert.deepEqual(sends, [{ name: 'notes.pdf', size: 9 }])
  })

  it('reports the cloud link and size when sender falls back to drive upload', async () => {
    const content = Buffer.alloc(40 * 1024 * 1024, 0x41) // 40 MB synthetic payload
    let wholeReads = 0
    let streamOpens = 0
    const sender: ChannelFileSender = {
      channelId: 'feishu',
      sendFile: async (): Promise<ChannelFileSendOutput> => ({
        kind: 'cloud-link',
        url: 'https://feishu.cn/file/boxcnAbCdEf',
        sizeBytes: content.byteLength,
      }),
    }
    const result = await runWithSender(sender, () => sendFileTool.call(
      { file_path: '/workspace/qwen-image-2.pdf' },
      buildContext(makeRuntime(
        { '/workspace/qwen-image-2.pdf': content },
        {
          onRead: () => { wholeReads += 1 },
          onStream: () => { streamOpens += 1 },
        },
      )),
    ))
    assert.equal(result.isError, undefined)
    const out = String(result.output)
    assert.match(out, /Uploaded qwen-image-2\.pdf \(40\.0 MB\)/)
    assert.match(out, /share link to feishu/)
    assert.match(out, /URL: https:\/\/feishu\.cn\/file\/boxcnAbCdEf/)
    assert.equal(wholeReads, 0, 'large host-visible SendFile must not eagerly read the whole file')
    assert.equal(streamOpens, 0, 'the sender owns lazy stream opening')
  })

  it('rejects empty files without contacting the sender', async () => {
    let touched = false
    const sender: ChannelFileSender = {
      channelId: 'feishu',
      sendFile: async () => { touched = true; return { kind: 'im-attachment' as const } },
    }
    const result = await runWithSender(sender, () => sendFileTool.call(
      { file_path: '/workspace/empty.txt' },
      buildContext(makeRuntime({ '/workspace/empty.txt': Buffer.alloc(0) })),
    ))
    assert.equal(result.isError, true)
    assert.match(String(result.output), /refused to send an empty file/)
    assert.equal(touched, false)
  })

  it('errors when no channel sender is attached', async () => {
    // No runWithSender wrapper → SessionContext exists but channelFileSender is null.
    const ctx = createSessionContext({
      cwd: '/tmp',
      model: 'test',
      sessionsDir: '/tmp/s',
      memoryDir: '/tmp/m',
    })
    const result = await runWithSessionContext(ctx, () => sendFileTool.call(
      { file_path: '/workspace/x.pdf' },
      buildContext(makeRuntime({ '/workspace/x.pdf': Buffer.from('z') })),
    ))
    assert.equal(result.isError, true)
    assert.match(String(result.output), /only available while handling a supported channel message/)
  })
})

async function runWithSender<T>(sender: ChannelFileSender, fn: () => Promise<T>): Promise<T> {
  const ctx = createSessionContext({
    cwd: '/tmp',
    model: 'test',
    sessionsDir: '/tmp/s',
    memoryDir: '/tmp/m',
    channelFileSender: sender,
  })
  return runWithSessionContext(ctx, fn)
}

function buildContext(runtime: Runtime): {
  cwd: string
  abortSignal: AbortSignal
  runtime: Runtime
} {
  return {
    cwd: '/tmp',
    abortSignal: new AbortController().signal,
    runtime,
  }
}

function makeRuntime(
  files: Record<string, Buffer>,
  hooks: { onRead?: () => void; onStream?: () => void } = {},
): Runtime {
  return {
    fs: {
      stat: async (p: string) => {
        const buf = files[p]
        if (!buf) {
          throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' })
        }
        return { size: buf.byteLength, isFile: true, isDirectory: false, mtimeMs: 0 }
      },
      readFile: async (p: string) => {
        hooks.onRead?.()
        const buf = files[p]
        if (!buf) {
          throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' })
        }
        return buf
      },
      createReadStream: async (p: string) => {
        hooks.onStream?.()
        const buf = files[p]
        if (!buf) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' })
        return Readable.from(buf)
      },
    },
  } as unknown as Runtime
}
