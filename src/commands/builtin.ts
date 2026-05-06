import chalk from 'chalk'

import { getConfig } from '../config.js'
import {
  addLink,
  createUser,
  getAdmin,
  getUserPermissionCeiling,
  isAdmin,
  listIdentities,
  lookupBySender,
  parseSenderKey,
  rebuildReverseIndex,
  removeLink,
  removeUser,
  setUserPermissionCeiling,
} from '../identity/store.js'
import { approveCode, listPending, rejectCode } from '../identity/pairing.js'
import { setIdentityPreference } from '../identity/preferences.js'
import type { SenderKey } from '../identity/types.js'
import { formatRule, parseRule } from '../permission/rules.js'
import {
  appendIdentityRules,
  clearIdentityRules,
  loadIdentityRules,
  removeIdentityRule,
} from '../permission/storage.js'
import type { PermissionMode, PermissionRule } from '../permission/types.js'
import { DockerRuntime, RlaunchRuntime } from '../runtime/index.js'
import { resolveDockerImage } from '../runtime/pool.js'
import {
  abortInFlightForUser,
  getCurrentUserId,
  getIdentityRules,
  getImageReadiness,
  getModel,
  getPermissionMode,
  getRuntime,
  getRuntimePool,
  getUsageTotals,
  setIdentityRules,
  setModel,
  setPermissionMode,
} from '../state.js'

import { runAuthCommand } from './auth.js'
import { appendFeedback, readAllFeedback } from './feedback-store.js'
import {
  MODE_ALIASES,
  modeToAlias,
  parseMode,
} from './mode-aliases.js'
import { t } from '../i18n/index.js'
import type { ReplCommand, ReplContext } from './registry.js'
import { ReplCommandRegistry } from './registry.js'
import { readUsage, type UsageRecord } from '../usage/storage.js'

export function createBuiltinReplRegistry(): ReplCommandRegistry {
  const registry = new ReplCommandRegistry()
  // Built inside the function so command descriptions / usage strings pick
  // up the current locale (init.ts setLang runs before any dispatch).
  for (const command of buildBuiltinCommands()) {
    registry.register(command)
  }
  return registry
}

