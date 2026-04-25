import { homedir } from 'node:os'
import path from 'node:path'

import { ChannelRunner } from '../runner.js'
import type { Channel, ChannelHandle, FeishuChannelConfig, NormalizedChannelMessage } from '../types.js'
import type { FeishuRawMessage } from './bot-content.js'
import { createFeishuClient } from './client.js'
import { FeishuDedup } from './dedup.js'
import { downloadFeishuMedia } from './media.js'
import { FeishuSender } from './sender.js'
import { createFeishuStrategy, FEISHU_CHANNEL_ID } from './strategy.js'
import { startFeishuWebhookServer } from './transport-webhook.js'
import { startFeishuWsClient } from './transport-ws.js'

export function createFeishuChannel(config: FeishuChannelConfig): Channel {
  return {
    id: FEISHU_CHANNEL_ID,

    statusLine(): string {
      const enabled = config.enabled ? 'enabled' : 'disabled'
      if (config.transport === 'ws') {
        return `${FEISHU_CHANNEL_ID} ${enabled} ws (no listening port)`
      }
      const { host, port, path: webhookPath } = config.webhook
      return `${FEISHU_CHANNEL_ID} ${enabled} webhook ${host}:${port}${webhookPath}`
    },

    async start(): Promise<ChannelHandle> {
      if (!config.enabled) {
        throw new Error('Feishu channel is disabled in ~/.lightclaw/channels.json.')
      }
      if (!config.encryptKey) {
        throw new Error(
          'Feishu channel requires feishu.encryptKey in ~/.lightclaw/channels.json. '
          + 'Both transports use it (ws decrypts events, webhook verifies signatures).',
        )
      }
      if (config.allowUsers.length === 0 && config.allowChats.length === 0) {
        process.stderr.write(
          'feishu: warning — allowUsers and allowChats are both empty; every incoming message will be dropped. '
          + 'Populate one of the lists (or "*") or set feishu.enabled=false.\n',
        )
      }

      const client = createFeishuClient(config)
      const sender = new FeishuSender(client, config)
      const runner = new ChannelRunner(createFeishuStrategy(config, sender))
      await runner.initialize()

      const dedup = new FeishuDedup(
        path.join(homedir(), '.lightclaw', 'state', 'feishu-dedup.json'),
      )

      const onMessage = async (raw: FeishuRawMessage): Promise<void> => {
        const message: NormalizedChannelMessage = {
          channel: FEISHU_CHANNEL_ID,
          eventId: raw.eventId,
          chatId: raw.chatId,
          senderOpenId: raw.senderOpenId,
          chatType: raw.chatType,
          messageId: raw.messageId,
          parentId: raw.parentId,
          text: raw.text,
        }
        if (raw.mediaKeys?.length && config.mediaEnabled) {
          const downloaded = await downloadFeishuMedia({
            client,
            messageId: raw.messageId,
            mediaKey: raw.mediaKeys[0],
            mediaDir: config.mediaDir,
            chatId: raw.chatId,
          })
          if (downloaded) {
            message.mediaPath = downloaded.path
            message.mediaType = downloaded.mimeType
          } else {
            message.text = appendLine(message.text, '[媒体下载失败]')
          }
        } else if (raw.mediaKeys?.length) {
          message.text = appendLine(message.text, '[媒体附件: skipped (mediaEnabled=false)]')
        }
        await runner.handleMessage(message)
      }

      if (config.transport === 'ws') {
        const handle = await startFeishuWsClient({ config, dedup, onMessage })
        console.log('feishu ws client started (long-lived subscription, no public ingress)')
        return { stop: () => handle.close() }
      }

      const server = await startFeishuWebhookServer({
        config,
        dedup,
        onMessage,
      })
      const { host, port, path: webhookPath } = config.webhook
      console.log(`feishu webhook listening on ${host}:${port}${webhookPath}`)
      return { stop: () => server.close() }
    },
  }
}

function appendLine(text: string, line: string): string {
  return text ? `${text}\n${line}` : line
}
