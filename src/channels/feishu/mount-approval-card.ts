import { getConfig } from '../../config.js'
import { t } from '../../i18n/index.js'
import {
  getAdminFeishuOpenId,
  getFeishuOpenIdForUser,
  isAdmin,
  lookupBySender,
  rebuildReverseIndex,
} from '../../identity/store.js'
import type { SenderKey } from '../../identity/types.js'
import { approveUserMountRw } from '../../commands/mount-ops.js'
import { revokeMountRw, type MountReport } from '../../runtime/mount-authz.js'
import { action as card2Action, button as card2Button, card2, markdown } from './card2.js'
import type { FeishuCardActionResponse } from './permission-card.js'
import type { FeishuSender } from './sender.js'
import { formatFeishuErrorForLog } from './resources/errors.js'

/** Card action emitted when an admin taps approve / reject on a read-write
 *  mount request. The persisted approval store is the source of truth, so the
 *  button payload only needs to identify which request. */
export type MountApprovalCardAction = {
  kind: 'lightclaw_mount_rw'
  action: 'approve' | 'reject'
  user: string
  fileset: string
  path: string
  operatorOpenId?: string
  openMessageId?: string
}

function buildApprovalCard(input: { user: string; path: string; fileset: string }): Record<string, unknown> {
  return card2({
    template: 'yellow',
    title: t('channel.mount.rw.title'),
    elements: [
      markdown([
        t('channel.mount.rw.requester', { user: input.user }),
        t('channel.mount.rw.path', { path: input.path }),
      ].join('\n')),
      card2Action([
        card2Button({
          text: t('channel.mount.rw.btnApprove'),
          type: 'primary',
          value: {
            kind: 'lightclaw_mount_rw',
            action: 'approve',
            user: input.user,
            fileset: input.fileset,
            path: input.path,
          },
        }),
        card2Button({
          text: t('channel.mount.rw.btnReject'),
          type: 'danger',
          value: {
            kind: 'lightclaw_mount_rw',
            action: 'reject',
            user: input.user,
            fileset: input.fileset,
            path: input.path,
          },
        }),
      ]),
    ],
  })
}

type ResolvedOutcome = 'approved' | 'degraded' | 'unmountable' | 'rejected'

const RESOLVED_TEMPLATE: Record<ResolvedOutcome, string> = {
  approved: 'green',
  degraded: 'yellow',
  unmountable: 'yellow',
  rejected: 'grey',
}

function resolvedText(outcome: ResolvedOutcome): string {
  switch (outcome) {
    case 'approved': return t('channel.mount.rw.resolvedApproved')
    case 'degraded': return t('channel.mount.rw.resolvedDegraded')
    case 'unmountable': return t('channel.mount.rw.resolvedUnmountable')
    case 'rejected': return t('channel.mount.rw.resolvedRejected')
  }
}

function buildResolvedCard(input: {
  outcome: ResolvedOutcome
  user: string
  path: string
}): Record<string, unknown> {
  return card2({
    template: RESOLVED_TEMPLATE[input.outcome],
    title: t('channel.mount.rw.title'),
    elements: [
      markdown([
        t('channel.mount.rw.requester', { user: input.user }),
        t('channel.mount.rw.path', { path: input.path }),
        resolvedText(input.outcome),
      ].join('\n')),
    ],
  })
}

function buildNoticeCard(body: string): Record<string, unknown> {
  return card2({
    template: 'yellow',
    title: t('channel.mount.rw.title'),
    elements: [markdown(body)],
  })
}

/** Keep only the issues for one fileset, so a per-fileset action reports just
 *  its own outcome rather than every mount the user owns. */
function scopeReportToFileset(report: MountReport, fileset: string): MountReport {
  return {
    degraded: report.degraded.filter(issue => issue.fileset === fileset),
    unmountable: report.unmountable.filter(issue => issue.fileset === fileset),
  }
}

function toast(type: 'info' | 'error', content: string): FeishuCardActionResponse {
  return { toast: { type, content } }
}

export class MountApprovalCoordinator {
  constructor(private readonly sender: FeishuSender) {}