export const RENAMED_COMMANDS: Record<string, string> = {
  '/identity': '/user',
  '/permissions': '/rules',
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
    name: '/status',
    usage: '/status',
    description: t('cmd.status.desc'),
    async handler(_args, ctx) {
      ctx.output.write(await formatStatus(ctx))
    },
  },
  {
    name: '/stop',
    usage: '/stop',
    description: t('cmd.stop.desc'),
    async handler(_args, ctx) {
      const userId = ctx.userId ?? getCurrentUserId()
      if (!userId) {
        ctx.output.write(`${t('common.error.prefix')}${t('stop.requireIdentity')}\n`)
        return
      }
      const aborted = abortInFlightForUser(userId)
      ctx.output.write(
        `${aborted ? t('stop.aborted') : t('stop.nothing')}\n`,
      )
    },
  },
  {
    name: '/feedback',
    usage: t('cmd.feedback.usage'),
    description: t('cmd.feedback.desc'),
    visibleTo: 'user',
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
    name: '/cost',
    usage: '/cost',
    description: t('cmd.cost.desc'),
    visibleTo: 'admin',
    async handler(_args, ctx) {
      ctx.output.write(await formatCost())
    },
  },
  {
    name: '/fresh',
    usage: t('cmd.fresh.usage'),
    description: t('cmd.fresh.desc'),
    async handler(args, ctx) {
      const prompt = args.trim()
      if (!prompt) {
        ctx.output.write(`${t('common.error.prefix')}${t('fresh.usage')}\n`)
        return
      }
      const { runFresh } = await import('./fresh.js')
      const result = await runFresh({
        config: ctx.config,
        prompt,
        callerUserId: ctx.userId ?? getCurrentUserId(),
        isChannel: Boolean(ctx.isChannel),
      })
      // /fresh body is LLM markdown — render it through the channel's
      // markdown reply path instead of the structured plain_text notice.
      ctx.setSlashBodyFormat?.('lark_md')
      ctx.output.write(result)
    },
  },
  {
    name: '/model',
    usage: t('cmd.model.usage'),
    description: t('cmd.model.desc'),
    async handler(args, ctx) {
      const model = args.trim()
      const registered = Object.keys(ctx.config.models)
      const formatList = (): string =>
        registered
          .map(name => {
            const entry = ctx.config.models[name]
            return `${name} (${entry.schema}, ${entry.endpoint} -> ${entry.upstreamModel})`
          })
          .join(', ')
      if (!model) {
        ctx.output.write(`${t('model.current', { name: getModel() })}\n`)
        ctx.output.write(`${t('model.available', { list: formatList() })}\n`)
        return
      }
      if (!ctx.config.models[model]) {
        ctx.output.write(`${t('common.error.prefix')}${t('model.unknown', { name: model })}\n`)
        ctx.output.write(`${t('model.available', { list: formatList() })}\n`)
        return
      }
      setModel(model)
      ctx.config.model = model
      ctx.config.routing.main = model
      const callerId = getCurrentUserId()
      if (callerId) {
        setIdentityPreference({ canonicalUser: callerId, key: 'model', value: model })
      }
      ctx.output.write(`${t('model.set', { name: model })}\n`)
      await ctx.persistMeta(ctx.messages.length)
    },
  },
  {
    name: '/mode',
    usage: t('cmd.mode.usage'),
    description: t('cmd.mode.desc'),
    async handler(args, ctx) {
      const trimmed = args.trim()
      const userId = getCurrentUserId()
      const ceiling = userId ? await getUserPermissionCeiling(userId) : 'default'
      if (!trimmed) {
        const current = getPermissionMode()
        const lines: string[] = [t('mode.menuTitle')]
        for (const alias of MODE_ALIASES) {
          const isCurrent = alias === modeToAlias(current)
          const within = isModeWithinCeiling(parseMode(alias)!, ceiling)
          const marker = isCurrent
            ? t('mode.currentMarker')
            : (within ? '' : t('mode.aboveCeilingMarker'))
          lines.push(`  ${alias.padEnd(5)} ${t(`mode.${alias}.desc` as 'mode.read.desc')}${marker}`)
        }
        lines.push('', t('mode.ceilingLine', { ceiling: modeToAlias(ceiling) }), '')
        ctx.output.write(lines.join('\n'))
        return
      }
      const mode = parseMode(trimmed)
      if (!mode) {
        ctx.output.write(`${t('common.error.prefix')}${t('mode.unknown', { input: trimmed, aliases: MODE_ALIASES.join(' / ') })}\n`)
        return
      }
      if (!isModeWithinCeiling(mode, ceiling)) {
        ctx.output.write(`${t('common.error.prefix')}${t('mode.exceedCeiling', { mode: modeToAlias(mode), ceiling: modeToAlias(ceiling) })}\n`)
        return
      }
      setPermissionMode(mode)
      if (userId) {
        setIdentityPreference({ canonicalUser: userId, key: 'permissionMode', value: mode })
      }
      const alias = modeToAlias(mode)
      const recap = t(`mode.${alias}.recap` as 'mode.read.recap')
      ctx.output.write(`${t('mode.set', { mode: alias })}\n${recap}\n`)
      await ctx.persistMeta(ctx.messages.length)
    },
  },
  {
    name: '/ceiling',
    usage: t('cmd.ceiling.usage'),
    description: t('cmd.ceiling.desc'),
    visibleTo: 'admin',
    async handler(args, ctx) {
      const parts = args.trim().split(/\s+/).filter(Boolean)
      if (parts.length === 0) {
        ctx.output.write(await formatCeilingList())
        return
      }
      if (parts.length !== 2) {
        ctx.output.write(`${t('common.error.prefix')}${t('ceiling.usage')}\n`)
        return
      }
      const [name, modeText] = parts
      const mode = parseMode(modeText!)
      if (!mode) {
        ctx.output.write(`${t('common.error.prefix')}${t('ceiling.invalidMode', { input: modeText!, aliases: MODE_ALIASES.join(' / ') })}\n`)
        return
      }
      const result = await setUserPermissionCeiling(name!, mode)
      if (!result.ok) {
        ctx.output.write(`${t('common.error.prefix')}${t('ceiling.noSuchUser', { name: name! })}\n`)
        return
      }
      ctx.output.write(`${t('ceiling.set', { name: name!, mode: modeToAlias(mode) })}\n`)
    },
  },
  {
    name: '/user',
    usage: t('cmd.user.usage'),
    description: t('cmd.user.desc'),
    visibleTo: 'admin',
    async handler(args, ctx) {
      ctx.output.write(await runUserCommand(args))
    },
  },
  {
    name: '/sandbox',
    usage: t('cmd.sandbox.usage'),
    description: t('cmd.sandbox.desc'),
    // Admin-only: status leaks deployment internals (image / container /
    // worker names); prefetch triggers a multi-GB image pull that should
    // not be a free button for end users; reset rebuilds a per-user
    // worker / container which is admin maintenance, not a user knob.
    // Sandbox is meant to be invisible to users — environment health
    // surfaces to admin via channel notices, not via slash commands.
    visibleTo: 'admin',
    async handler(args, ctx) {
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
        ctx.output.write(lines.join('\n'))
        return
      }
      if (action === 'prefetch') {
        const tracker = getImageReadiness()
        if (ctx.config.runtime.backend !== 'docker') {
          ctx.output.write(`${t('sandbox.prefetch.requireDocker')}\n`)
          return
        }
        const image = resolveDockerImage(ctx.config)
        tracker.retryIfFailed()
        if (tracker.state === 'ready') {
          ctx.output.write(`${t('sandbox.prefetch.alreadyReady', { image })}\n`)
          return
        }
        if (tracker.state === 'pulling') {
          ctx.output.write(`${t('sandbox.prefetch.inProgress', { image })}\n`)
          return
        }
        tracker.startPrefetch(image, {
          inspectOnly: !ctx.config.runtime.docker.autoPull,
        })
        ctx.output.write(`${t('sandbox.prefetch.started', { image })}\n`)
        return
      }
      if (action !== 'reset') {
        ctx.output.write(`${t('common.error.prefix')}${t('sandbox.usage')}\n`)
        return
      }
      const userId = getCurrentUserId()
      if (!userId) {
        ctx.output.write(`${t('common.error.prefix')}${t('common.error.noActiveIdentity')}\n`)
        return
      }
      const runtime = getRuntime()
      if (!(runtime instanceof DockerRuntime)) {
        if (runtime instanceof RlaunchRuntime) {
          await getRuntimePool().remove(userId)
          ctx.output.write(`${t('sandbox.reset.rlaunchDone')}\n`)
          return
        }
        ctx.output.write(`${t('sandbox.reset.localNothing')}\n`)
        return
      }
      const containerName = runtime.containerName
      const image = runtime.image || resolveDockerImage(ctx.config)
      await getRuntimePool().remove(userId)
      ctx.output.write(`${t('sandbox.reset.dockerDone', { container: containerName, image })}\n`)
    },
  },
  {
    name: '/rules',
    usage: t('cmd.rules.usage'),
    description: t('cmd.rules.desc'),
    async handler(args, ctx) {
      const trimmed = args.trim()
      const [head, ...rest] = trimmed.split(/\s+/)
      const sub = head || 'list'
      const userId = getCurrentUserId()
      if (sub === 'list') {
        ctx.output.write(formatRulesList())
        return
      }
      if (sub === 'revoke') {
        if (!userId) {
          ctx.output.write(`${t('common.error.prefix')}${t('common.error.noActiveIdentity')}\n`)
          return
        }
        const target = rest[0]
        if (!target) {
          ctx.output.write(`${t('common.error.prefix')}${t('rules.revokeUsage')}\n`)
          return
        }
        if (target === 'all') {
          const before = getIdentityRules().length
          clearIdentityRules(userId)
          setIdentityRules([])
          ctx.output.write(
            before === 0
              ? `${t('rules.revokedAllEmpty')}\n`
              : `${t('rules.revokedAll', { count: before })}\n`,
          )
          return
        }
        const n = Number.parseInt(target, 10)
        const sorted = sortRulesForDisplay(getIdentityRules())
        if (!Number.isInteger(n) || n < 1 || n > sorted.length) {
          ctx.output.write(`${t('common.error.prefix')}${t('rules.revokeNoSuch', { n: target })}\n`)
          return
        }
        const victim = sorted[n - 1]!
        removeIdentityRule({ canonicalUser: userId, rule: victim })
        setIdentityRules(loadIdentityRules(userId))
        ctx.output.write(
          `${t('rules.revokedOne', { behavior: victim.behavior, rule: formatRule(victim.value) })}\n\n${formatRulesList()}`,
        )
        return
      }
      if (sub === 'ask') {
        const ruleText = rest.join(' ').trim()
        if (!ruleText) {
          ctx.output.write(`${t('common.error.prefix')}${t('rules.askUsage')}\n`)
          return
        }
        if (!userId) {
          ctx.output.write(`${t('common.error.prefix')}${t('common.error.noActiveIdentity')}\n`)
          return
        }
        let value
        try {
          value = parseRule(ruleText)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          ctx.output.write(`${t('common.error.prefix')}${detail}\n`)
          return
        }
        const rule: PermissionRule = { source: 'identity', behavior: 'ask', value }
        appendIdentityRules({ canonicalUser: userId, rules: [rule] })
        setIdentityRules(loadIdentityRules(userId))
        ctx.output.write(`${t('rules.askRegistered', { rule: formatRule(value) })}\n`)
        return
      }
      ctx.output.write(`${t('common.error.prefix')}${t('rules.usage')}\n`)
    },
  },
  {
    name: '/auth',
    usage: t('cmd.auth.usage'),
    description: t('cmd.auth.desc'),
    // Admin-only: OAuth credentials are endpoint-level state, equivalent
    // in scope to the apiKey on a config-defined endpoint. Letting any
    // user log in / out would let them rebind the host's outbound
    // identity to their own ChatGPT account, which is not what the
    // multi-user model implies.
    visibleTo: 'admin',
    async handler(args, ctx) {
      ctx.output.write(await runAuthCommand(args, ctx.config))
    },
  },
  ]
}

