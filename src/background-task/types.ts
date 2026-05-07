import { z } from 'zod'

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

export type FireHistoryEntry = {
  firedAt: string
  summary: string
  success: boolean
}

export type BackgroundTaskEntry = {
  id: string
  ownerCanonicalUser: string
  prompt: string
  schedule: ScheduleSpec
  label: string
  notifyOn: 'success' | 'failure' | 'always'
  notifyTo: 'user' | 'agent'
  enabled: boolean
  createdAt: string
  lastFiredAt?: string
  consecutiveFailures: number
  fireHistory?: FireHistoryEntry[]
}

export type FireOutcome =
  | { kind: 'success'; summary: string; transcriptPath: string }
  | { kind: 'failure'; reason: string; transient: boolean; attempt: number }

export type PendingCardAction = {
  fireUuid: string
  task: BackgroundTaskEntry
  ownerCanonicalUser: string
  ownerOpenId: string
  outcome: FireOutcome
  firedAt: string
  autopaused?: boolean
}

export type WakeNotifyResult =
  | { kind: 'notify'; text: string }
  | { kind: 'silent'; reason?: string }
  | { kind: 'no-decision' }

export type BackgroundTaskStoreFile = {
  version: 1
  tasks: BackgroundTaskEntry[]
}

export const backgroundTaskEntrySchema: z.ZodType<BackgroundTaskEntry> = z.object({
  id: z.string().min(1),
  ownerCanonicalUser: z.string().min(1),
  prompt: z.string().min(1),
  schedule: scheduleSpecSchema,
  label: z.string().min(1),
  notifyOn: z.enum(['success', 'failure', 'always']),
  notifyTo: z.enum(['user', 'agent']),
  enabled: z.boolean(),
  createdAt: z.string(),
  lastFiredAt: z.string().optional(),
  consecutiveFailures: z.number().int().nonnegative(),
  fireHistory: z.array(z.object({
    firedAt: z.string(),
    summary: z.string(),
    success: z.boolean(),
  })).optional(),
})
