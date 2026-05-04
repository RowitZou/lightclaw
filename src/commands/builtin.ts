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

import { appendFeedback, readAllFeedback } from './feedback-store.js'
import {
  MODE_ALIASES,
  MODE_DESCRIPTIONS,
  modeToAlias,
  parseMode,
} from './mode-aliases.js'
import type { ReplCommand, ReplContext } from './registry.js'
import { ReplCommandRegistry } from './registry.js'
import { readUsage, type UsageRecord } from '../usage/storage.js'

export function createBuiltinReplRegistry(): ReplCommandRegistry {
  const registry = new ReplCommandRegistry()
  for (const command of BUILTIN_COMMANDS) {
    registry.register(command)
  }
  return registry
}

export const RENAMED_COMMANDS: Record<string, string> = {
  '/identity': '/user',
  '/permissions': '/rules',
}

const BUILTIN_COMMANDS: ReplCommand[] = [
  {
    name: '/help',
    usage: '/help',
    description: 'List available commands',
    async handler(_args, ctx) {
      ctx.output.write(await formatHelp(ctx))
    },
  },
  {
    name: '/status',
    usage: '/status',
    description: 'Show current user / mode / model / session',
    async handler(_args, ctx) {
      ctx.output.write(await formatStatus(ctx))
    },
  },
  {
    name: '/stop',
    usage: '/stop',
    description: 'Abort the in-flight turn (already-written files are not rolled back)',
    async handler(_args, ctx) {
      const userId = ctx.userId ?? getCurrentUserId()
      if (!userId) {
        ctx.output.write('error> /stop requires an active identity.\n')
        return
      }
      const aborted = abortInFlightForUser(userId)
      ctx.output.write(
        aborted
          ? 'Stopped. (in-flight tool calls cancelled; written files are not rolled back)\n'
          : 'Nothing in flight.\n',
      )
    },
  },
  {
    name: '/feedback',
    usage: '/feedback <text>',
    description: 'Send feedback to admin (admin reads via /user feedback)',
    visibleTo: 'user',
    async handler(args, ctx) {
      const text = args.trim()
      if (!text) {
        ctx.output.write('error> Usage: /feedback <text>\n')
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
        ctx.output.write('Thanks. Forwarded to admin.\n')
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        ctx.output.write(`error> Failed to forward (${detail}). Please tell admin in person.\n`)
      }
    },
  },
  {
    name: '/cost',
    usage: '/cost',
    description: 'Show this month token usage by-model + by-user (admin only)',
    visibleTo: 'admin',
    async handler(_args, ctx) {
      ctx.output.write(await formatCost())
    },
  },
  {
    name: '/fresh',
    usage: '/fresh <prompt>',
    description: 'Run an ephemeral one-shot session (no memory, no transcript, mode=default)',
    async handler(args, ctx) {
      const prompt = args.trim()
      if (!prompt) {
        ctx.output.write('error> Usage: /fresh <prompt>\n')
        return
      }
      const { runFresh } = await import('./fresh.js')
      const result = await runFresh({
        config: ctx.config,
        prompt,
        callerUserId: ctx.userId ?? getCurrentUserId(),
        isChannel: Boolean(ctx.isChannel),
      })
      ctx.output.write(result)
    },
  },
  {
    name: '/model',
    usage: '/model <name>',
    description: 'Switch model for this session',
    async handler(args, ctx) {
      const model = args.trim()
      if (!model) {
        ctx.output.write(`current model: ${getModel()}\n`)
        ctx.output.write(`available: ${ctx.config.allowedModels.join(', ')}\n`)
        return
      }
      if (!ctx.config.allowedModels.includes(model)) {
        ctx.output.write(`error> unknown model: ${model}\n`)
        ctx.output.write(`available: ${ctx.config.allowedModels.join(', ')}\n`)
        return
      }
      setModel(model)
      ctx.config.model = model
      ctx.config.routing.main = model
      ctx.output.write(`model: ${model}\n`)
      await ctx.persistMeta(ctx.messages.length)
    },
  },
  {
    name: '/mode',
    usage: '/mode [<read|ask|auto|yolo>]',
    description: 'Show current mode + 4-tier menu, or switch within your ceiling',
    async handler(args, ctx) {
      const trimmed = args.trim()
      const userId = getCurrentUserId()
      const ceiling = userId ? await getUserPermissionCeiling(userId) : 'default'
      if (!trimmed) {
        const current = getPermissionMode()
        const lines: string[] = ['Modes:']
        for (const alias of MODE_ALIASES) {
          const isCurrent = alias === modeToAlias(current)
          const within = isModeWithinCeiling(parseMode(alias)!, ceiling)
          const marker = isCurrent ? '  <- current' : (within ? '' : '  (above ceiling)')
          lines.push(`  ${alias.padEnd(5)} ${MODE_DESCRIPTIONS[alias]}${marker}`)
        }
        lines.push('', `Ceiling: ${modeToAlias(ceiling)}`, '')
        ctx.output.write(lines.join('\n'))
        return
      }
      const mode = parseMode(trimmed)
      if (!mode) {
        ctx.output.write(`error> Unknown mode: ${trimmed}. Try: ${MODE_ALIASES.join(' / ')}\n`)
        return
      }
      if (!isModeWithinCeiling(mode, ceiling)) {
        ctx.output.write(`error> mode ${modeToAlias(mode)} exceeds your ceiling ${modeToAlias(ceiling)}.\n`)
        return
      }
      setPermissionMode(mode)
      ctx.output.write(`mode: ${modeToAlias(mode)}\n`)
      await ctx.persistMeta(ctx.messages.length)
    },
  },
  {
    name: '/ceiling',
    usage: '/ceiling [<user> <read|ask|auto|yolo>]',
    description:
      'Show every identity\'s ceiling, or set one user\'s ceiling. Bare /ceiling lists all.',
    visibleTo: 'admin',
    async handler(args, ctx) {
      const parts = args.trim().split(/\s+/).filter(Boolean)
      if (parts.length === 0) {
        ctx.output.write(await formatCeilingList())
        return
      }
      if (parts.length !== 2) {
        ctx.output.write(
          'error> Usage: /ceiling                       (list all)\n' +
          '       /ceiling <user> <read|ask|auto|yolo>\n',
        )
        return
      }
      const [name, modeText] = parts
      const mode = parseMode(modeText!)
      if (!mode) {
        ctx.output.write(
          `error> Invalid mode: ${modeText}. Try: ${MODE_ALIASES.join(' / ')}.\n`,
        )
        return
      }
      const result = await setUserPermissionCeiling(name!, mode)
      if (!result.ok) {
        ctx.output.write(`error> No such identity: ${name}\n`)
        return
      }
      ctx.output.write(`ceiling: ${name} -> ${modeToAlias(mode)}\n`)
    },
  },
  {
    name: '/user',
    usage: '/user list|pending|approve|reject|unlink|remove|feedback',
    description: 'Manage identities and pairing requests',
    visibleTo: 'admin',
    async handler(args, ctx) {
      ctx.output.write(await runUserCommand(args))
    },
  },
  {
    name: '/sandbox',
    usage: '/sandbox [status|prefetch|reset]',
    description: 'Inspect / re-pull / reset the Docker sandbox image and container',
    async handler(args, ctx) {
      const action = args.trim() || 'status'
      if (action === 'status') {
        const tracker = getImageReadiness()
        const snap = tracker.snapshot()
        const lines = ['Sandbox image readiness:']
        lines.push(`  state: ${snap.state}`)
        if (snap.image) lines.push(`  image: ${snap.image}`)
        if (snap.pullDurationMs !== undefined) {
          lines.push(`  ${snap.state === 'ready' ? 'pulled in' : 'elapsed'}: ${Math.round(snap.pullDurationMs / 1000)}s`)
        }
        if (snap.lastError) lines.push(`  lastError: ${snap.lastError}`)
        const runtime = getRuntime()
        if (runtime instanceof DockerRuntime) {
          lines.push(`  container: ${runtime.containerName}`)
        } else if (runtime instanceof RlaunchRuntime) {
          lines.push(`  worker: ${runtime.name ?? '(not started)'}`)
        } else {
          lines.push('  (local runtime active; readiness tracker unused)')
        }
        lines.push('')
        ctx.output.write(lines.join('\n'))
        return
      }
      if (action === 'prefetch') {
        const tracker = getImageReadiness()
        if (ctx.config.runtime.backend !== 'docker') {
          ctx.output.write('sandbox: prefetch requires runtime.backend = "docker".\n')
          return
        }
        const image = resolveDockerImage(ctx.config)
        // Force re-check: clear failed/not-attempted to retry; if pulling/ready
        // call again is a no-op handled inside the tracker.
        tracker.retryIfFailed()
        if (tracker.state === 'ready') {
          // Even when tracker thinks ready, re-inspect via startPrefetch on a
          // fresh tracker is too aggressive; just report. Use /sandbox reset
          // followed by next tool call to force container recreation if image
          // was externally rmi'd.
          ctx.output.write(`sandbox: image ${image} marked ready; nothing to do.\n`)
          return
        }
        if (tracker.state === 'pulling') {
          ctx.output.write(`sandbox: image ${image} pull already in progress.\n`)
          return
        }
        // Force a fresh attempt by triggering retry (no-op above already moved
        // failed→pulling); fall back to direct startPrefetch in case state is
        // some other value.
        tracker.startPrefetch(image, {
          inspectOnly: !ctx.config.runtime.docker.autoPull,
        })
        ctx.output.write(`sandbox: prefetch started for ${image}.\n`)
        return
      }
      if (action !== 'reset') {
        ctx.output.write('error> Usage: /sandbox [status|prefetch|reset]\n')
        return
      }
      const userId = getCurrentUserId()
      if (!userId) {
        ctx.output.write('error> No active LightClaw identity.\n')
        return
      }
      const runtime = getRuntime()
      if (!(runtime instanceof DockerRuntime)) {
        if (runtime instanceof RlaunchRuntime) {
          await getRuntimePool().remove(userId)
          ctx.output.write([
            'Stopped and removed rlaunch worker state.',
            'Workspace gpfs mount was preserved.',
            'Next environment tool call will recreate the worker.',
            '',
          ].join('\n'))
          return
        }
        ctx.output.write('sandbox: local runtime is active; nothing to reset.\n')
        return
      }
      const containerName = runtime.containerName
      const image = runtime.image || resolveDockerImage(ctx.config)
      await getRuntimePool().remove(userId)
      ctx.output.write([
        `Stopped and removed sandbox container ${containerName}.`,
        'Tier 1 (/workspace bind mount) preserved.',
        'Tier 2 (writable layer; pip packages, /etc edits) discarded.',
        `Next environment tool call will recreate the container from ${image}.`,
        '',
      ].join('\n'))
    },
  },
  {
    name: '/rules',
    usage: '/rules [list | revoke <n> | revoke all | ask <rule>]',
    description:
      'Manage your persisted permission rules. list shows numbered rules; revoke <n> removes one; revoke all clears them; ask <rule> registers an ASK rule that overrides allow / bypassPermissions for matching calls.',
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
          ctx.output.write('error> /rules revoke requires an active identity.\n')
          return
        }
        const target = rest[0]
        if (!target) {
          ctx.output.write('error> Usage: /rules revoke <n>|all\n')
          return
        }
        if (target === 'all') {
          const before = getIdentityRules().length
          clearIdentityRules(userId)
          setIdentityRules([])
          ctx.output.write(
            before === 0
              ? 'No persisted rules to revoke.\n'
              : `Revoked all ${before} rule${before === 1 ? '' : 's'}.\n`,
          )
          return
        }
        const n = Number.parseInt(target, 10)
        const sorted = sortRulesForDisplay(getIdentityRules())
        if (!Number.isInteger(n) || n < 1 || n > sorted.length) {
          ctx.output.write(
            `error> No rule at index ${target}. Run /rules list first.\n`,
          )
          return
        }
        const victim = sorted[n - 1]!
        removeIdentityRule({ canonicalUser: userId, rule: victim })
        setIdentityRules(loadIdentityRules(userId))
        ctx.output.write(
          `Revoked [${victim.behavior}] ${formatRule(victim.value)}\n\n${formatRulesList()}`,
        )
        return
      }
      if (sub === 'ask') {
        const ruleText = rest.join(' ').trim()
        if (!ruleText) {
          ctx.output.write('error> Usage: /rules ask <rule>\n')
          return
        }
        if (!userId) {
          ctx.output.write('error> /rules ask requires an active identity.\n')
          return
        }
        let value
        try {
          value = parseRule(ruleText)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          ctx.output.write(`error> ${detail}\n`)
          return
        }
        const rule: PermissionRule = { source: 'identity', behavior: 'ask', value }
        appendIdentityRules({ canonicalUser: userId, rules: [rule] })
        setIdentityRules(loadIdentityRules(userId))
        ctx.output.write(
          `Registered ASK rule: ${formatRule(value)} (overrides allow / bypassPermissions for matching calls; persisted)\n`,
        )
        return
      }
      ctx.output.write('error> Usage: /rules [list | revoke <n> | revoke all | ask <rule>]\n')
    },
  },
]

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
    return 'No persisted permission rules for this user.\n'
  }
  const indexWidth = String(sorted.length).length
  const lines = ['Persisted permission rules (this user):']
  for (const [i, rule] of sorted.entries()) {
    const idx = String(i + 1).padStart(indexWidth, ' ')
    lines.push(`  [${idx}] ${rule.behavior.padEnd(5, ' ')} ${formatRule(rule.value)}`)
  }
  lines.push(
    '',
    'Use /rules revoke <n> to remove one, /rules revoke all to clear.',
    '(numbering changes after each write — re-run list before another revoke)',
    '',
  )
  return lines.join('\n')
}

