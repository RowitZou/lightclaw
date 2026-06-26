import chalk from 'chalk'

import { getConfig, type LightClawConfig } from '../config.js'
import {
  addLink,
  createUser,
  getAdmin,
  getUserPermissionCeiling,
  isAdmin,
  isValidIdentityName,
  listIdentities,
  lookupBySender,
  parseSenderKey,
  rebuildReverseIndex,
  removeLink,
  removeUser,
  setUserPermissionCeiling,
} from '../identity/store.js'
import { approveCode, listPending, rejectCode } from '../identity/pairing.js'
import { deriveCanonicalName } from '../identity/derive-canonical.js'
import { preheatAndWelcomeOnApproval } from '../identity/post-approve.js'
import type { SenderKey } from '../identity/types.js'
import { type PermissionMode } from '../permission/types.js'
import { DockerRuntime, RlaunchRuntime } from '../runtime/index.js'
import { brainppDockerImageProbe } from '../runtime/image-readiness.js'
import { resolveDockerImage } from '../runtime/pool.js'
import {
  abortInFlightForSession,
  getCurrentUserId,
  getImageReadiness,
  getModel,
  getPermissionMode,
  getRuntime,
  getRuntimePool,
  setRuntime,
} from '../state.js'

import { runAdminCommand } from './admin.js'
import { runConfigCommand } from './config.js'
import { appendFeedback, readAllFeedback } from './feedback-store.js'
import { runSystemCommand } from './system.js'
import {
  MODE_ALIASES,
  modeToAlias,
  parseMode,
} from './mode-aliases.js'
import { t } from '../i18n/index.js'
import { commandList } from './card-format.js'
import type { CommandListCardSection, ReplCommand, ReplContext } from './registry.js'
import { ReplCommandRegistry } from './registry.js'
import { readUsage, type UsageRecord } from '../usage/storage.js'
import { stopActiveTaskRunsForSession } from '../taskrun/stop.js'

export function createBuiltinReplRegistry(
  opts?: { includeChannelOnly?: boolean },
): ReplCommandRegistry {
  // includeChannelOnly defaults to true so the channel dispatcher and any
  // other caller keep the full command set; the terminal admin console
  // passes false to drop the agent-loop commands (only /stop today).
  const includeChannelOnly = opts?.includeChannelOnly ?? true
  const registry = new ReplCommandRegistry()
  // Built inside the function so command descriptions / usage strings pick
  // up the current locale (init.ts setLang runs before any dispatch).
  for (const command of buildBuiltinCommands()) {
    if (command.channelOnly && !includeChannelOnly) {
      continue
    }
    registry.register(command)
  }
  return registry
}

async function restartCurrentRlaunchRuntime(ctx: ReplContext): Promise<string> {
  const userId = ctx.userId ?? getCurrentUserId()
  if (!userId) {
    throw new Error(t('common.error.noActiveIdentity'))
  }
  const current = getRuntime()
  if (!(current instanceof RlaunchRuntime)) {
    throw new Error(t('mount.requiresRlaunchRuntime'))
  }
  // Atomic swap: pool installs the new runtime under the same per-user key
  // and marks the old one retired with a resolver pointing at the live entry,
  // so concurrent mid-turn ALS references to the old instance forward to the
  // new one instead of trying to respawn a worker with the stale mount
  // config. The old cluster worker is stopped inside next.start() via the
  // existing deploymentHash-mismatch branch in _startOnce.
  const next = getRuntimePool().swapRlaunchRuntime(userId, ctx.config)
  setRuntime(next)
  await next.start()
  return next.name ?? t('sandbox.workerNone')
}

