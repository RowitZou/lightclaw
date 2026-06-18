// Manual smoke for Feishu CardKit streaming cards (feishu-cards PR1). NOT in CI.
//
// Validates against the REAL Feishu API what unit tests cannot: cardkit
// entity creation, sending that entity as an interactive message, streaming
// text pushes, close settings, SDK method names, app permissions, and proxy.
//
// Usage:
//   pnpm tsx scripts/smoke-feishu-cardkit-streaming.ts --config <config.json> \
//     --chat <oc_chat_id> [--anchor <om_message_id>] [--text "..."] [--delay-ms 350]
//
// `--anchor` sends by im.message.reply, which is required for topic groups.
// Verify by eye in the Feishu client: the card should type text into one
// markdown element, then stop streaming after the close call.

import { readFileSync } from 'node:fs'

import { createFeishuClient } from '../src/channels/feishu/client.js'
import {
  buildCardkitCardReferenceContent,
  buildCardkitCloseSettings,
  buildCardkitStreamingSpikeCard,
  runCardkitStreamingSpike,
  splitStreamingSpikeText,
} from '../src/channels/feishu/cardkit-spike.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

async function main(): Promise<void> {
  const configPath = arg('config')
  const chatId = arg('chat')
  const dryRun = hasFlag('dry-run')
  if ((!configPath || !chatId) && !dryRun) {
    process.stderr.write(
      'usage: --config <config.json> --chat <oc_...> [--anchor <om_...>] [--text "..."] [--delay-ms 350] [--dry-run]\n',
    )
    process.exit(1)
  }

  const text =
    arg('text') ??
    'LightClaw CardKit streaming spike: 第一段正在逐字输出。第二段继续推送，最后关闭 streaming mode。'
  const delayMs = Number(arg('delay-ms') ?? '350')

  if (dryRun) {
    const fakeCardId = 'card_xxx'
    process.stdout.write(`card.create payload:\n${JSON.stringify({
      data: { type: 'card_json', data: JSON.stringify(buildCardkitStreamingSpikeCard()) },
    }, null, 2)}\n`)
    process.stdout.write(`message content:\n${buildCardkitCardReferenceContent(fakeCardId)}\n`)
    process.stdout.write(`push chunks:\n${JSON.stringify(splitStreamingSpikeText(text), null, 2)}\n`)
    process.stdout.write(`close settings:\n${buildCardkitCloseSettings(text)}\n`)
    return
  }

  const config = JSON.parse(readFileSync(configPath!, 'utf8'))
  const feishuConfig = config.channels?.feishu
  if (!feishuConfig?.appId || !feishuConfig?.appSecret) {
    process.stderr.write('config has no channels.feishu.appId/appSecret\n')
    process.exit(1)
  }

  process.stdout.write(
    `sending CardKit streaming spike to chat=${chatId} anchor=${arg('anchor') ?? '-'} delayMs=${delayMs}\n`,
  )
  const client = createFeishuClient(feishuConfig)
  const result = await runCardkitStreamingSpike(client, {
    chatId,
    replyToMessageId: arg('anchor'),
    text,
    delayMs: Number.isFinite(delayMs) ? delayMs : 350,
    log: line => process.stdout.write(`${line}\n`),
  })

  process.stdout.write(
    `smoke done: cardId=${result.cardId} messageId=${result.messageId ?? '(missing)'} pushes=${result.pushes} finalSequence=${result.finalSequence}\n`,
  )
  process.stdout.write(
    'manual gate: confirm in Feishu that the card streamed visibly and stopped after close.\n',
  )
}

void main()
