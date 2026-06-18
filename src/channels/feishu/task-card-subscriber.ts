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
import { t } from '../../i18n/index.js'
import type { TaskRunMeta } from '../../taskrun/types.js'
import { deriveTaskCardView } from './task-card-view.js'
import { parseFeishuSessionId } from './routing.js'
import { getFeishuSender } from './sender-registry.js'
import {
  getTaskRun,
  listTaskRunOwners,
  listTaskRuns,
  onTaskRunEvent,
} from '../../taskrun/store.js'

export type TaskCardPipeline = {
  /** Re-render roots that moved while the process was down. */
  reconcileOnStart(): Promise<void>
  stop(): void
}

/** The summary settlement message: title line + the run's deliver summary,
 *  @-ing the owner in groups. Since the final-text-delivery change this is
 *  NO LONGER sent on the live freeze frame — the user's conclusion is the
 *  agent's own closing block, which `routeSyntheticBlock` (runner.ts) sends
 *  to chat for a concluding wake. This text now serves two purposes: the
 *  card's frozen label, and the crash backstop below — `reconcileOnStart`
 *  sends it for a root that reached terminal while the daemon was down, where
 *  no live turn ever delivered a conclusion. */
function settlementText(root: TaskRunMeta): string {
  const key = root.status === 'done'
    ? 'taskcard.delivery.done'
    : root.status === 'failed'
      ? 'taskcard.delivery.failed'
      : 'taskcard.delivery.cancelled'
  const titleLine = t(key, { title: root.title })
  const summary = root.outcome?.summary?.trim()
  // In group chats the settlement message pings the user who owns the
  // task — it is the long task's conclusion and must not scroll past
  // unnoticed. lark_md mention syntax; DMs carry no mention.
  const parsed = parseFeishuSessionId(root.callerSessionId)
  const mention = parsed?.kind === 'group' && parsed.senderOpenId
    ? `<at id=${parsed.senderOpenId}></at> `
    : ''
  return summary ? `${mention}${titleLine}\n${summary}` : `${mention}${titleLine}`
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
    async sendText(target, text) {
      const sender = getFeishuSender()
      if (!sender) return
      await createSenderTaskCardIo(sender).sendText(target, text)
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
      const target = {
        chatId: parsed.chatId,
        ...(parsed.kind === 'group' && parsed.threadId ? { threadId: parsed.threadId } : {}),
        ...(replyAnchorMessageId ? { replyAnchorMessageId } : {}),
      }
      await writeTaskCardBinding(owner, rootRunId, {
        ...target,
        messageId: created.messageId,
        ...(created.cardId ? { cardId: created.cardId } : {}),
        ...(created.sequence !== undefined ? { cardSequence: created.sequence } : {}),
        ...(terminal ? { finalizedAt: Date.now() } : {}),
      })
      if (terminal) {
        // Settle a live cardkit card so streaming_mode turns off (the typing
        // indicator stops); a non-live im.message.patch card has no streaming
        // state to close. Freeze only otherwise — the user-facing conclusion is
        // the agent's own closing block sent by the runner at end-of-turn.
        if (created.cardId && io.close) {
          await io.close({
            cardId: created.cardId,
            sequence: created.sequence ?? 0,
            summary: view.root.title,
          })
        }
        patcher.release(rootRunId)
      }
      return
    }

    const patched = await io.patch(
      binding.messageId,
      card,
      binding.cardId
        ? { cardId: binding.cardId, sequence: binding.cardSequence ?? 0 }
        : undefined,
    )
    if (terminal) {
      // Settle a live cardkit card (streaming_mode off) before stamping the
      // freeze; a non-live card has no streaming state to close.
      let finalSequence = patched?.sequence
      if (binding.cardId && io.close) {
        const closed = await io.close({
          cardId: binding.cardId,
          sequence: finalSequence ?? binding.cardSequence ?? 0,
          summary: view.root.title,
        })
        finalSequence = closed.sequence
      }
      await writeTaskCardBinding(owner, rootRunId, {
        ...binding,
        ...(finalSequence !== undefined ? { cardSequence: finalSequence } : {}),
        finalizedAt: Date.now(),
      })
      patcher.release(rootRunId)
    } else if (patched?.sequence !== undefined) {
      await writeTaskCardBinding(owner, rootRunId, {
        ...binding,
        cardSequence: patched.sequence,
      })
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
          // existed and missed its final frame. `!finalizedAt` also means
          // no live end-of-turn settlement ran (the runner sets the freeze
          // path in motion as part of the same terminal event it concludes
          // on), so this is the crash backstop for the user-facing
          // conclusion — send the summary settlement before freezing. A root
          // finalized live already had its conclusion delivered by the runner
          // and is skipped here, so this never double-sends on a clean run.
          const binding = await readTaskCardBinding(owner, root.id)
          if (binding && !binding.finalizedAt) {
            await io.sendText(
              {
                chatId: binding.chatId,
                ...(binding.threadId ? { threadId: binding.threadId } : {}),
                ...(binding.replyAnchorMessageId
                  ? { replyAnchorMessageId: binding.replyAnchorMessageId }
                  : {}),
              },
              settlementText(root),
            )
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