const BEHAVIOR_RANK: Record<PermissionRule['behavior'], number> = {
  deny: 0,
  ask: 1,
  allow: 2,
}

function sortRulesForDisplay(rules: readonly PermissionRule[]): PermissionRule[] {
  return [...rules].sort((a, b) => {
    if (a.behavior !== b.behavior) {
      return BEHAVIOR_RANK[a.behavior] - BEHAVIOR_RANK[b.behavior]
    }
    return formatRule(a.value).localeCompare(formatRule(b.value))
  })
}

function formatRulesList(): string {
  const sorted = sortRulesForDisplay(getIdentityRules())
  if (sorted.length === 0) {
    return `${t('rules.empty')}\n`
  }
  const indexWidth = String(sorted.length).length
  const lines = [t('rules.listTitle')]
  for (const [i, rule] of sorted.entries()) {
    const idx = String(i + 1).padStart(indexWidth, ' ')
    lines.push(`  [${idx}] ${rule.behavior.padEnd(5, ' ')} ${formatRule(rule.value)}`)
  }
  lines.push(t('rules.listFooter'))
  return lines.join('\n')
}

async function formatCeilingList(): Promise<string> {
  const identities = await listIdentities()
  const names = Object.keys(identities).sort()
  if (names.length === 0) {
    return `${t('ceiling.empty')}\n`
  }
  const lines = [t('ceiling.listTitle')]
  for (const name of names) {
    const ceiling = identities[name]!.permissionCeiling ?? 'default'
    const marker = (await isAdmin(name)) ? t('status.identitiesAdmin') : ''
    lines.push(`  ${name}${marker} -> ${modeToAlias(ceiling)}`)
  }
  lines.push(t('ceiling.listFooter'))
  return lines.join('\n')
}

