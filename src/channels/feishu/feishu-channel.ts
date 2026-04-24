import { homedir } from 'node:os'
import path from 'node:path'

import { ChannelRunner } from '../runner.js'
import type { Channel, ChannelHandle, FeishuChannelConfig } from '../types.js'
import { createFeishuClient } from './client.js'
import { FeishuDedup } from './dedup.js'
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
        onMessage: message => runner.handleMessage(message),
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