function buildBuiltinCommands(): ReplCommand[] {
  return [
  {
    name: '/help',
    usage: '/help',
    description: t('cmd.help.desc'),
    async handler(_args, ctx) {
      ctx.output.write(await formatHelp(ctx))
    },
  },
  {
    name: '/stop',
    usage: '/stop',
    description: t('cmd.stop.desc'),
    channelOnly: true,
    async handler(_args, ctx) {
      // Phase 32: /stop aborts the in-flight turn for THIS session only.
      // ctx.sessionId is the terminal session id in REPL and the Feishu
      // Phase 26 sessionId for channel slash dispatch — both map directly
      // to the controller `beginQuery()` registered.
      const userId = ctx.userId ?? getCurrentUserId()
      const ledgerStop = userId
        ? await stopActiveTaskRunsForSession(userId, ctx.sessionId)
        : { waitingRunIds: [], abortedSessionIds: [] }
      const aborted = abortInFlightForSession(ctx.sessionId) ||
        ledgerStop.waitingRunIds.length > 0 ||
        ledgerStop.abortedSessionIds.length > 0
      const hasLedgerTally = ledgerStop.abortedSessionIds.length > 0 || ledgerStop.waitingRunIds.length > 0
      ctx.output.write(
        `${aborted
          ? (hasLedgerTally
              ? t('stop.abortedWithLedger', {
                  inFlight: String(ledgerStop.abortedSessionIds.length),
                  waiting: String(ledgerStop.waitingRunIds.length),
                })
              : t('stop.aborted'))
          : t('stop.nothing')}\n`,
      )
    },
  },
  {
    name: '/feedback',
    usage: t('cmd.feedback.usage'),
    description: t('cmd.feedback.desc'),
    visibleTo: 'all',
    agentAdvisory:
      'When the user wants to leave standing feedback for the admin (bug report / ' +
      'feature request / preference) that should outlive this conversation.',
    agentUsage: [
      '/feedback <text>   Record standing feedback for the admin. <text> is taken verbatim to end of line.',
    ].join('\n'),
    async handler(args, ctx) {
      const text = args.trim()
      if (!text) {
        ctx.output.write(`${t('common.error.prefix')}${t('feedback.usage')}\n`)
        return
      }
      const userId = ctx.userId ?? getCurrentUserId() ?? '__terminal__'
      try {
        await appendFeedback({
          ts: new Date().toISOString(),
          user: userId,
          channel: ctx.isChannel ? 'channel' : 'terminal',
          text,
        })
        ctx.output.write(`${t('feedback.thanks')}\n`)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        ctx.output.write(`${t('common.error.prefix')}${t('feedback.fail', { detail })}\n`)
      }
    },
  },
  {
    name: '/system',
    usage: t('cmd.system.usage'),
    description: t('cmd.system.desc'),
    // Same surface as the commands it absorbs: /system key and /system mount are both
    // channelOnly (per-user channel state / live-session-only), so /system
    // must be too — otherwise terminal /help drifts (the absorbed nouns
    // would be unreachable there but the hub would still list them).
    channelOnly: true,
    agentAdvisory:
      'When the user needs to manage runtime resources tied to their own ' +
      'environment: store/enable a credential the task needs (key), expose a ' +
      'host gpfs path to the sandbox (mount), or move their data in/out (data).',
    agentUsage: [
      '/system key                                  List stored keys + enabled state',
      '/system key set <NAME> <VALUE...>            Store a key (VALUE verbatim to end of line)',
      '/system key enable|disable <NAME>            Enable / disable a key for use',
      '/system key rm <NAME>                        Delete a stored key',
      '/system mount                                List mounted paths',
      '/system mount add <path...> [--ro|--rw]      Mount a path for the agent to access',
      '/system mount rm <path...>                   Unmount a path',
      '/system data export [--path <file>|--feishu] [--with-sessions]   Export your data',
      '/system data import [--path <file>|--feishu] [--replace] [--y]   Import from a backup',
    ].join('\n'),
    async handler(args, ctx) {
      ctx.output.write(await runSystemCommand(args, ctx, {
        restartRlaunch: () => restartCurrentRlaunchRuntime(ctx),
      }))
    },
  },
  {
    name: '/config',
    usage: t('cmd.config.usage'),
    description: t('cmd.config.desc'),
    agentAdvisory:
      'When the user wants to change their own settings — current model, ' +
      'permission mode, interface language, permission rules, working directory, ' +
      'per-use model lanes, or add their own model service / model (BYO credentials).',
    agentUsage: [
      '/config model [set <name>|reset]                 Switch the current model',
      '/config mode [set <read|ask|auto|yolo>|reset]    Set the permission mode',
      '/config lang [set <cn|en>|reset]                 Switch the interface language',
      '/config rule [add <rule> [--deny]|rm <n>|rm all --y]   Manage permission rules',
      '/config workspace [set <absolute-path>|reset]    Point the workspace at a directory (validated; rejected with a reason if not accessible)',
      '/config lane [set <worker|system|image> <model>|reset <bucket>]   Per-use model',
      '/config endpoint [add|set|rm] <alias> [--type openai|anthropic|codex] [--key|--base-url|--proxy|--auth-path]   Your model services',
      '/config backend [add|set|check|rm] <name> [--endpoint|--upstream|--reasoning|--max-tokens|--default]   Add models to your usable list',
    ].join('\n'),
    async handler(args, ctx) {
      ctx.output.write(await runConfigCommand(args, {
        config: ctx.config,
        userId: ctx.userId,
        persistMeta: ctx.persistMeta,
        setBodyFormat: ctx.setSlashBodyFormat,
        setCommandListCard: ctx.setCommandListCard,
      }))
    },
  },
  {
    name: '/admin',
    usage: t('cmd.admin.usage'),
    description: t('cmd.admin.desc'),
    // Admin-only hub (PR5.9 B4): folds the six top-level admin ops commands
    // (cost / user+pairing / feedback / ceiling / sandbox / feishu-drive) and
    // adds system-scope model config (backend / endpoint / lane) that writes
    // the deployment config.json. The registry dispatcher rejects non-admin
    // callers for `visibleTo:'admin'` before the handler runs. The old six
    // top-level admin commands stay registered (retired in B6).
    visibleTo: 'admin',
    agentAdvisory:
      'When the admin wants to manage the deployment: inspect token cost, ' +
      'manage paired users / pairing requests, read user feedback, set ' +
      'permission ceilings, inspect or reset the sandbox, manage Feishu drive ' +
      'folders, or configure deployment-wide model backends / endpoints / lanes / public proxy.',
    agentUsage: [
      '/admin cost                                   Token usage this month, by model and user',
      '/admin user [list|rm <name> [--purge] --y|unlink <channel:id>]',
      '/admin pairing [list|approve <code> [--as <name>]|reject <code>]',
      '/admin feedback [--page N]                    Read standing user feedback',
      '/admin ceiling [list|set <user> <mode>]       Per-user permission-mode ceiling',
      '/admin sandbox [status|prefetch|reset --y]',
      '/admin feishu-drive [status|list|orphans|rm <user> --y]',
      '/admin endpoint [list|add|set|rm] <alias> [--type openai|anthropic|codex] [--key|--base-url|--proxy|--auth-path]   Public model services',
      '/admin backend [list|add|set|rm] <name> [--endpoint|--upstream|--reasoning|--max-tokens|--default]   Public usable model list',
      '/admin lane [set <worker|system|image> <model>|reset <bucket>]',
      '/admin proxy [show|set <url>|clear]           Public proxy fallback for model services without their own',
    ].join('\n'),
    async handler(args, ctx) {
      ctx.output.write(await runAdminCommand(args, {
        config: ctx.config,
        userId: ctx.userId ?? getCurrentUserId(),
        setCommandListCard: ctx.setCommandListCard,
      }))
    },
  },
  ]
}