async function formatCeilingList(): Promise<string> {
  const identities = await listIdentities()
  const names = Object.keys(identities).sort()
  if (names.length === 0) {
    return 'No identities.\n'
  }
  const lines = ['Permission ceilings:']
  for (const name of names) {
    const ceiling = identities[name]!.permissionCeiling ?? 'default'
    const marker = (await isAdmin(name)) ? ' *admin' : ''
    lines.push(`  ${name}${marker} -> ${modeToAlias(ceiling)}`)
  }
  lines.push(
    '',
    'Set with: /ceiling <user> <read|ask|auto|yolo>',
    '',
  )
  return lines.join('\n')
}

async function formatHelp(ctx: ReplContext): Promise<string> {
  const registry = createBuiltinReplRegistry()
  const all = registry.list(true)
  const userCmds = all.filter(c => (c.visibleTo ?? 'all') === 'all')
  const adminCmds = all.filter(c => c.visibleTo === 'admin')
  const usageWidth = Math.max(
    ...all.map(c => c.usage.length),
    24,
  )
  const lines: string[] = [
    'LightClaw commands:',
    '',
    ...userCmds.map(c => `  ${c.usage.padEnd(usageWidth, ' ')}  ${c.description}`),
  ]
  if (ctx.isAdmin && adminCmds.length > 0) {
    lines.push('', 'Admin only:', '')
    for (const c of adminCmds) {
      lines.push(`  ${c.usage.padEnd(usageWidth, ' ')}  ${c.description}`)
    }
  }
  lines.push('', 'Use /status to see your current user / mode / model / session.', '')
  return color(ctx, lines.join('\n'))
}