  /** Push an interactive approve/reject card to the admin's DM. Best-effort:
   *  if the admin has no Feishu binding, the request still sits in the store
   *  for the admin to act on via `/admin mount`. */
  async requestApproval(input: { user: string; path: string; fileset: string }): Promise<void> {
    const adminOpenId = await getAdminFeishuOpenId()
    if (!adminOpenId) {
      process.stderr.write('[mount-approval] admin has no Feishu binding; rw request left for /admin mount\n')
      return
    }
    await this.sender
      .sendInteractiveCardToOpenId(adminOpenId, buildApprovalCard(input))
      .catch(error => {
        process.stderr.write(`[mount-approval] failed to push approval card: ${formatFeishuErrorForLog(error, 'sendInteractiveCardToOpenId')}\n`)
      })
  }

  async handleCardAction(action: MountApprovalCardAction): Promise<FeishuCardActionResponse> {
    const operator = await this.assertAdminOperator(action.operatorOpenId)
    if (!operator) {
      return toast('error', t('channel.mount.rw.notAdmin'))
    }
    let outcome: ResolvedOutcome
    try {
      if (action.action === 'approve') {
        const result = await approveUserMountRw(action.user, action.fileset, getConfig())
        const scoped = scopeReportToFileset(result.report, action.fileset)
        outcome = scoped.unmountable.length > 0
          ? 'unmountable'
          : scoped.degraded.length > 0
            ? 'degraded'
            : 'approved'
        // The requester is not present at this card — push the read-only /
        // unmountable outcome to their DM so they know to act on the storage.
        await this.reportToUser(action.user, scoped)
      } else {
        // Reject: the request was never granted (an approved fileset never
        // re-enters pending), so dropping the pending entry is enough — no
        // sandbox rebuild needed.
        revokeMountRw(action.user, action.fileset)
        outcome = 'rejected'
      }
    } catch (error) {
      return toast('error', t('channel.mount.rw.error', {
        reason: error instanceof Error ? error.message : String(error),
      }))
    }
    if (action.openMessageId) {
      await this.sender
        .patchInteractiveCard(
          action.openMessageId,
          buildResolvedCard({ outcome, user: action.user, path: action.path }),
        )
        .catch(() => {})
    }
    return {}
  }

  /** Push a read-only-degrade / unmountable report to a requester's DM.
   *  Best-effort: silently no-ops when the report is clean or the user has no
   *  Feishu binding. */
  async reportToUser(user: string, report: MountReport): Promise<void> {
    const lines: string[] = []
    if (report.degraded.length > 0) {
      lines.push(t('mount.report.degraded', { paths: report.degraded.map(i => i.path).join(', ') }))
    }
    if (report.unmountable.length > 0) {
      lines.push(t('mount.report.unmountable', { paths: report.unmountable.map(i => i.path).join(', ') }))
    }
    if (lines.length === 0) return
    const openId = await getFeishuOpenIdForUser(user)
    if (!openId) return
    await this.sender.sendInteractiveCardToOpenId(openId, buildNoticeCard(lines.join('\n\n'))).catch(() => {})
  }

  private async assertAdminOperator(openId: string | undefined): Promise<string | null> {
    if (!openId) return null
    await rebuildReverseIndex()
    const canonical = lookupBySender(`feishu:${openId}` as SenderKey)
    if (!canonical || !await isAdmin(canonical)) return null
    return canonical
  }
}

let activeCoordinator: MountApprovalCoordinator | null = null

export function registerMountApprovalCoordinator(coordinator: MountApprovalCoordinator): void {
  activeCoordinator = coordinator
}

export function clearMountApprovalCoordinator(coordinator: MountApprovalCoordinator): void {
  if (activeCoordinator === coordinator) activeCoordinator = null
}

/** Push a read-write mount request to the admin as an approval card, when a
 *  channel is live. No-ops (request stays in the store) when no channel is
 *  registered. */
export async function notifyMountRwRequest(input: {
  user: string
  path: string
  fileset: string
}): Promise<void> {
  await activeCoordinator?.requestApproval(input).catch(() => {})
}

/** Push a mount degrade / unmountable report to a requester's DM when a channel
 *  is live (e.g. after an admin-slash approval). No-ops without a channel. */
export async function notifyMountReportToUser(user: string, report: MountReport): Promise<void> {
  await activeCoordinator?.reportToUser(user, report).catch(() => {})
}
