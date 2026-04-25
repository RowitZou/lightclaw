import { ChannelRunner } from '../runner.js'
import type { Channel, ChannelHandle, WechatChannelConfig } from '../types.js'
import { notifyStart, notifyStop } from './api/api.js'
import { monitorWechat } from './monitor.js'
import { WechatSender } from './sender.js'
import { loadWechatAccount } from './storage/accounts.js'
import { restoreContextTokens } from './storage/context-tokens.js'
import { createWechatStrategy, WECHAT_CHANNEL_ID } from './strategy.js'

const ACCOUNT_ID = 'default'
const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

export function createWechatChannel(config: WechatChannelConfig): Channel {
  return {
    id: WECHAT_CHANNEL_ID,

    statusLine(): string {
      const enabled = config.enabled ? 'enabled' : 'disabled'
      return `${WECHAT_CHANNEL_ID} ${enabled} long-poll (no listening port)`
    },

    async start(): Promise<ChannelHandle> {
      if (!config.enabled) {
        throw new Error('WeChat channel is disabled in ~/.lightclaw/channels.json.')
      }
      const account = await loadWechatAccount(ACCOUNT_ID)
      if (!account) {
        throw new Error(
          'WeChat channel requires login. Run `lightclaw channel wechat login` first.',
        )
      }
      if (!config.allowSenders.length) {
        process.stderr.write(
          'wechat: warning — allowSenders is empty; every incoming message will be dropped. '
          + 'Populate the list (or "*") or set wechat.enabled=false.\n',
        )
      }

      await restoreContextTokens(ACCOUNT_ID)
      const sender = new WechatSender(
        ACCOUNT_ID,
        account.baseUrl,
        account.token,
        config.textChunkSize,
      )
      const runner = new ChannelRunner(createWechatStrategy(config, sender))
      await runner.initialize()

      void notifyStart({ baseUrl: account.baseUrl, token: account.token })
        .catch(error => {
          process.stderr.write(`wechat: notifyStart failed: ${String(error)}\n`)
        })

      const ctrl = new AbortController()
      const monitorPromise = monitorWechat({
        baseUrl: account.baseUrl,
        cdnBaseUrl: CDN_BASE_URL,
        token: account.token,
        accountId: ACCOUNT_ID,
        mediaDir: config.mediaDir,
        mediaEnabled: config.mediaEnabled,
        longPollTimeoutMs: config.longPollTimeoutMs,
        abortSignal: ctrl.signal,
        onMessage: message => runner.handleMessage(message),
      })

      console.log(`wechat monitor started (${account.baseUrl})`)

      return {
        async stop() {
          ctrl.abort()
          try {
            await monitorPromise
          } catch {
            // abort during shutdown is expected
          }
          await notifyStop({ baseUrl: account.baseUrl, token: account.token }).catch(() => {})
        },
      }
    },
  }
}