async function formatHelp(ctx: ReplContext): Promise<string> {
  const registry = createBuiltinReplRegistry()
  const all = registry.list(true)
  const userCmds = all.filter(c => (c.visibleTo ?? 'all') === 'all')
  const adminCmds = all.filter(c => c.visibleTo === 'admin')
  // Channel uses a `usage: description` colon layout rather than the
  // padEnd-aligned terminal layout. Reason: feishu IM wraps long lines,
  // which destroys column alignment anyway, and the resulting visual
  // mess is worse than a simple colon-separated row. Terminal keeps
  // the aligned table since fixed-width fonts make it readable.
  const formatRow = ctx.isChannel
    ? (c: { usage: string; description: string }) => `  ${c.usage}: ${c.description}`
    : ((): ((c: { usage: string; description: string }) => string) => {
        const usageWidth = Math.max(...all.map(c => c.usage.length), 24)
        return c => `  ${c.usage.padEnd(usageWidth, ' ')}  ${c.description}`
      })()
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
  lines.push('', t('help.statusHint'), '')
  return color(ctx, lines.join('\n'))
}

async function formatStatus(ctx: ReplContext): Promise<string> {
  const userId = getCurrentUserId()
  const ceiling = userId ? await getUserPermissionCeiling(userId) : 'default'
  const adminFlag = userId && (await isAdmin(userId)) ? t('status.adminFlag') : ''
  const channelLabel = ctx.isChannel ? 'channel' : 'terminal'
  const totals = getUsageTotals()
  const sessionTok = totals.inputTokens + totals.outputTokens
  const lines: string[] = [
    t('status.you', { user: userId ?? '(none)', adminFlag, channel: channelLabel }),
    t('status.modeLine', { mode: modeToAlias(getPermissionMode()), ceiling: modeToAlias(ceiling) }),
    t('status.modelLine', { model: getModel() }),
    t('status.sessionLine', { id: ctx.sessionId, msgs: ctx.messages.length, tok: sessionTok }),
  ]
  if (ctx.isAdmin) {
    const identities = await listIdentities()
    const names = Object.keys(identities).sort()
    if (names.length > 1) {
      lines.push('', t('status.identitiesTitle'))
      for (const name of names) {
        const m = (await isAdmin(name)) ? t('status.identitiesAdmin') : ''
        const c = identities[name]!.permissionCeiling ?? 'default'
        lines.push(t('status.identitiesLine', { name, adminFlag: m, ceiling: modeToAlias(c) }))
      }
    }
  }
  lines.push('')
  return color(ctx, lines.join('\n'))
}

