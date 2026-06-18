import path from 'node:path'

import { t } from '../../i18n/index.js'
import { lightclawHome } from '../../paths.js'
import { ChannelRunner } from '../runner.js'
import type {
  Channel,
  ChannelHandle,
  FeishuChannelConfig,
  NormalizedChannelMessage,
  PendingAttachment,
} from '../types.js'
import type { FeishuRawMessage } from './bot-content.js'
import { clearFeishuClient, createFeishuClient, registerFeishuClient } from './client.js'
import { FeishuDedup } from './dedup.js'
import { fileNameFor } from './media.js'
import {
  PairingCardCoordinator,
  type PairingCardAction,
} from './pairing-card.js'
import { ParentMessageFetcher, type ParsedParent } from './parent-fetch.js'
import { PendingNoticeDrainer } from './pending-drainer.js'
import { PendingQueueStore } from './pending-queue.js'
import { FeishuPermissionCoordinator } from './permission-card.js'
import type { FeishuCardAction } from './permission-card.js'
import { FeishuSender } from './sender.js'
import {
  AskUserQuestionCoordinator,
  abortAskUserQuestionsBySession,
  clearAskUserQuestionCoordinator,
  registerAskUserQuestionCoordinator,
  type AskUserCardAction,
} from './askuser-card.js'
import {
  CircuitBreakerCardCoordinator,
  clearCircuitBreakerCardCoordinator,
  registerCircuitBreakerCardCoordinator,
  type CircuitBreakerCardAction,
} from './circuit-breaker-card.js'
import { AskUserScheduler } from './askuser-scheduler.js'
import { registerSessionAbortHook } from '../../state.js'
import { getBackgroundTaskScheduler } from '../../background-task/scheduler.js'
import { clearChannelRunner, registerChannelRunner } from './runner-registry.js'
import { startTaskCardPipeline } from './task-card-subscriber.js'
import { setTaskCardPipeline } from './task-card-pipeline-registry.js'
import { clearFeishuSender, registerFeishuSender } from './sender-registry.js'
import { createFeishuStrategy, FEISHU_CHANNEL_ID } from './strategy.js'
import { startFeishuWebhookServer } from './transport-webhook.js'
import { startFeishuWsClient, type FeishuRecallEvent } from './transport-ws.js'
import { formatFeishuErrorForLog } from './resources/errors.js'

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
      const parentFetcher = new ParentMessageFetcher(client, {
        ...(config.parentFetchTimeoutMs > 0
          ? { fetchTimeoutMs: config.parentFetchTimeoutMs }
          : {}),
      })
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
      registerFeishuClient(client)
      const permissionCoordinator = new FeishuPermissionCoordinator(sender)
      const pairingCoordinator = new PairingCardCoordinator(sender)
      const askUserCoordinator = new AskUserQuestionCoordinator(sender)
      const circuitBreakerCoordinator = new CircuitBreakerCardCoordinator(sender, {
        fireImmediate: (canonicalUser, taskId) =>
          getBackgroundTaskScheduler().fireImmediate(canonicalUser, taskId),
        rearmSchedule: (canonicalUser, taskId) =>
          getBackgroundTaskScheduler().notifyTaskChanged(canonicalUser, taskId),
      })
      const askUserScheduler = new AskUserScheduler()
      registerAskUserQuestionCoordinator(askUserCoordinator)
      registerCircuitBreakerCardCoordinator(circuitBreakerCoordinator)
      // Bridge `/stop` (state.ts) to the AskUser coordinator without
      // making state.ts depend on the feishu module. state.ts only knows
      // about an opaque session abort hook; we register ours here.
      const disposeAskUserAbortHook = registerSessionAbortHook(sessionId =>
        abortAskUserQuestionsBySession(sessionId),
      )
      await askUserCoordinator.crashResume()
      askUserScheduler.start()
      const runner = new ChannelRunner(
        createFeishuStrategy(config, sender, client, permissionCoordinator, pairingCoordinator, botSelf),
      )
      await runner.initialize()
      // Expose the runner so post-approval replay can inject a synthetic
      // inbound message carrying the applicant's pre-approval text. Cleared
      // alongside the sender on stop().
      registerChannelRunner(runner)

      // Per-root task cards follow the TaskRun ledger. The startup
      // reconcile is fire-and-forget: it re-renders roots that moved while
      // the daemon was down and must never delay channel start.
      const taskCardPipeline = startTaskCardPipeline()
      setTaskCardPipeline(taskCardPipeline)
      void taskCardPipeline.reconcileOnStart()

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
          parentId: raw.parentId,
          feishuMentions: raw.mentions,
          text: raw.text,
        }
        const pendingAttachments: PendingAttachment[] = []
        if (raw.mediaKeys?.length && config.mediaEnabled) {
          // One PendingAttachment per parsed mediaKey. Multi-image batches
          // arrive either as N separate `image`-type events (one mediaKey
          // each) or as a single `post` event whose content array carries
          // multiple `<img>`/`<file>` tags — `parsePostContent` extracts
          // them all into `mediaKeys[]`. The runner-side cap on inline
          // blocks (config.attachments.maxInlinePerTurn) decides which of
          // these end up in the LLM-facing content array vs the text-path
          // breadcrumb; the channel adapter materializes every one so
          // overflow paths are still agent-readable via Read.
          pendingAttachments.push(...raw.mediaKeys.map(mediaKey => ({
            kind: 'feishu-media' as const,
            messageId: raw.messageId,
            mediaKey,
            fileName: fileNameFor(raw.messageId, mediaKey),
          })))
        } else if (raw.mediaKeys?.length) {
          // Model-facing breadcrumb stays English per i18n notes.
          message.text = appendLine(message.text, '[media attachment: skipped (mediaEnabled=false)]')
        }
        if (raw.parentId) {
          const parent = await parentFetcher.fetch(raw.parentId, botSelf.openId)
          if (parent) {
            const attachedFileNames: string[] = []
            if (config.mediaEnabled) {
              for (const mediaKey of parent.mediaKeys) {
                const fileName = fileNameFor(raw.parentId, mediaKey)
                pendingAttachments.push({
                  kind: 'feishu-media',
                  messageId: raw.parentId,
                  mediaKey,
                  fileName,
                  quotedFromMessageId: raw.parentId,
                })
                attachedFileNames.push(fileName)
              }
            }
            if (parent.text || attachedFileNames.length > 0) {
              message.quotedMessage = {
                author: resolveQuotedAuthorLabel(parent, botSelf),
                ...(parent.isFromBot ? { authorIsBot: true } : {}),
                ...(parent.text ? { text: parent.text } : {}),
                ...(attachedFileNames.length > 0 ? { attachedFileNames } : {}),
                ...(parent.truncated ? { truncated: true } : {}),
              }
            }
          } else {
            // Parent fetch failed (timeout / 5xx / parent gone / scope denied
            // / empty body). Without a sentinel here the runner would render a
            // plain user text and the model would see no trace of the quote
            // the user actually attached — confusing the user when the model
            // ignores or hallucinates the quoted content. The marker tells
            // the model "a quote existed but harness could not load it" and
            // suggests asking the user to retry / re-send.
            const failure = parentFetcher.getLastFailure(raw.parentId)
            message.quoteUnavailable = failure ?? { permanent: false, reason: 'unknown' }
          }
        }
        if (pendingAttachments.length > 0) {
          message.pendingAttachments = pendingAttachments
        }
        await runner.handleMessage(message)
      }

      // A user recalling a message Feishu only tells us the message_id +
      // chat_id about — no sender open_id, so the runner maps it back to a
      // sessionId through the in-flight opener registry. If it opened a
      // still-running turn, that turn is aborted; if it is a queued
      // interjection, it is dropped before reaching the model.
      const onRecall = async (recall: FeishuRecallEvent): Promise<void> => {
        process.stderr.write(
          `feishu: recall event=${recall.eventId} message=${recall.messageId}\n`,
        )
        await runner.handleRecall(recall)
      }

      if (config.transport === 'ws') {
        const handle = await startFeishuWsClient({
          config,
          dedup,
          botOpenId: botSelf.openId,
          onMessage,
          onRecall,
          onCardAction: action => {
            if ('kind' in action && action.kind === 'lightclaw_pairing') {
              return pairingCoordinator.handleCardAction(action as PairingCardAction)
            }
            if ('kind' in action && action.kind === 'lightclaw_askuser') {
              return askUserCoordinator.handleCardAction(action as AskUserCardAction)
            }
            if ('kind' in action && action.kind === 'lightclaw_circuit_breaker') {
              return circuitBreakerCoordinator.handleCardAction(action as CircuitBreakerCardAction)
            }
            return permissionCoordinator.handleCardAction(action as FeishuCardAction)
          },
        })
        process.stderr.write('feishu: ws client started (long-lived subscription, no public ingress)\n')
        return {
          stop: () => {
            pendingDrainer.stop()
            disposeAskUserAbortHook()
            askUserScheduler.stop()
            taskCardPipeline.stop()
            setTaskCardPipeline(null)
            clearAskUserQuestionCoordinator(askUserCoordinator)
            clearCircuitBreakerCardCoordinator(circuitBreakerCoordinator)
            clearFeishuSender(sender)
            clearFeishuClient(client)
            clearChannelRunner(runner)
            return handle.close()
          },
        }
      }

      const server = await startFeishuWebhookServer({
        config,
        dedup,
        botOpenId: botSelf.openId,
        onMessage,
        onRecall,
      })
      const { host, port, path: webhookPath } = config.webhook
      process.stderr.write(`feishu: webhook listening on ${host}:${port}${webhookPath}\n`)
      return {
        stop: () => {
          pendingDrainer.stop()
          askUserScheduler.stop()
          taskCardPipeline.stop()
          setTaskCardPipeline(null)
          clearAskUserQuestionCoordinator(askUserCoordinator)
          clearCircuitBreakerCardCoordinator(circuitBreakerCoordinator)
          clearFeishuSender(sender)
          clearFeishuClient(client)
          return server.close()
        },
      }
    },
  }
}

type BotSelfInfo = {
  openId?: string
  name?: string
}

function resolveQuotedAuthorLabel(parent: ParsedParent, botSelf: BotSelfInfo): string {
  if (parent.isFromBot) {
    return botSelf.name ?? 'LightClaw'
  }
  return parent.senderName
    ?? (parent.senderOpenId ? `@user_${parent.senderOpenId.slice(-4)}` : 'unknown sender')
}

async function fetchBotSelfInfo(
  client: unknown,
  requireMention: boolean,
): Promise<BotSelfInfo> {
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
    process.stderr.write(`[feishu] failed to fetch bot self info: ${formatFeishuErrorForLog(error, 'bot.v3.info.get')}; mention gating disabled\n`)
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