async function formatStatus(ctx: ReplContext): Promise<string> {
  const userId = getCurrentUserId()
  const ceiling = userId ? await getUserPermissionCeiling(userId) : 'default'
  const adminFlag = userId && (await isAdmin(userId)) ? ' (admin)' : ''
  const channelLabel = ctx.isChannel ? 'channel' : 'terminal'
  const totals = getUsageTotals()
  const sessionTok = totals.inputTokens + totals.outputTokens
  const lines: string[] = [
    `You: ${userId ?? '(none)'}${adminFlag} on ${channelLabel}`,
    `Mode: ${modeToAlias(getPermissionMode())}  (ceiling: ${modeToAlias(ceiling)})`,
    `Model: ${getModel()}`,
    `Session: ${ctx.sessionId} (msgs: ${ctx.messages.length}, tok: ${sessionTok})`,
  ]
  if (ctx.isAdmin) {
    const identities = await listIdentities()
    const names = Object.keys(identities).sort()
    if (names.length > 1) {
      lines.push('', 'Identities:')
      for (const name of names) {
        const marker = (await isAdmin(name)) ? ' *admin' : ''
        const c = identities[name]!.permissionCeiling ?? 'default'
        lines.push(`  ${name}${marker}  ceiling=${modeToAlias(c)}`)
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
        ? `Usage (LocalRuntime is single-user; bind only as admin "${adminId}"):`
        : 'Usage:'
      const approveLine = isLocal && adminId
        ? `  /user approve <code> --as ${adminId}`
        : '  /user approve <code> --as <name>'
      return [
        header,
        '  /user list',
        '  /user pending',
        approveLine,
        '  /user reject <code>',
        '  /user unlink <channel:id>',
        '  /user remove <name> [--purge]',
        '  /user feedback [--page N]',
        '',
      ].join('\n')
    }
  }
}

async function userFeedback(args: string[]): Promise<string> {
  const pageIdx = args.indexOf('--page')
  const page = pageIdx >= 0 ? Math.max(1, Number.parseInt(args[pageIdx + 1] ?? '1', 10) || 1) : 1
  const pageSize = 20
  const all = await readAllFeedback()
  if (all.length === 0) {
    return 'No feedback yet.\n'
  }
  const totalPages = Math.ceil(all.length / pageSize)
  if (page > totalPages) {
    return `error> Page ${page} out of range (1..${totalPages}).\n`
  }
  const slice = all.slice((page - 1) * pageSize, page * pageSize)
  const lines = slice.map(r =>
    `  ${r.ts.slice(0, 19)} ${r.user}@${r.channel}: ${truncate(r.text, 80)}`,
  )
  return `Feedback (page ${page}/${totalPages}, total ${all.length}):\n${lines.join('\n')}\n`
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
    return 'No usage recorded this month yet.\n'
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
    `This month: ${fmt(total)} tok (cache_read: ${fmt(cacheRead)}, cache_create: ${fmt(cacheCreate)})`,
    '',
    '  By model:',
    ...[...byModel.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => `    ${m}: ${fmt(n)}`),
    '',
    '  By user:',
    ...[...byUser.entries()].sort((a, b) => b[1] - a[1]).map(([u, n]) => `    ${u}: ${fmt(n)}`),
  ]
  if (freshTok > 0) {
    lines.push('', `  Fresh subset: ${fmt(freshTok)} tok (${Math.round(freshTok * 100 / total)}%)`)
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
  return [
    `LocalRuntime is single-user; cannot bind sender as "${name}".`,
    `Only the admin user "${adminId}" can be bound on this LightClaw instance.`,
    `Either re-run with --as ${adminId} (this aliases the sender to admin),`,
    `or switch runtime.backend to "docker" in ~/.lightclaw/config.json to enable`,
    `multi-user mode.`,
    '',
  ].join('\n')
}

async function userList(): Promise<string> {
  const identities = await listIdentities()
  const names = Object.keys(identities).sort()
  if (names.length === 0) {
    return 'No identities.\n'
  }
  const lines: string[] = []
  for (const name of names) {
    const record = identities[name]
    const marker = await isAdmin(name) ? ' *admin' : ''
    lines.push(`${name}${marker} ceiling=${record.permissionCeiling ?? 'default'}`)
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
    return 'No pending pairing requests.\n'
  }
  const lines = ['KEY      CHANNEL  PEER_ID                                  DISPLAY          REQUESTED']
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
    return 'Usage: /user approve <code> --as <name>\n'
  }
  // Gate before approveCode consumes the pending entry, so a rejected
  // approval leaves the pending intact for retry with the correct name.
  const reject = await rejectNonAdminInLocal(name)
  if (reject) {
    return reject
  }
  const entry = await approveCode(code)
  if (!entry) {
    return `No pending pairing code: ${code}\n`
  }
  const link = `${entry.channel}:${entry.peerId}` as SenderKey
  const boundTo = lookupBySender(link)
  if (boundTo && boundTo !== name) {
    return `${link} is already bound to ${boundTo}\n`
  }
  const created = await createUser(name)
  if (!created.ok && created.reason !== 'exists') {
    return `Invalid identity name: ${name}\n`
  }
  const linked = await addLink(name, link)
  if (!linked.ok) {
    return linked.reason === 'already-bound'
      ? `${link} is already bound to ${linked.boundTo}\n`
      : `No such user: ${name}\n`
  }
  preheatRlaunchForUser(name)
  return `${created.ok ? 'Created' : 'Updated'} identity '${name}'\nLinked ${link} -> ${name}\n`
}

