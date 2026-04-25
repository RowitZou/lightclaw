import type { NormalizedChannelMessage } from '../types.js'
import { getUpdates } from './api/api.js'
import { wechatMessageToInbound } from './inbound.js'
import { setContextToken } from './storage/context-tokens.js'
import { loadGetUpdatesBuf, saveGetUpdatesBuf } from './storage/sync-buf.js'

const SESSION_EXPIRED = -14
const MAX_FAILURES = 3
const RETRY_MS = 2_000
const BACKOFF_MS = 30_000
const SESSION_EXPIRED_PAUSE_MS = 15 * 60_000

export async function monitorWechat(input: {
  baseUrl: string
  cdnBaseUrl: string
  token: string
  accountId: string
  mediaDir: string
  mediaEnabled: boolean
  longPollTimeoutMs: number
  abortSignal: AbortSignal
  onMessage(message: NormalizedChannelMessage): Promise<void>
}): Promise<void> {
  let getUpdatesBuf = await loadGetUpdatesBuf(input.accountId) ?? ''
  let timeoutMs = input.longPollTimeoutMs
  let failures = 0

  while (!input.abortSignal.aborted) {
    try {
      const resp = await getUpdates({
        baseUrl: input.baseUrl,
        token: input.token,
        get_updates_buf: getUpdatesBuf,
        timeoutMs,
        signal: input.abortSignal,
      })
      if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
        timeoutMs = resp.longpolling_timeout_ms
      }
      const isError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0)
      if (isError) {
        const expired = resp.ret === SESSION_EXPIRED || resp.errcode === SESSION_EXPIRED
        if (expired) {
          process.stderr.write(
            'wechat: session expired, pausing 15 min; run `lightclaw channel wechat login` to re-auth.\n',
          )
          failures = 0
          await sleep(SESSION_EXPIRED_PAUSE_MS, input.abortSignal)
          continue
        }
        failures = await handleFailure(
          failures,
          `wechat: getUpdates failed ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ''}`,
          input.abortSignal,
        )
        continue
      }
      failures = 0
      for (const msg of resp.msgs ?? []) {
        if (msg.context_token && msg.from_user_id) {
          await setContextToken(input.accountId, msg.from_user_id, msg.context_token)
        }
        const inbound = await wechatMessageToInbound({
          msg,
          accountId: input.accountId,
          cdnBaseUrl: input.cdnBaseUrl,
          mediaDir: input.mediaDir,
          mediaEnabled: input.mediaEnabled,
        })
        await input.onMessage(inbound)
      }
      // Persist cursor only after the batch is fully handled. A crash mid-batch
      // leaves the unprocessed tail to be redelivered on restart (at-least-once)
      // instead of silently advancing past it.
      if (resp.get_updates_buf && resp.get_updates_buf !== getUpdatesBuf) {
        getUpdatesBuf = resp.get_updates_buf
        await saveGetUpdatesBuf(input.accountId, getUpdatesBuf)
      }
    } catch (error) {
      if (input.abortSignal.aborted) {
        return
      }
      failures = await handleFailure(
        failures,
        `wechat: getUpdates error: ${String(error)}`,
        input.abortSignal,
      )
    }
  }
}

async function handleFailure(
  previousFailures: number,
  message: string,
  signal: AbortSignal,
): Promise<number> {
  const failures = previousFailures + 1
  process.stderr.write(`${message} (${failures}/${MAX_FAILURES})\n`)
  if (failures >= MAX_FAILURES) {
    await sleep(BACKOFF_MS, signal)
    return 0
  }
  await sleep(RETRY_MS, signal)
  return failures
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }, { once: true })
  })
}
