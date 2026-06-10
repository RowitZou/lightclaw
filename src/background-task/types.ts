import { z } from 'zod'

import type { ChainState } from '../signal-bus/chain-state.js'

export const scheduleSpecSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('oneshot'),
    at: z.string().datetime({ offset: true }),
  }),
  // 'after' is a convenience shorthand for "fire once, N minutes from now".
  // The tool layer normalizes it to { kind: 'oneshot', at: <now+afterMinutes> }
  // before storage, so on-disk shape stays at oneshot/recurring/interval.
  // Why this exists: LLMs reliably pick this when the user says
  // "1 minute test" / "remind me in 5 minutes" — without it they tend to
  // (a) compute an ISO8601 timestamp incorrectly, or worse (b) silently
  // fall through to interval { everyMinutes: 1 } and give the user a
  // recurring task instead of a one-time fire.
  z.object({
    kind: z.literal('after'),
    afterMinutes: z.number().positive().max(7 * 24 * 60),
  }),
  z.object({
    kind: z.literal('recurring'),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
  z.object({
    kind: z.literal('interval'),
    everyMinutes: z.number().int().min(1).max(7 * 24 * 60),
    anchorAt: z.string().datetime({ offset: true }).optional(),
  }),
])

export type ScheduleSpec = z.infer<typeof scheduleSpecSchema>

export type BackgroundTaskEntry = {
  id: string
  ownerCanonicalUser: string
  prompt: string
  /** AgentType of the dispatched worker role (e.g. 'generalist',
   *  'webSearcher', or a user-defined role). Surfaced by ListDispatches
   *  so the LLM can tell which role each scheduled / background task
   *  runs as. Pre-Phase-8 stored tasks lack this field; the loader
   *  injects 'generalist' as the legacy default before zod parse so
   *  old on-disk entries continue to parse cleanly. */
  role: string
  schedule: ScheduleSpec
  label: string
  notifyOn: 'success' | 'failure' | 'always'
  notifyTo: 'user' | 'agent'
  enabled: boolean
  createdAt: string
  lastFiredAt?: string
  // Set by UpdateDispatch when prompt is changed: holds the prior
  // prompt so the NEXT completion delivery can surface "prompt was changed
  // before this fire (old: ...)" once and then clear. Consumed by
  // scheduler.deliverCompletion at delivery time. NOT a chain: a second
  // prompt update before the next fire overwrites this field; intentional
  // loss to avoid unbounded growth and noisy repeated notices.
  pendingPriorPromptNotice?: string
  // The sessionId the BackgroundTask was created from. Used by
  // notify_to:'agent' so the main agent receives the result against the
  // origin chat's transcript and inherits the context that motivated the
  // task ("watch this deploy" / "remind me in group X about Y"). Optional
  // for backward compat with pre-2026-05-12 tasks; scheduler.deliverCompletion
  // falls back to resolveWakeSessionId (most-recent DM) when this field
  // is missing or the origin session no longer exists on disk.
  originSessionId?: string
  /** Role agentType that created this dispatch — the caller of the Dispatch
   *  tool, NOT the callee worker carried in `role`. The management tools use
   *  it to attribute a dispatch to its creator. Optional: entries persisted
   *  before this field existed are treated as main-created. */
  callerRole?: string
  /** Session the dispatch was created from = the ownership key for
   *  ListDispatches / CancelDispatch / UpdateDispatch. Optional: legacy
   *  entries lack it and the management tools fall back to `originSessionId`,
   *  which carries the same "created from" session. */
  callerSessionId?: string
  /** Parent durable TaskRun captured when a worker schedules a background
   *  dispatch. The scheduler later creates one TaskRun per fire and uses this
   *  value to restore lineage without changing bg-tasks scheduling semantics. */
  parentTaskRunId?: string
  /** Durable TaskRun created at dispatch time for oneshot background
   *  dispatches (create-on-dispatch). The scheduler marks this run started at
   *  fire time instead of creating a fresh one; CancelDispatch marks it
   *  cancelled so a pending queued run cannot pin its root open forever.
   *  Recurring / interval entries never carry it (one run per fire). */
  taskRunId?: string
  chainState?: ChainState
}

export type PermissionDenialDetail = {
  toolName: string
  inputPreview: string
  suggestedRules: string[]
}

export type FireOutcome =
  | { kind: 'success'; summary: string; transcriptPath: string }
  | {
      kind: 'failure'
      reason: string
      transient: boolean
      attempt: number
      permissionDenials?: PermissionDenialDetail[]
    }

export type BackgroundTaskStoreFile =
  | {
      version: 1
      tasks: Array<Omit<BackgroundTaskEntry, 'pendingPriorPromptNotice' | 'originSessionId' | 'chainState' | 'callerRole' | 'callerSessionId' | 'parentTaskRunId' | 'taskRunId'>>
    }
  | {
      version: 2
      tasks: BackgroundTaskEntry[]
    }

export const backgroundTaskEntrySchema: z.ZodType<BackgroundTaskEntry> = z.object({
  id: z.string().min(1),
  ownerCanonicalUser: z.string().min(1),
  prompt: z.string().min(1),
  role: z.string().min(1),
  schedule: scheduleSpecSchema,
  label: z.string().min(1),
  notifyOn: z.enum(['success', 'failure', 'always']),
  notifyTo: z.enum(['user', 'agent']),
  enabled: z.boolean(),
  createdAt: z.string(),
  lastFiredAt: z.string().optional(),
  pendingPriorPromptNotice: z.string().optional(),
  originSessionId: z.string().optional(),
  callerRole: z.string().optional(),
  callerSessionId: z.string().optional(),
  parentTaskRunId: z.string().optional(),
  taskRunId: z.string().optional(),
  chainState: z.any().optional(),
})