export async function formatCeilingList(): Promise<string> {
  const identities = await listIdentities()
  const names = Object.keys(identities).sort()
  if (names.length === 0) {
    return `${t('ceiling.empty')}\n`
  }
  const lines = [t('ceiling.listTitle')]
  const defaultCeiling = defaultPermissionCeiling()
  for (const name of names) {
    const ceiling = identities[name]!.permissionCeiling ?? defaultCeiling
    const marker = (await isAdmin(name)) ? t('status.identitiesAdmin') : ''
    lines.push(`  ${name}${marker} -> ${modeToAlias(ceiling)}`)
  }
  lines.push(t('ceiling.listFooter'))
  return lines.join('\n')
}

// ── Shared ops handler bodies (B4) ───────────────────────────────────────────
// Extracted so the old top-level admin slashes (/admin ceiling /admin sandbox) and the new
// /admin <noun> hub call ONE implementation. Behavior + visible strings are
// byte-identical to the pre-B4 inline handlers.

/** `/admin ceiling` / `/admin ceiling` body. Bare → list; `<user> <mode>` → set. */
export async function runCeilingCommand(args: string): Promise<string> {
  let parts = args.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) {
    return formatCeilingList()
  }
  // Accept an optional leading `set` verb so the grammar matches the rest of
  // /admin (user rm / pairing approve / lane set / backend set) and the command's
  // own usage / footer strings, which already advertise `set <user> <mode>`. The
  // bare `<user> <mode>` form keeps working for backward compatibility.
  if (parts[0]?.toLowerCase() === 'set') {
    parts = parts.slice(1)
  }
  if (parts.length !== 2) {
    return `${t('common.error.prefix')}${t('ceiling.usage')}\n`
  }
  const [name, modeText] = parts
  const mode = parseMode(modeText!)
  if (!mode) {
    return `${t('common.error.prefix')}${t('ceiling.invalidMode', { input: modeText!, aliases: MODE_ALIASES.join(' / ') })}\n`
  }
  const result = await setUserPermissionCeiling(name!, mode)
  if (!result.ok) {
    return `${t('common.error.prefix')}${t('ceiling.noSuchUser', { name: name! })}\n`
  }
  return `${t('ceiling.set', { name: name!, mode: modeToAlias(mode) })}\n`
}

