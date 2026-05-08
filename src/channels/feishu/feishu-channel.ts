import path from 'node:path'

import { t } from '../../i18n/index.js'
import { lightclawHome } from '../../paths.js'
import { ChannelRunner } from '../runner.js'
import type { Channel, ChannelHandle, FeishuChannelConfig, NormalizedChannelMessage } from '../types.js'
import type { FeishuRawMessage } from './bot-content.js'
import { createFeishuClient } from './client.js'
import { FeishuDedup } from './dedup.js'
import {
  BackgroundTaskCardCoordinator,
  clearBackgroundTaskCardCoordinator,
  registerBackgroundTaskCardCoordinator,
  type BackgroundTaskCardAction,
} from './bg-card-coordinator.js'
import { fileNameFor } from './media.js'
import { FeishuPermissionCoordinator } from './permission-card.js'
import type { FeishuCardAction } from './permission-card.js'
import { FeishuSender } from './sender.js'
import { clearFeishuSender, registerFeishuSender } from './sender-registry.js'
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
      // Register the sender on a module-level slot so paths outside the
      // channel runner (notably /user approve in commands/builtin.ts) can
      // push proactive cards. Cleared in stop() so a restart re-registers.
      registerFeishuSender(sender)
      const permissionCoordinator = new FeishuPermissionCoordinator(sender)
      const bgCardCoordinator = new BackgroundTaskCardCoordinator(sender)
      registerBackgroundTaskCardCoordinator(bgCardCoordinator)
      const runner = new ChannelRunner(
        createFeishuStrategy(config, sender, client, permissionCoordinator),
      )
      await runner.initialize()

      const dedup = new FeishuDedup(
        path.join(lightclawHome(), 'state', 'feishu-dedup.json'),
      )

      const onMessage = async (raw: FeishuRawMessage): Promise<void> => {
        process.stderr.write(
          `feishu: inbound event=${raw.eventId} message=${raw.messageId}\n`,
        )
        if (await permissionCoordinator.tryConsumePermissionMessage(raw)) {
          process.stderr.write(`feishu: permission response consumed message=${raw.messageId}\n`)
          return
        }
        // Sender displayName is intentionally not fetched here. The Feishu
        // contact user.get API requires extra address-book permission and the
        // Lark SDK logs failed best-effort lookups before callers can catch
        // them, so pairing stays on open_id + admin-chosen canonical name.
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
          const mediaKey = raw.mediaKeys[0]
          message.pendingAttachment = {
            kind: 'feishu-media',
            messageId: raw.messageId,
            mediaKey,
            fileName: fileNameFor(raw.messageId, mediaKey),
          }
        } else if (raw.mediaKeys?.length) {
          message.text = appendLine(message.text, t('channel.media.skipped'))
        }
        await runner.handleMessage(message)
      }

      if (config.transport === 'ws') {
        const handle = await startFeishuWsClient({
          config,
          dedup,
          onMessage,
          onCardAction: action => {
            if ('kind' in action && action.kind === 'background_task') {
              return bgCardCoordinator.handleCardAction(action)
            }
            return permissionCoordinator.handleCardAction(action as FeishuCardAction)
          },
        })
        process.stderr.write('feishu: ws client started (long-lived subscription, no public ingress)\n')
        return {
          stop: () => {
            clearFeishuSender(sender)
            clearBackgroundTaskCardCoordinator(bgCardCoordinator)
            return handle.close()
          },
        }
      }

      const server = await startFeishuWebhookServer({
        config,
        dedup,
        onMessage,
      })
      const { host, port, path: webhookPath } = config.webhook
      process.stderr.write(`feishu: webhook listening on ${host}:${port}${webhookPath}\n`)
      return {
        stop: () => {
          clearFeishuSender(sender)
          clearBackgroundTaskCardCoordinator(bgCardCoordinator)
          return server.close()
        },
      }
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
