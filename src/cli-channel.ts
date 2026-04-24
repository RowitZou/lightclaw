import { spawn } from 'node:child_process'

import { startFeishuChannel } from './channels/feishu/index.js'
import { loadChannelConfig } from './channels/config.js'

export async function runChannelCli(argv: string[]): Promise<void> {
  const [channel, action, ...rest] = argv

  if (channel === 'list') {
    const config = loadChannelConfig()
    const feishu = config.feishu
    console.log(`feishu ${feishu.enabled ? 'enabled' : 'disabled'} ${feishu.webhook.host}:${feishu.webhook.port}${feishu.webhook.path}`)
    return
  }

  if (channel === 'feishu' && action === 'start') {
    if (rest.includes('--daemon')) {
      startDaemon()
      return
    }

    await startFeishuChannel()
    return
  }

  console.log(`Usage:
  lightclaw channel list
  lightclaw channel feishu start [--daemon]
`)
}

function startDaemon(): void {
  const args = process.argv.slice(1).filter(arg => arg !== '--daemon')
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  console.log(`lightclaw channel daemon started: pid ${child.pid}`)
}
