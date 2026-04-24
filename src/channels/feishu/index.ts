import { homedir } from 'node:os'
import path from 'node:path'

import { cleanupMcp } from '../../mcp/index.js'
import { loadChannelConfig } from '../config.js'
import { createFeishuClient } from './client.js'
import { FeishuDedup } from './dedup.js'
import { FeishuRunner } from './runner.js'
import { FeishuSender } from './sender.js'
import { startFeishuWebhookServer } from './transport-webhook.js'

export async function startFeishuChannel(): Promise<void> {
  const channelConfig = loadChannelConfig()
  const config = channelConfig.feishu
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
  const runner = new FeishuRunner(config, sender)
  await runner.initialize()

  const dedup = new FeishuDedup(path.join(homedir(), '.lightclaw', 'state', 'feishu-dedup.json'))
  const server = await startFeishuWebhookServer({
    config,
    dedup,
    onMessage: message => runner.handleMessage(message),
  })

  console.log(
    `feishu webhook listening on ${config.webhook.host}:${config.webhook.port}${config.webhook.path}`,
  )

  const shutdown = new AbortController()
  const stop = () => shutdown.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  await new Promise<void>(resolve => {
    shutdown.signal.addEventListener('abort', () => resolve(), { once: true })
  })

  process.off('SIGINT', stop)
  process.off('SIGTERM', stop)
  await server.close()
  await cleanupMcp()
}
