import { spawn } from 'node:child_process'

import { loadChannelConfig } from './channels/config.js'
import { runWechatLoginCli } from './channels/wechat/auth/login-qr.js'
import {
  getChannel,
  knownChannelIds,
  listChannels,
} from './channels/registry.js'
import { cleanupMcp } from './mcp/index.js'

export async function runChannelCli(argv: string[]): Promise<void> {
  const [channelArg, action, ...rest] = argv

  if (!channelArg) {
    printUsage()
    return
  }

  if (channelArg === 'list') {
    const config = loadChannelConfig()
    for (const channel of listChannels(config)) {
      console.log(channel.statusLine())
    }
    return
  }

  if (!action) {
    printUsage()
    return
  }

  const config = loadChannelConfig()
  const channel = getChannel(config, channelArg)
  if (!channel) {
    console.error(
      `unknown channel: ${channelArg}. known: ${knownChannelIds().join(', ')}`,
    )
    process.exitCode = 1
    return
  }

  if (action === 'login') {
    if (channelArg !== 'wechat') {
      console.error(`channel ${channelArg} does not support login (use webhook config instead)`)
      process.exitCode = 1
      return
    }
    await runWechatLoginCli()
    return
  }

  if (action !== 'start') {
    printUsage()
    return
  }

  if (rest.includes('--daemon')) {
    startDaemon()
    return
  }

  const handle = await channel.start()
  await waitForShutdownSignal()
  await handle.stop()
  await cleanupMcp()
}

function printUsage(): void {
  const ids = knownChannelIds().join('|')
  console.log(`Usage:
  lightclaw channel list
  lightclaw channel <${ids}> start [--daemon]
  lightclaw channel wechat login
`)
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise<void>(resolve => {
    const done = () => {
      process.off('SIGINT', done)
      process.off('SIGTERM', done)
      resolve()
    }
    process.once('SIGINT', done)
    process.once('SIGTERM', done)
  })
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