/** `/admin sandbox` / `/admin sandbox` body. status / prefetch / reset. Needs a live
 *  Runtime (status) and the runtime pool (reset) — both reached via state.ts. */
export async function runSandboxCommand(args: string, config: LightClawConfig): Promise<string> {
  const action = args.trim() || 'status'
  if (action === 'status') {
    const runtime = getRuntime()
    const lines: string[] = []
    if (runtime instanceof RlaunchRuntime) {
      // Rlaunch backend has its own readiness tracker (per-user worker
      // scheduling on the cluster). The docker-flavored ImageReadiness
      // tracker doesn't apply — the cluster pulls images server-side,
      // we never run `docker pull` locally. Reading ImageReadiness here
      // would always show `not-attempted` since nothing populates it.
      //
      // The tracker is only updated when isAvailable() / waitForRunning()
      // / runBrainctlExec() actually probes phase. preheat-on-startup
      // calls start() which leaves the tracker on `scheduling` until the
      // first real tool call lifts it to `ready`. Calling isAvailable()
      // here forces a phase probe so admin sees the live state instead
      // of a stale `scheduling` even when the cluster worker is healthy.
      // Caught + ignored: isAvailable() returns reason objects rather
      // than throwing, but a brainctl/network blip could still throw.
      await runtime.isAvailable().catch(() => {})
      const snap = runtime.workerSnapshot()
      lines.push(t('sandbox.titleRlaunch'))
      lines.push(t('sandbox.state', { state: snap.state }))
      if (snap.image) lines.push(t('sandbox.image', { image: snap.image }))
      if (snap.scheduleDurationMs !== undefined) {
        lines.push(t('sandbox.scheduleElapsed', { seconds: Math.round(snap.scheduleDurationMs / 1000) }))
      }
      if (snap.lastError) lines.push(t('sandbox.lastError', { error: snap.lastError }))
      lines.push(t('sandbox.workerUser', { name: snap.canonicalUser }))
      lines.push(t('sandbox.worker', { name: runtime.name ?? t('sandbox.workerNone') }))
    } else if (runtime instanceof DockerRuntime) {
      const snap = getImageReadiness().snapshot()
      lines.push(t('sandbox.title'))
      lines.push(t('sandbox.state', { state: snap.state }))
      if (snap.image) lines.push(t('sandbox.image', { image: snap.image }))
      if (snap.pullDurationMs !== undefined) {
        const seconds = Math.round(snap.pullDurationMs / 1000)
        lines.push(snap.state === 'ready'
          ? t('sandbox.pulledIn', { seconds })
          : t('sandbox.elapsed', { seconds }))
      }
      if (snap.lastError) lines.push(t('sandbox.lastError', { error: snap.lastError }))
      lines.push(t('sandbox.container', { name: runtime.containerName }))
    } else {
      // LocalRuntime: admin-only single-user mode, no worker / container
      // tracking applies — the readiness machinery is purely for the
      // isolated-backend code path (docker / rlaunch).
      lines.push(t('sandbox.titleLocal'))
      lines.push(t('sandbox.localActive'))
    }
    lines.push('')
    return lines.join('\n')
  }
  if (action === 'prefetch') {
    const tracker = getImageReadiness()
    if (config.runtime.backend !== 'docker') {
      return `${t('sandbox.prefetch.requireDocker')}\n`
    }
    const image = resolveDockerImage(config)
    tracker.retryIfFailed()
    if (tracker.state === 'ready') {
      return `${t('sandbox.prefetch.alreadyReady', { image })}\n`
    }
    if (tracker.state === 'pulling') {
      return `${t('sandbox.prefetch.inProgress', { image })}\n`
    }
    tracker.startPrefetch(image, {
      inspectOnly: !config.runtime.dockerSettings.autoPull,
      ...(config.runtime.driver === 'brainpp'
        ? { probe: brainppDockerImageProbe() }
        : {}),
    })
    return `${t('sandbox.prefetch.started', { image })}\n`
  }
  if (action !== 'reset') {
    return `${t('common.error.prefix')}${t('sandbox.usage')}\n`
  }
  const userId = getCurrentUserId()
  if (!userId) {
    return `${t('common.error.prefix')}${t('common.error.noActiveIdentity')}\n`
  }
  const runtime = getRuntime()
  if (!(runtime instanceof DockerRuntime)) {
    if (runtime instanceof RlaunchRuntime) {
      await getRuntimePool().remove(userId)
      return `${t('sandbox.reset.rlaunchDone')}\n`
    }
    return `${t('sandbox.reset.localNothing')}\n`
  }
  const containerName = runtime.containerName
  const image = runtime.image || resolveDockerImage(config)
  await getRuntimePool().remove(userId)
  return `${t('sandbox.reset.dockerDone', { container: containerName, image })}\n`
}