async function userReject(args: string[]): Promise<string> {
  const code = args[0]
  if (!code) {
    return 'Usage: /user reject <code>\n'
  }
  const result = await rejectCode(code)
  return result.ok ? `Rejected ${code}\n` : `No pending pairing code: ${code}\n`
}

function preheatRlaunchForUser(name: string): void {
  const config = getConfig()
  if (config.runtime.backend !== 'rlaunch' || !config.runtime.rlaunch.preheatOnApproval) {
    return
  }
  const runtime = getRuntimePool().acquire(name, config)
  void runtime.start().catch(error => {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[rlaunch-preheat-on-approval] ${name}: ${detail}\n`)
  })
}

async function userUnlink(args: string[]): Promise<string> {
  const [rawLink] = args
  if (!rawLink) {
    return 'Usage: /user unlink <channel:id>\n'
  }
  try {
    parseSenderKey(rawLink)
  } catch (error) {
    return `${error instanceof Error ? error.message : String(error)}\n`
  }
  const boundTo = lookupBySender(rawLink as SenderKey)
  if (!boundTo) {
    return `${rawLink} is not bound.\n`
  }
  const result = await removeLink(boundTo, rawLink as SenderKey)
  return result.ok ? `Unlinked ${rawLink} from ${boundTo}\n` : `${rawLink} was not linked.\n`
}

async function userRemove(args: string[]): Promise<string> {
  const name = args[0]
  if (!name) {
    return 'Usage: /user remove <name> [--purge]\n'
  }
  if ((await getAdmin()) === name) {
    return 'Refusing to remove the v1 admin identity.\n'
  }
  const result = await removeUser(name, { purge: args.includes('--purge') })
  return result.ok ? `Removed identity '${name}'\n` : `No such identity: ${name}\n`
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
