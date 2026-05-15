import type { WakeNotifyResult } from '../background-task/types.js'
import type { PermissionApprover } from '../permission/types.js'
import type { CanUseToolFn } from '../tool.js'
import type {
  ToolExecutionEvent,
  UserContentBlock,
} from '../types.js'

export type InterjectionPendingAttachment = {
  kind: string
  messageId: string
  mediaKey: unknown
  fileName: string
  quotedFromMessageId?: string
}

export type InterjectionEntry = {
  messageId: string
  senderOpenId: string
  senderName?: string
  text: string
  arrivedAt: number
  triggeredAutoDeny?: boolean
  quotedSummary?: string
  pendingAttachments?: InterjectionPendingAttachment[]
  attachmentPaths?: string[]
}

export type InvocationContext = {
  onTextDelta?(text: string): void
  onToolUse?(event: { name: string; input: Record<string, unknown> }): void
  onToolResult?(event: ToolExecutionEvent): void
  onAssistantTurn?(text: string): Promise<void> | void
  onCompactStart?(): void
  onCompactEnd?(result: { removedCount: number; summaryTokens: number }): void
  onCompactError?(message: string): void
  channelContext?: string
  interjectionDrain?: () => Promise<InterjectionEntry[]> | InterjectionEntry[]
  interjectionRenderer?: (
    entries: InterjectionEntry[],
    context: {
      originalUserText: string
      completedToolUses: Array<{ name: string; brief: string }>
    },
  ) => UserContentBlock[]
  permissionApprover?: PermissionApprover
  canUseTool?: CanUseToolFn
  cacheBreakpointMessageIndex?: number
  signal?: AbortSignal
  noAutoMemory?: boolean
  ephemeral?: boolean
  subagentLabel?: string
  wakeNotifications?: WakeNotifyResult[]
  systemPromptOverride?: string
}

export function emptyInvocationContext(): InvocationContext {
  return {}
}

export function channelInvocationContext(
  input: InvocationContext,
): InvocationContext {
  return { ...input }
}

export function forkInvocationContext(input: {
  systemPrompt: string
  canUseTool: CanUseToolFn
  cacheBreakpointMessageIndex?: number
  signal?: AbortSignal
  subagentLabel?: string
}): InvocationContext {
  return {
    systemPromptOverride: input.systemPrompt,
    canUseTool: input.canUseTool,
    cacheBreakpointMessageIndex: input.cacheBreakpointMessageIndex,
    signal: input.signal,
    subagentLabel: input.subagentLabel,
  }
}

export function freshInvocationContext(): InvocationContext {
  return {
    noAutoMemory: true,
    ephemeral: true,
  }
}