async function formatHelp(ctx: ReplContext): Promise<string> {
  // The terminal console hides the agent-loop commands, so /help must too.
  const registry = createBuiltinReplRegistry({ includeChannelOnly: ctx.isChannel })
  // Scope the listing to the recipient: list(false) keeps user-only commands
  // (/feedback) and drops admin-only (/admin); list(true) is the reverse. Hard-
  // coding list(true) was what hid /feedback from a non-admin's /help.
  const all = registry.list(ctx.isAdmin)
  // Top section = commands the recipient can actually run that aren't admin-only:
  // `all` (everyone) plus `user`-scoped commands (e.g. /feedback) when the
  // recipient is a non-admin. Without the `user` branch, user-only commands fall
  // into neither bucket and silently vanish from /help (the /feedback gap).
  const userCmds = all.filter(c => {
    const v = c.visibleTo ?? 'all'
    return v === 'all' || (v === 'user' && !ctx.isAdmin)
  })
  const adminCmds = all.filter(c => c.visibleTo === 'admin')
  // Layout differs by surface. The Feishu channel renders a structured
  // command-list card (column_set): command chips left, descriptions right,
  // user commands in one section + an admin section with a "仅 admin" heading.
  // Usage is reached by typing the command (help.usageHint footer). The
  // terminal admin console has NO agent loop to ask, so it shows each command's
  // full `usage` (argument syntax) inline as a padEnd-aligned table (fixed-width
  // fonts make it readable) and drops the hint: /help must be self-contained.
  if (ctx.isChannel) {
    const toRows = (cmds: ReplCommand[]) =>
      cmds.map(c => [c.name, c.description] as const)
    // Admin commands render as a continuation of the same list — no "仅 admin"
    // subtitle (the card is a flat command list; the role gate already governs
    // who can run what).
    const sections: CommandListCardSection[] = [{ rows: toRows(userCmds) }]
    if (ctx.isAdmin && adminCmds.length > 0) {
      sections.push({ rows: toRows(adminCmds) })
    }
    ctx.setCommandListCard?.({
      title: t('card.cmdHelp.title', { cmd: '/help' }),
      sections,
      footer: t('help.usageHint'),
    })
    // Plain-text fallback (terminal-less channels / no card support).
    const fallback: string[] = [commandList(toRows(userCmds))]
    if (ctx.isAdmin && adminCmds.length > 0) {
      fallback.push('', commandList(toRows(adminCmds)))
    }
    fallback.push('', t('help.usageHint'))
    return fallback.join('\n')
  }
  const usageWidth = Math.max(...all.map(c => c.usage.length), 10)
  const formatRow = (c: ReplCommand) => `  ${c.usage.padEnd(usageWidth, ' ')}  ${c.description}`
  const lines: string[] = [
    t('help.title'),
    '',
    ...userCmds.map(formatRow),
  ]
  if (ctx.isAdmin && adminCmds.length > 0) {
    lines.push('', t('help.adminTitle'), '')
    for (const c of adminCmds) {
      lines.push(formatRow(c))
    }
  }
  lines.push('')
  return color(ctx, lines.join('\n'))
}