async function runUserCommand(rawArgs: string): Promise<string> {
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

async function formatCost(): Promise<string> {
  const now = new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
  const records: UsageRecord[] = []
  for await (const rec of readUsage({ sinceTs: monthStart })) {
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
  for (const name of names) {
    const record = identities[name]
    const marker = await isAdmin(name) ? t('status.identitiesAdmin') : ''
    lines.push(`${name}${marker} ceiling=${modeToAlias(record.permissionCeiling ?? 'default')}`)
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

async function userApprove(args: string[]): Promise<string> {
  const code = args[0]
  const asIndex = args.indexOf('--as')
  const name = asIndex >= 0 ? args[asIndex + 1] : undefined
  if (!code || !name) {
    return `${t('user.approve.usage')}\n`
  }
  const reject = await rejectNonAdminInLocal(name)
  if (reject) {
    return reject
  }
  const entry = await approveCode(code)
  if (!entry) {
    return `${t('user.approve.noSuchCode', { code })}\n`
  }
  const link = `${entry.channel}:${entry.peerId}` as SenderKey
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
  preheatAndWelcomeOnApproval(name, link)
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

function preheatAndWelcomeOnApproval(name: string, link: SenderKey): void {
  // Fire-and-forget at the call site (admin's /user approve returns
  // immediately), but the inner task awaits readiness so the welcome card
  // is only pushed once the user can actually exercise tools. Failure /
  // timeout pushes a failure card so the approved user is never left
  // wondering whether the bot got their request.
  void runApprovalPreheat(name, link).catch(error => {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[preheat-on-approval] ${name}: unhandled ${detail}\n`)
  })
}

async function runApprovalPreheat(name: string, link: SenderKey): Promise<void> {
  const config = getConfig()
  const backend = config.runtime.backend
  // local: admin-only, no per-user runtime to warm up.
  // rjob: not productionized yet, skip.
  if (backend !== 'docker' && backend !== 'rlaunch') {
    return
  }
  // Rlaunch keeps the original opt-out toggle; Docker has no equivalent
  // toggle today and is always-on (the welcome push is what the toggle
  // would otherwise gate, and the user-visible UX is the whole point).
  if (backend === 'rlaunch' && !config.runtime.rlaunch.preheatOnApproval) {
    return
  }

  const channel = link.split(':', 1)[0]
  if (channel !== 'feishu') {
    // Future channels: add a registry per channel kind. For now non-feishu
    // approvals just preheat without a welcome push.
    const runtime = backend === 'docker'
      ? getRuntimePool().acquire(name, config, undefined, getImageReadiness())
      : getRuntimePool().acquire(name, config)
    await runtime.start().catch(error => {
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(`[preheat-on-approval] ${name}: ${detail}\n`)
    })
    return
  }

  const openId = link.slice('feishu:'.length)
  const { getFeishuSender } = await import('../channels/feishu/sender-registry.js')
  const { buildApprovalWelcomeCard, buildStartupFailureCard } =
    await import('../channels/feishu/welcome-card.js')
  const { waitUntilRuntimeAvailable } = await import('../runtime/wait-ready.js')

  const sender = getFeishuSender()
  if (!sender) {
    // Channel hasn't started (admin running approve from terminal-only
    // process). Still preheat so the user's first message later isn't
    // blocked, but no push surface to deliver the welcome card.
    process.stderr.write(
      `[preheat-on-approval] ${name}: feishu sender not registered; preheating without welcome push\n`,
    )
    const runtime = backend === 'docker'
      ? getRuntimePool().acquire(name, config, undefined, getImageReadiness())
      : getRuntimePool().acquire(name, config)
    await runtime.start().catch(error => {
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(`[preheat-on-approval] ${name}: ${detail}\n`)
    })
    return
  }

  const tracker = backend === 'docker' ? getImageReadiness() : undefined
  const runtime = getRuntimePool().acquire(name, config, undefined, tracker)
  try {
    await runtime.start()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[preheat-on-approval] ${name}: start failed: ${detail}\n`)
    await sender
      .sendInteractiveCardToOpenId(
        openId,
        buildStartupFailureCard({ reason: detail, elapsedSeconds: 0, timedOut: false }),
      )
      .catch(pushError => {
        const pd = pushError instanceof Error ? pushError.message : String(pushError)
        process.stderr.write(`[preheat-on-approval] ${name}: failure push send failed: ${pd}\n`)
      })
    return
  }

  const ready = await waitUntilRuntimeAvailable(runtime)
  if (!ready.ok) {
    const elapsedSeconds = Math.round(ready.elapsedMs / 1000)
    const reason =
      ready.availability.ok === false
        ? ready.availability.adminMessage || ready.availability.userMessage || ready.availability.reason
        : 'unknown'
    process.stderr.write(
      `[preheat-on-approval] ${name}: not ready after ${elapsedSeconds}s (timedOut=${ready.timedOut}): ${reason}\n`,
    )
    await sender
      .sendInteractiveCardToOpenId(
        openId,
        buildStartupFailureCard({ reason, elapsedSeconds, timedOut: ready.timedOut }),
      )
      .catch(pushError => {
        const pd = pushError instanceof Error ? pushError.message : String(pushError)
        process.stderr.write(`[preheat-on-approval] ${name}: failure push send failed: ${pd}\n`)
      })
    return
  }

  const elapsedSeconds = Math.round(ready.elapsedMs / 1000)
  process.stderr.write(
    `[preheat-on-approval] ${name}: runtime ready after ${elapsedSeconds}s; sending welcome card\n`,
  )
  await sender
    .sendInteractiveCardToOpenId(openId, buildApprovalWelcomeCard())
    .catch(pushError => {
      const pd = pushError instanceof Error ? pushError.message : String(pushError)
      process.stderr.write(`[preheat-on-approval] ${name}: welcome push send failed: ${pd}\n`)
    })
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
  return result.ok
    ? `${t('user.remove.done', { name })}\n`
    : `${t('user.remove.noSuch', { name })}\n`
}

function isModeWithinCeiling(mode: PermissionMode, ceiling: PermissionMode): boolean {
  return modeRank(mode) <= modeRank(ceiling)
}

function modeRank(mode: PermissionMode): number {
  // Rank reflects actual looseness from permission/policy.ts:
  //   plan              — only safe (read-only) tools allowed   → strictest
  //   default           — safe runs free, write/execute ASK
  //   acceptEdits       — safe + write run free, execute ASK
  //   bypassPermissions — everything runs                       → loosest
  // Ceiling=default therefore allows {plan, default} so a user who wants
  // read-only mode can opt into plan without an admin bumping the ceiling.
  switch (mode) {
    case 'plan':
      return 0
    case 'default':
      return 1
    case 'acceptEdits':
      return 2
    case 'bypassPermissions':
      return 3
  }
}

function firstLine(text: string): string {
  return text.split('\n').map(line => line.trim()).find(Boolean) ?? text
}

function color(ctx: ReplContext, text: string): string {
  return ctx.isChannel ? text : chalk.gray(text)
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
