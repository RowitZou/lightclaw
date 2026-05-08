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
import {
  PairingCardCoordinator,
  type PairingCardAction,
} from './pairing-card.js'
import { PendingNoticeDrainer } from './pending-drainer.js'
import { PendingQueueStore } from './pending-queue.js'
import { FeishuPermissionCoordinator } from './permission-card.js'
import type { FeishuCardAction } from './permission-card.js'
import { FeishuSender } from './sender.js'
import { clearChannelRunner, registerChannelRunner } from './runner-registry.js'
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
        `feishu: starting transport=${config.transport} encryption=${config.encryptKey ? 'on' : 'off'} allowUsers=${summarizeAllowList(config.allowUsers)} allowChats=${summarizeAllowList(config.allowChats)} requireMention=${config.requireMention ? 'on' : 'off'} permissionMode=${config.permissionMode}\n`,
      )

      const client = createFeishuClient(config)
      const botSelf = await fetchBotSelfInfo(client, config.requireMention)
      const sender = new FeishuSender(client, config)

      // Persistent pending-notice queue + drainer. Catches the >60s outage
      // gap that the in-process sender backoff can't cover (sender doc
      // explicitly defers persistence to this layer). On daemon startup
      // we drain whatever survived a previous shutdown before serving new
      // traffic; the recurring interval handles ongoing transient
      // failures.
      const pendingDir = path.join(lightclawHome(), 'state', 'feishu')
      const pendingStore = new PendingQueueStore(pendingDir)
      sender.attachPendingStore(pendingStore)
      const pendingDrainer = new PendingNoticeDrainer(pendingStore, sender)
      pendingDrainer.start()

      // Register the sender on a module-level slot so paths outside the
      // channel runner (notably /user approve in commands/builtin.ts) can
      // push proactive cards. Cleared in stop() so a restart re-registers.
      registerFeishuSender(sender)
      const permissionCoordinator = new FeishuPermissionCoordinator(sender)
      const bgCardCoordinator = new BackgroundTaskCardCoordinator(sender)
      const pairingCoordinator = new PairingCardCoordinator(sender)
      registerBackgroundTaskCardCoordinator(bgCardCoordinator)
      const runner = new ChannelRunner(
        createFeishuStrategy(config, sender, client, permissionCoordinator, pairingCoordinator, botSelf),
      )
      await runner.initialize()
      // Expose the runner so post-approval replay can inject a synthetic
      // inbound message carrying the applicant's pre-approval text. Cleared
      // alongside the sender on stop().
      registerChannelRunner(runner)

      const dedup = new FeishuDedup(
        path.join(lightclawHome(), 'state', 'feishu-dedup.json'),
      )

      const onMessage = async (raw: FeishuRawMessage): Promise<void> => {
        process.stderr.write(
          `feishu: inbound event=${raw.eventId} message=${raw.messageId}\n`,
        )
        // Sender info is fetched lazily in the runner's pairing branch. The
        // strategy returns undefined on contact-scope or network failures so
        // the card flow degrades to open_id without blocking inbound routing.
        const message: NormalizedChannelMessage = {
          channel: FEISHU_CHANNEL_ID,
          eventId: raw.eventId,
          chatId: raw.chatId,
          senderOpenId: raw.senderOpenId,
          senderKey: `feishu:${raw.senderOpenId}`,
          chatType: raw.chatType,
          messageId: raw.messageId,
          threadId: raw.threadId,
          rootId: raw.rootId,
          feishuMentions: raw.mentions,
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
          botOpenId: botSelf.openId,
          onMessage,
          onCardAction: action => {
            if ('kind' in action && action.kind === 'background_task') {
              return bgCardCoordinator.handleCardAction(action)
            }
            if ('kind' in action && action.kind === 'lightclaw_pairing') {
              return pairingCoordinator.handleCardAction(action as PairingCardAction)
            }
            return permissionCoordinator.handleCardAction(action as FeishuCardAction)
          },
        })
        process.stderr.write('feishu: ws client started (long-lived subscription, no public ingress)\n')
        return {
          stop: () => {
            pendingDrainer.stop()
            clearFeishuSender(sender)
            clearChannelRunner(runner)
            clearBackgroundTaskCardCoordinator(bgCardCoordinator)
            return handle.close()
          },
        }
      }

      const server = await startFeishuWebhookServer({
        config,
        dedup,
        botOpenId: botSelf.openId,
        onMessage,
      })
      const { host, port, path: webhookPath } = config.webhook
      process.stderr.write(`feishu: webhook listening on ${host}:${port}${webhookPath}\n`)
      return {
        stop: () => {
          pendingDrainer.stop()
          clearFeishuSender(sender)
          clearBackgroundTaskCardCoordinator(bgCardCoordinator)
          return server.close()
        },
      }
    },
  }
}

async function fetchBotSelfInfo(
  client: unknown,
  requireMention: boolean,
): Promise<{ openId?: string; name?: string }> {
  if (!requireMention) {
    return {}
  }
  try {
    const typed = client as {
      bot?: { v3?: { info?: { get?: () => Promise<unknown> } } }
      formatPayload?: () => Promise<{ headers?: Record<string, unknown> }>
      httpInstance?: { request?: (opts: Record<string, unknown>) => Promise<unknown> }
      domain?: string
    }
    const resp = typed.bot?.v3?.info?.get
      ? await typed.bot.v3.info.get()
      : await requestBotInfo(typed)
    // Feishu's /open-apis/bot/v3/info response per
    // https://open.feishu.cn/document/server-docs/im-v1/bot/get is
    //   { code: 0, msg: "success", bot: { open_id, app_name, ... } }
    // The `bot` field lives at the envelope ROOT, not under `data`. Some SDK
    // builds additionally wrap the body under `data` after their interceptor
    // pass — accept either shape so unwrapping never silently drops the
    // open_id we need to power Phase 26 mention gating + the bot-mention
    // strip path. Pre-fix dogfood symptom: stderr "code=0; mention gating
    // disabled", botSelf.openId undefined, and `@LightClaw /model` in
    // groups never reaches dispatchChannelSlash because parseMessageContent
    // can't strip the bot mention.
    const envelope = resp as {
      code?: number
      msg?: string
      bot?: { open_id?: string; app_name?: string }
      data?: { bot?: { open_id?: string; app_name?: string } }
    } | undefined
    const botData = envelope?.bot ?? envelope?.data?.bot
    if (envelope?.code === 0 && botData?.open_id) {
      return {
        openId: botData.open_id,
        name: botData.app_name,
      }
    }
    process.stderr.write(
      `[feishu] bot.v3.info.get returned code=${envelope?.code ?? 'unknown'} bot=${botData?.open_id ? 'present' : 'missing'}; mention gating disabled\n`,
    )
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[feishu] failed to fetch bot self info: ${detail}; mention gating disabled\n`)
  }
  return {}
}

async function requestBotInfo(client: {
  formatPayload?: () => Promise<{ headers?: Record<string, unknown> }>
  httpInstance?: { request?: (opts: Record<string, unknown>) => Promise<unknown> }
  domain?: string
}): Promise<unknown> {
  if (!client.httpInstance?.request) {
    return undefined
  }
  const headers = (await client.formatPayload?.())?.headers ?? {}
  const url = `${client.domain ?? 'https://open.feishu.cn'}/open-apis/bot/v3/info`
  const getResp = await client.httpInstance.request({ url, method: 'GET', headers })
  if ((getResp as { code?: number } | undefined)?.code === 0) {
    return getResp
  }
  const postResp = await client.httpInstance.request({ url, method: 'POST', headers })
  return postResp ?? getResp
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