export async function runUserCommand(rawArgs: string): Promise<string> {
  await rebuildReverseIndex()
  const args = rawArgs.trim().split(/\s+/).filter(Boolean)
  const action = args.shift()
  switch (action) {
    case 'list':
      return userList()
    case 'pending':
      return userPending()
    case 'approve':
      return userApprove(args)
    case 'reject':
      return userReject(args)
    case 'unlink':
      return userUnlink(args)
    case 'remove':
      return userRemove(args)
    case 'feedback':
      return userFeedback(args)
    default: {
      const adminId = await getAdmin()
      const isLocal = getConfig().runtime.backend === 'local'
      const header = isLocal && adminId
        ? t('user.usage.localHeader', { admin: adminId })
        : t('user.usage.header')
      const approve = isLocal && adminId
        ? t('user.usage.approveLocal', { admin: adminId })
        : t('user.usage.approveGeneric')
      return `${header}\n${t('user.usage.lines', { approve })}`
    }
  }
}

async function userFeedback(args: string[]): Promise<string> {
  const pageIdx = args.indexOf('--page')
  const page = pageIdx >= 0 ? Math.max(1, Number.parseInt(args[pageIdx + 1] ?? '1', 10) || 1) : 1
  const pageSize = 20
  const all = await readAllFeedback()
  if (all.length === 0) {
    return `${t('user.feedback.empty')}\n`
  }
  const totalPages = Math.ceil(all.length / pageSize)
  if (page > totalPages) {
    return `${t('common.error.prefix')}${t('user.feedback.pageOutOfRange', { page, total: totalPages })}\n`
  }
  const slice = all.slice((page - 1) * pageSize, page * pageSize)
  const lines = slice.map(r =>
    `  ${r.ts.slice(0, 19)} ${r.user}@${r.channel}: ${truncate(r.text, 80)}`,
  )
  return `${t('user.feedback.title', { page, total: totalPages, count: all.length })}\n${lines.join('\n')}\n`
}

function truncate(text: string, maxLen: number): string {
  const oneline = text.replace(/\s+/g, ' ').trim()
  if (oneline.length <= maxLen) return oneline
  return oneline.slice(0, maxLen - 1) + '…'
}

