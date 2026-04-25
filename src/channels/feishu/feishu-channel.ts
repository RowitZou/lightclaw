import { homedir } from 'node:os'
import path from 'node:path'

import { ChannelRunner } from '../runner.js'
import type { Channel, ChannelHandle, FeishuChannelConfig, NormalizedChannelMessage } from '../types.js'
import { createFeishuClient } from './client.js'
import { FeishuDedup } from './dedup.js'
import { downloadFeishuMedia } from './media.js'
import { FeishuSender } from './sender.js'
import { createFeishuStrategy, FEISHU_CHANNEL_ID } from './strategy.js'
import { startFeishuWebhookServer } from './transport-webhook.js'

export function createFeishuChannel(config: FeishuChannelConfig): Channel {
  return {
    id: FEISHU_CHANNEL_ID,

    statusLine(): string {
      const enabled = config.enabled ? 'enabled' : 'disabled'
      const { host, port, path: webhookPath } = config.webhook
      return `${FEISHU_CHANNEL_ID} ${enabled} ${host}:${port}${webhookPath}`
    },

    async start(): Promise<ChannelHandle> {
      if (!config.enabled) {
        throw new Error('Feishu channel is disabled in ~/.lightclaw/channels.json.')
      }
      if (!config.encryptKey) {
        throw new Error(
          'Feishu channel requires feishu.encryptKey in ~/.lightclaw/channels.json. '
          + 'Without it the webhook cannot verify request signatures.',
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
      const server = await startFeishuWebhookServer({
        config,
        dedup,
        onMessage: async raw => {
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
        },
      })

      const { host, port, path: webhookPath } = config.webhook
      console.log(`feishu webhook listening on ${host}:${port}${webhookPath}`)

      return {
        async stop() {
          await server.close()
        },
      }
    },
  }
}

function appendLine(text: string, line: string): string {
  return text ? `${text}\n${line}` : line
}
