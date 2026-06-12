// Task-card pipeline: ledger events drive the per-root live card (PR21).
//
// One in-process tap on the TaskRun store schedules a level-triggered
// re-render of the affected root's card: read current store state, build
// the full card, create or patch in place. Lifecycle: root created →
// card created (immediate); tree events → throttled patches; root reaches
// a terminal state → one final freeze render, `finalizedAt` lands in the
// sidecar and the root never renders again (standing service roots never
// freeze). A startup reconcile re-renders whatever moved while the daemon
// was down — the listener tap dies with the process, the ledger does not.
//
// Everything is best-effort: a failed render drops the frame and the next
// event re-renders from state; nothing here may throw into the ledger
// write path or a turn.

import { getInboundAnchor } from '../inbound-anchor.js'
import { readTaskCardBinding, writeTaskCardBinding } from './task-card-binding.js'
import {
  createSenderTaskCardIo,
  TaskCardPatcher,
  type TaskCardIo,
} from './task-card-patcher.js'
import { buildTaskCard, TASK_RUN_TERMINAL_STATUSES } from './task-card.js'
import { deriveTaskCardView } from './task-card-view.js'
import { parseFeishuSessionId } from './routing.js'
import { getFeishuSender } from './sender-registry.js'
import {
  getTaskRun,
  listTaskRunOwners,
  listTaskRuns,
  onTaskRunEvent,
} from '../../taskrun/store.js'
import type { TaskRunMeta } from '../../taskrun/types.js'

export type TaskCardPipeline = {
  /** Re-render roots that moved while the process was down. */
  reconcileOnStart(): Promise<void>
  stop(): void
}

function defaultIo(): TaskCardIo {
  return {
    async create(target, card) {
      const sender = getFeishuSender()
      if (!sender) return {}
      return createSenderTaskCardIo(sender).create(target, card)
    },
    async patch(messageId, card) {
      const sender = getFeishuSender()
      if (!sender) return
      await createSenderTaskCardIo(sender).patch(messageId, card)
    },
  }
}

export function startTaskCardPipeline(
  options: { io?: TaskCardIo; throttleMs?: number } = {},
): TaskCardPipeline {
  const io = options.io ?? defaultIo()
  const patcher = options.throttleMs !== undefined
    ? new TaskCardPatcher(options.throttleMs)
    : new TaskCardPatcher()

  async function render(owner: string, rootRunId: string): Promise<void> {
    const root = await getTaskRun(rootRunId, owner)
    if (!root || root.kind !== 'root') return
    const binding = await readTaskCardBinding(owner, rootRunId)
    if (binding?.finalizedAt) {
      patcher.release(rootRunId)
      return
    }
    const view = await deriveTaskCardView(owner, rootRunId)
    if (!view) return
    const card = buildTaskCard(view)
    // A live standing service never reaches a terminal status; once its
    // root IS terminal (service shut down) the card freezes like any other.
    const terminal = TASK_RUN_TERMINAL_STATUSES.has(root.status)

    if (!binding) {
      // The root's caller session names the chat the card belongs to.
      // Non-Feishu callers (tests, future channels) simply have no card.
      const parsed = parseFeishuSessionId(root.callerSessionId)
      if (!parsed) return
      const replyAnchorMessageId = parsed.kind === 'group' && parsed.threadId
        ? getInboundAnchor(root.callerSessionId)
        : undefined
      const created = await io.create(
        {
          chatId: parsed.chatId,
          ...(parsed.kind === 'group' && parsed.threadId ? { threadId: parsed.threadId } : {}),
          ...(replyAnchorMessageId ? { replyAnchorMessageId } : {}),
        },
        card,
      )
      if (!created.messageId) return
      await writeTaskCardBinding(owner, rootRunId, {
        chatId: parsed.chatId,
        ...(parsed.kind === 'group' && parsed.threadId ? { threadId: parsed.threadId } : {}),
        ...(replyAnchorMessageId ? { replyAnchorMessageId } : {}),
        messageId: created.messageId,
        ...(terminal ? { finalizedAt: Date.now() } : {}),
      })
      if (terminal) patcher.release(rootRunId)
      return
    }

    await io.patch(binding.messageId, card)
    if (terminal) {
      await writeTaskCardBinding(owner, rootRunId, { ...binding, finalizedAt: Date.now() })
      patcher.release(rootRunId)
    }
  }

  function schedule(owner: string, rootRunId: string, immediate: boolean): void {
    patcher.schedule(rootRunId, () => render(owner, rootRunId), { immediate })
  }

  const unsubscribe = onTaskRunEvent((owner, _runId, event, meta) => {
    const rootRunId = meta.rootRunId
    if (!rootRunId) return
    // Immediate frames: the root's own birth (create the card right away)
    // and any event that lands a root in a terminal state (freeze now).
    const isRootBirth = event.kind === 'created' && meta.kind === 'root' && meta.id === rootRunId
    const isRootTerminal =
      meta.id === rootRunId && TASK_RUN_TERMINAL_STATUSES.has(meta.status)
    schedule(owner, rootRunId, isRootBirth || isRootTerminal)
  })

  async function reconcileOnStart(): Promise<void> {
    let owners: string[]
    try {
      owners = await listTaskRunOwners()
    } catch (error) {
      process.stderr.write(
        `[task-card] startup reconcile failed to list owners: ${(error as Error).message}\n`,
      )
      return
    }
    for (const owner of owners) {
      try {
        const runs = await listTaskRuns(owner, { scope: 'all' })
        const roots = runs.filter((run): run is TaskRunMeta => run.kind === 'root')
        for (const root of roots) {
          const terminal = TASK_RUN_TERMINAL_STATUSES.has(root.status)
          if (!terminal) {
            schedule(owner, root.id, false)
            continue
          }
          // Terminal while we were down: freeze the card once if it ever
          // existed and missed its final frame.
          const binding = await readTaskCardBinding(owner, root.id)
          if (binding && !binding.finalizedAt) {
            schedule(owner, root.id, true)
          }
        }
      } catch (error) {
        process.stderr.write(
          `[task-card] startup reconcile failed for ${owner}: ${(error as Error).message}\n`,
        )
      }
    }
  }

  return {
    reconcileOnStart,
    stop: unsubscribe,
  }
}
