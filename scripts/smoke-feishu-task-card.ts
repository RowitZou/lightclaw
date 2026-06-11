// Manual smoke for the Feishu task card (collab-phase4 PR20). NOT in CI.
//
// Validates against the REAL Feishu API what no unit test can: the card
// 2.0 schema with `collapsible_panel` is accepted on BOTH the create and
// patch paths, multiple sibling panels render, the size-budgeted card
// stays under platform limits, and (topic groups) creation works through
// the reply-anchor path. Optionally probes one NESTED panel — result is
// recorded only; the shipped design never nests.
//
// Usage (run from a checkout, daemon credentials in the given config):
//   pnpm tsx scripts/smoke-feishu-task-card.ts --config <config.json> \
//     --chat <oc_chat_id> [--thread <omt_thread_id>] [--anchor <om_message_id>] \
//     [--probe-nested]
//
//   --chat    target chat (DM or group chat_id). Run once per scenario:
//             DM, plain group, topic group (topic group REQUIRES --anchor,
//             an existing message in the target topic).
//   --probe-nested  send one extra card containing a panel inside a panel.
//
// Verify by eye in the Feishu client: panels collapsed by default, expand
// works on desktop AND mobile, patches land in place (5 rapid patches →
// one card showing the final frame), terminal patch freezes the header.

import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

import { createFeishuClient } from '../src/channels/feishu/client.js'
import { FeishuSender } from '../src/channels/feishu/sender.js'
import { createSenderTaskCardIo } from '../src/channels/feishu/task-card-patcher.js'
import {
  buildTaskCard,
  TASK_CARD_MAX_CHILD_TIMELINE,
  TASK_CARD_MAX_ROOT_TIMELINE,
  type TaskCardView,
} from '../src/channels/feishu/task-card.js'
import { setLang } from '../src/i18n/index.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function sampleView(step: number): TaskCardView {
  const now = Date.now()
  const at = (offset: number) => now - (10 - offset) * 60_000
  return {
    root: {
      id: 'smoke-run-0001',
      title: 'alphaxiv 今日论文阅读（smoke）',
      objective: '检索 alphaxiv 今日 Top-2 论文，下载 PDF 并写飞书阅读笔记',
      status: step >= 5 ? 'done' : 'running',
      updatedAt: now,
      ...(step >= 5 ? { terminalAt: now } : {}),
    },
    children: [
      {
        id: 'smoke-child-1',
        title: '创建论文阅读目录',
        role: 'feishuSecretary',
        status: 'done',
        timeline: [
          { at: at(1), text: '目录已创建' },
          { at: at(2), text: '补齐目录链接与 token' },
        ],
      },
      {
        id: 'smoke-child-2',
        title: '检索下载 Top-2 论文',
        role: 'webSearcher',
        status: step >= 4 ? 'delivered' : 'running',
        latestProgress: step >= 4 ? '两篇 PDF 已下载' : `正在下载第 ${step} 篇`,
        timeline: Array.from({ length: Math.min(step + 2, TASK_CARD_MAX_CHILD_TIMELINE + 2) }, (_, i) => ({
          at: at(3 + i),
          text: i % 3 === 2 ? `[webSearcher→localExplorer] 校验下载目录（第 ${i} 步）` : `检索推进第 ${i} 步`,
        })),
      },
      ...Array.from({ length: 11 }, (_, i) => ({
        id: `smoke-pad-${i}`,
        title: `溢出占位子任务 ${i}`,
        role: 'generalist',
        status: 'queued' as const,
        timeline: [],
      })),
    ],
    rootTimeline: Array.from({ length: TASK_CARD_MAX_ROOT_TIMELINE + 4 }, (_, i) => ({
      at: at(i),
      text: `主线叙事第 ${i} 条：${'内容'.repeat(10)}`,
    })),
  }
}

function nestedProbeCard(): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      template: 'grey',
      title: { tag: 'plain_text', content: 'nested collapsible_panel probe' },
    },
    body: {
      elements: [
        {
          tag: 'collapsible_panel',
          expanded: false,
          header: { title: { tag: 'markdown', content: '**outer panel**' } },
          elements: [
            { tag: 'markdown', content: 'outer line' },
            {
              tag: 'collapsible_panel',
              expanded: false,
              header: { title: { tag: 'markdown', content: '**inner panel**' } },
              elements: [{ tag: 'markdown', content: 'inner line' }],
            },
          ],
        },
      ],
    },
  }
}

async function main(): Promise<void> {
  const configPath = arg('config')
  const chatId = arg('chat')
  if (!configPath || !chatId) {
    process.stderr.write('usage: --config <config.json> --chat <oc_...> [--thread <omt_...>] [--anchor <om_...>] [--probe-nested]\n')
    process.exit(1)
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const feishuConfig = config.channels?.feishu
  if (!feishuConfig?.appId) {
    process.stderr.write('config has no channels.feishu.appId\n')
    process.exit(1)
  }
  setLang(config.lang ?? 'cn')

  const client = createFeishuClient(feishuConfig)
  const sender = new FeishuSender(client, feishuConfig)
  const io = createSenderTaskCardIo(sender)
  const target = {
    chatId,
    threadId: arg('thread'),
    replyAnchorMessageId: arg('anchor'),
  }

  process.stdout.write(`creating task card in ${chatId} (anchor=${target.replyAnchorMessageId ?? '-'})\n`)
  const created = await io.create(target, buildTaskCard(sampleView(0)))
  if (!created.messageId) {
    process.stderr.write('create returned no messageId — create path FAILED\n')
    process.exit(2)
  }
  process.stdout.write(`created messageId=${created.messageId}\n`)

  for (let step = 1; step <= 5; step += 1) {
    await delay(1000)
    await io.patch(created.messageId, buildTaskCard(sampleView(step)))
    process.stdout.write(`patched step ${step}${step >= 5 ? ' (terminal freeze)' : ''}\n`)
  }

  if (process.argv.includes('--probe-nested')) {
    process.stdout.write('probing nested panel (record result; design does not use nesting)\n')
    try {
      const nested = await io.create({ chatId: target.chatId, threadId: target.threadId, replyAnchorMessageId: target.replyAnchorMessageId }, nestedProbeCard())
      process.stdout.write(`nested probe accepted, messageId=${nested.messageId ?? '(none)'}\n`)
    } catch (error) {
      process.stdout.write(`nested probe REJECTED: ${(error as Error).message}\n`)
    }
  }

  process.stdout.write('smoke done — verify rendering in the Feishu client (desktop + mobile).\n')
}

void main()