export async function formatCost(): Promise<string> {
  const now = new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
  // Only tally PUBLIC (deployment-registry) models — a model defined in the
  // admin `<home>/config.json`. Users' BYO models (added through their own
  // per-user `/config endpoint` + `/config backend`) are their own concern and
  // are excluded from the admin usage report. Membership is checked against the
  // current public registry; a model removed from the registry drops out of the
  // tally, which is the intended "what does the deployment currently pay for"
  // semantics for this admin-facing report.
  const publicModels = new Set(Object.keys(getConfig().models))
  const records: UsageRecord[] = []
  for await (const rec of readUsage({ sinceTs: monthStart })) {
    if (!publicModels.has(rec.model)) continue
    records.push(rec)
  }
  if (records.length === 0) {
    return `${t('cost.empty')}\n`
  }
  const total = records.reduce((acc, r) => acc + r.input + r.output, 0)
  const byModel = new Map<string, number>()
  const byUser = new Map<string, number>()
  let freshTok = 0
  let cacheRead = 0
  let cacheCreate = 0
  for (const r of records) {
    const tok = r.input + r.output
    byModel.set(r.model, (byModel.get(r.model) ?? 0) + tok)
    byUser.set(r.user, (byUser.get(r.user) ?? 0) + tok)
    cacheRead += r.cacheRead
    cacheCreate += r.cacheCreate
    if (r.kind === 'fresh') freshTok += tok
  }
  const fmt = (n: number): string => formatTokens(n)
  const lines: string[] = [
    t('cost.thisMonth', { total: fmt(total), cacheRead: fmt(cacheRead), cacheCreate: fmt(cacheCreate) }),
    '',
    t('cost.byModel'),
    ...[...byModel.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => `    ${m}: ${fmt(n)}`),
    '',
    t('cost.byUser'),
    ...[...byUser.entries()].sort((a, b) => b[1] - a[1]).map(([u, n]) => `    ${u}: ${fmt(n)}`),
  ]
  if (freshTok > 0) {
    lines.push('', t('cost.freshSubset', { tok: fmt(freshTok), percent: Math.round(freshTok * 100 / total) }))
  }
  lines.push('')
  return lines.join('\n')
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/**
 * In LocalRuntime, only the admin canonical user can be bound to a channel
 * sender — any other identity would be rejected at runtime acquire time
 * (see init.ts:LocalRuntimeAdminOnlyError). Reject upfront at approve / link
 * time so the operator gets immediate, actionable feedback instead of
 * approving + linking + then watching the user receive a single-user-mode
 * rejection in Feishu. Admin not yet wizarded → no constraint
 * (wizard path runs before any pairing can happen).
 */
async function rejectNonAdminInLocal(name: string): Promise<string | null> {
  if (getConfig().runtime.backend !== 'local') {
    return null
  }
  const adminId = await getAdmin()
  if (!adminId || name === adminId) {
    return null
  }
  return `${t('user.localOnlyReject', { name, admin: adminId })}\n`
}

async function userList(): Promise<string> {
  const identities = await listIdentities()
  const names = Object.keys(identities).sort()
  if (names.length === 0) {
    return `${t('user.list.empty')}\n`
  }
  const lines: string[] = []
  const defaultCeiling = defaultPermissionCeiling()
  for (const name of names) {
    const record = identities[name]
    const marker = await isAdmin(name) ? t('status.identitiesAdmin') : ''
    lines.push(`${name}${marker} ceiling=${modeToAlias(record.permissionCeiling ?? defaultCeiling)}`)
    for (const channel of ['terminal', 'feishu'] as const) {
      for (const peerId of record.channels[channel]) {
        lines.push(`  - ${channel}:${peerId}`)
      }
    }
  }
  return `${lines.join('\n')}\n`
}

async function userPending(): Promise<string> {
  const pending = await listPending()
  if (pending.length === 0) {
    return `${t('user.pending.empty')}\n`
  }
  const lines = [t('user.pending.header')]
  for (const item of pending) {
    lines.push([
      item.code.padEnd(8, ' '),
      item.channel.padEnd(8, ' '),
      item.peerId.slice(0, 40).padEnd(40, ' '),
      (item.displayName || '-').slice(0, 16).padEnd(16, ' '),
      formatAge(item.createdAt),
    ].join(' '))
  }
  return `${lines.join('\n')}\n`
}

type ParsedApproveArgs =
  | { ok: true; code: string; asName: string | undefined }
  | { ok: false }

function parseApproveArgs(args: string[]): ParsedApproveArgs {
  // Accepted forms:
  //   /admin pairing approve <code>
  //   /admin pairing approve <code> --as <name>
  // --as overrides the auto-derived canonical name; useful for binding an IM
  // sender into an existing identity (typically the admin) instead of always
  // creating a fresh `<base>_<userId>` user.
  if (args.length === 0) {
    return { ok: false }
  }
  const code = args[0]
  if (!code) {
    return { ok: false }
  }
  if (args.length === 1) {
    return { ok: true, code, asName: undefined }
  }
  if (args.length === 3 && args[1] === '--as' && args[2]) {
    return { ok: true, code, asName: args[2] }
  }
  return { ok: false }
}

export async function userApprove(args: string[]): Promise<string> {
  const parsed = parseApproveArgs(args)
  if (!parsed.ok) {
    return `${t('user.approve.usage')}\n`
  }
  const { code, asName } = parsed
  // Validate --as name BEFORE consuming the pending code, so a typo doesn't
  // burn the pairing entry.
  if (asName !== undefined && !isValidIdentityName(asName)) {
    return `${t('user.approve.invalidName', { name: asName })}\n`
  }
  const entry = await approveCode(code)
  if (!entry) {
    return `${t('user.approve.noSuchCode', { code })}\n`
  }
  const link = `${entry.channel}:${entry.peerId}` as SenderKey
  const name = asName ?? deriveCanonicalName({
    name: entry.displayName,
    email: entry.email,
    openId: entry.peerId,
    userId: entry.userId,
  })
  const reject = await rejectNonAdminInLocal(name)
  if (reject) {
    return reject
  }
  const boundTo = lookupBySender(link)
  if (boundTo && boundTo !== name) {
    return `${t('user.approve.alreadyBound', { link, name: boundTo })}\n`
  }
  const created = await createUser(name)
  if (!created.ok && created.reason !== 'exists') {
    return `${t('user.approve.invalidName', { name })}\n`
  }
  const linked = await addLink(name, link)
  if (!linked.ok) {
    return linked.reason === 'already-bound'
      ? `${t('user.approve.alreadyBound', { link, name: linked.boundTo ?? '?' })}\n`
      : `${t('user.remove.noSuch', { name })}\n`
  }
  preheatAndWelcomeOnApproval(name, link, {
    applicantText: entry.lastApplicantText,
    applicantChatId: entry.lastApplicantChatId,
    applicantChatType: entry.lastApplicantChatType,
    applicantThreadId: entry.lastApplicantThreadId,
    applicantMessageId: entry.lastApplicantMessageId,
  })
  const created_or_updated = created.ok ? t('user.approve.created', { name }) : t('user.approve.updated', { name })
  return `${created_or_updated}\n${t('user.approve.linked', { link, name })}\n`
}

async function userReject(args: string[]): Promise<string> {
  const code = args[0]
  if (!code) {
    return `${t('user.reject.usage')}\n`
  }
  const result = await rejectCode(code)
  return result.ok
    ? `${t('user.reject.done', { code })}\n`
    : `${t('user.reject.noSuchCode', { code })}\n`
}

async function userUnlink(args: string[]): Promise<string> {
  const [rawLink] = args
  if (!rawLink) {
    return `${t('user.unlink.usage')}\n`
  }
  try {
    parseSenderKey(rawLink)
  } catch (error) {
    return `${error instanceof Error ? error.message : String(error)}\n`
  }
  const boundTo = lookupBySender(rawLink as SenderKey)
  if (!boundTo) {
    return `${t('user.unlink.notBound', { link: rawLink })}\n`
  }
  const result = await removeLink(boundTo, rawLink as SenderKey)
  return result.ok
    ? `${t('user.unlink.done', { link: rawLink, name: boundTo })}\n`
    : `${t('user.unlink.notLinked', { link: rawLink })}\n`
}

async function userRemove(args: string[]): Promise<string> {
  const name = args[0]
  if (!name) {
    return `${t('user.remove.usage')}\n`
  }
  if ((await getAdmin()) === name) {
    return `${t('user.remove.refuseAdmin')}\n`
  }
  const result = await removeUser(name, { purge: args.includes('--purge') })
  if (!result.ok) {
    return `${t('user.remove.noSuch', { name })}\n`
  }
  const cleanup = await getRuntimePool().purgeUser(name, getConfig())
  let response = `${t('user.remove.done', { name })}\n`
  if (cleanup.rlaunchWorker) {
    response += `${t('user.remove.cleanupRlaunch', { worker: cleanup.rlaunchWorker })}\n`
  }
  if (cleanup.dockerContainer) {
    response += `${t('user.remove.cleanupDocker', { container: cleanup.dockerContainer })}\n`
  }
  return response
}

function firstLine(text: string): string {
  return text.split('\n').map(line => line.trim()).find(Boolean) ?? text
}

function color(ctx: ReplContext, text: string): string {
  return ctx.isChannel ? text : chalk.gray(text)
}

function defaultPermissionCeiling(): PermissionMode {
  return getConfig().permissionCeiling
}

function formatAge(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 60) {
    return `${seconds}s ago`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  return `${Math.floor(minutes / 60)}h ago`
}
