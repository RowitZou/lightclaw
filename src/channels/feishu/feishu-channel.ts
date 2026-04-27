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
      if (config.transport === 'webhook' && !config.encryptKey) {
        throw new Error(
          'Feishu webhook transport requires feishu.encryptKey in ~/.lightclaw/channels.json '
          + 'to verify signatures and decrypt encrypted events.',
        )
      }
      if (config.allowUsers.length === 0 && config.allowChats.length === 0) {
        process.stderr.write(
          'feishu: warning — allowUsers and allowChats are both empty; every incoming message will be dropped. '
          + 'Populate one of the lists (or "*") or set feishu.enabled=false.\n',
        )
      }
      process.stderr.write(
        `feishu: starting transport=${config.transport} encryption=${config.encryptKey ? 'on' : 'off'} allowUsers=${summarizeAllowList(config.allowUsers)} allowChats=${summarizeAllowList(config.allowChats)} permissionMode=${config.permissionMode}\n`,
      )

      const client = createFeishuClient(config)
      const sender = new FeishuSender(client, config)
      const runner = new ChannelRunner(createFeishuStrategy(config, sender, client))
      await runner.initialize()

      const dedup = new FeishuDedup(
        path.join(homedir(), '.lightclaw', 'state', 'feishu-dedup.json'),
      )

      const onMessage = async (raw: FeishuRawMessage): Promise<void> => {
        process.stderr.write(
          `feishu: inbound event=${raw.eventId} message=${raw.messageId}\n`,
        )
        // sender displayName is intentionally not pre-fetched here. The
        // pairing path in the runner does a fire-and-forget lookup via
        // strategy.fetchSenderName so paired-user messages are not blocked
        // by a per-message contact API round-trip.
        const message: NormalizedChannelMessage = {
          channel: FEISHU_CHANNEL_ID,
          eventId: raw.eventId,
          chatId: raw.chatId,
          senderOpenId: raw.senderOpenId,
          senderKey: `feishu:${raw.senderOpenId}`,
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
            process.stderr.write(
              `feishu: media saved message=${raw.messageId} path=${downloaded.path}\n`,
            )
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
        process.stderr.write('feishu: ws client started (long-lived subscription, no public ingress)\n')
        return { stop: () => handle.close() }
      }

      const server = await startFeishuWebhookServer({
        config,
        dedup,
        onMessage,
      })
      const { host, port, path: webhookPath } = config.webhook
      process.stderr.write(`feishu: webhook listening on ${host}:${port}${webhookPath}\n`)
      return { stop: () => server.close() }
    },
  }
}

function summarizeAllowList(list: string[]): string {
  if (list.length === 0) {
    return 'empty'
  }
  if (list.includes('*')) {
    return '*'
  }
  return `${list.length} entries`
}

function appendLine(text: string, line: string): string {
  return text ? `${text}\n${line}` : line
}
