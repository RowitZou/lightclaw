import chalk from 'chalk'

import { parsePermissionMode } from '../config.js'
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
  setAllPermissionCeilings,
} from '../identity/store.js'
import { approveCode, listPending, rejectCode } from '../identity/pairing.js'
import type { SenderKey } from '../identity/types.js'
import { PERMISSION_MODES, type PermissionMode } from '../permission/types.js'
import { listRegisteredSkills, refreshSkillRegistry } from '../skill/registry.js'
import {
  getCurrentUserId,
  getCwd,
  getModel,
  getPermissionMode,
  setModel,
  setPermissionMode,
} from '../state.js'

import type { ReplCommand, ReplContext } from './registry.js'
import { ReplCommandRegistry } from './registry.js'

export function createBuiltinReplRegistry(): ReplCommandRegistry {
  const registry = new ReplCommandRegistry()
  for (const command of BUILTIN_COMMANDS) {
    registry.register(command)
  }
  return registry
}

const BUILTIN_COMMANDS: ReplCommand[] = [
  {
    name: '/help',
    usage: '/help',
    description: 'Show available models, modes, skills, and commands',
    async handler(_args, ctx) {
      ctx.output.write(await formatHelp(ctx))
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
    usage: '/mode <default|plan|acceptEdits|bypassPermissions>',
    description: 'Switch permission mode within your ceiling',
    async handler(args, ctx) {
      const mode = parsePermissionMode(args.trim())
      if (!mode) {
        ctx.output.write('error> Usage: /mode default|plan|acceptEdits|bypassPermissions\n')
        return
      }
      const userId = getCurrentUserId()
      const ceiling = userId ? await getUserPermissionCeiling(userId) : 'default'
      if (!isModeWithinCeiling(mode, ceiling)) {
        ctx.output.write(`error> mode ${mode} exceeds your ceiling ${ceiling}.\n`)
        return
      }
      setPermissionMode(mode)
      ctx.output.write(`mode: ${mode}\n`)
      await ctx.persistMeta(ctx.messages.length)
    },
  },
  {
    name: '/ceiling',
    usage: '/ceiling <default|plan|acceptEdits|bypassPermissions>',
    description: 'Set permission ceiling for LightClaw users',
    visibleTo: 'admin',
    async handler(args, ctx) {
      const mode = parsePermissionMode(args.trim())
      if (!mode) {
        ctx.output.write('error> Usage: /ceiling default|plan|acceptEdits|bypassPermissions\n')
        return
      }
      const count = await setAllPermissionCeilings(mode)
      ctx.output.write(`ceiling: ${mode} (${count} identities updated)\n`)
    },
  },
  {
    name: '/identity',
    usage: '/identity list|pending|approve|reject|link|unlink|remove',
    description: 'Manage identities and pairing requests',
    visibleTo: 'admin',
    async handler(args, ctx) {
      ctx.output.write(await runIdentityCommand(args))
    },
  },
]

async function formatHelp(ctx: ReplContext): Promise<string> {
  await refreshSkillRegistry(getCwd())
  const userId = getCurrentUserId()
  const ceiling = userId ? await getUserPermissionCeiling(userId) : 'default'
  const modes = PERMISSION_MODES.filter(mode => isModeWithinCeiling(mode, ceiling))
  const registry = createBuiltinReplRegistry()
  const commands = registry.list(Boolean(ctx.isAdmin))
  const skills = listRegisteredSkills()
  const lines = [
    'LightClaw - your personal assistant.',
    '',
    `current model: ${getModel()}`,
    `current mode:  ${getPermissionMode()}`,
    '',
    'available models:',
    ...ctx.config.allowedModels.map(model => `  - ${model}`),
    '',
    `available modes (within your ceiling: ${ceiling}):`,
    ...modes.map(mode => `  - ${mode}`),
    '',
    'available skills:',
    ...(skills.length
      ? skills.map(skill => `  - ${skill.name.padEnd(14, ' ')} ${firstLine(skill.description)}`)
      : ['  (none)']),
    '',
    'commands:',
    ...commands.map(command => `  ${command.usage.padEnd(38, ' ')} ${command.description}`),
    '',
  ]
  return color(ctx, lines.join('\n'))
}

async function runIdentityCommand(rawArgs: string): Promise<string> {
  await rebuildReverseIndex()
  const args = rawArgs.trim().split(/\s+/).filter(Boolean)
  const action = args.shift()
  switch (action) {
    case 'list':
      return identityList()
    case 'pending':
      return identityPending()
    case 'approve':
      return identityApprove(args)
    case 'reject':
      return identityReject(args)
    case 'link':
      return identityLink(args)
    case 'unlink':
      return identityUnlink(args)
    case 'remove':
      return identityRemove(args)
    default:
      return [
        'Usage:',
        '  /identity list',
        '  /identity pending',
        '  /identity approve <code> --as <name>',
        '  /identity reject <code>',
        '  /identity link <name> <channel:id>',
        '  /identity unlink <channel:id>',
        '  /identity remove <name> [--purge]',
        '',
      ].join('\n')
  }
}

async function identityList(): Promise<string> {
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
    for (const channel of ['terminal', 'feishu', 'wechat'] as const) {
      for (const peerId of record.channels[channel]) {
        lines.push(`  - ${channel}:${peerId}`)
      }
    }
  }
  return `${lines.join('\n')}\n`
}

async function identityPending(): Promise<string> {
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

async function identityApprove(args: string[]): Promise<string> {
  const code = args[0]
  const asIndex = args.indexOf('--as')
  const name = asIndex >= 0 ? args[asIndex + 1] : undefined
  if (!code || !name) {
    return 'Usage: /identity approve <code> --as <name>\n'
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
  return `${created.ok ? 'Created' : 'Updated'} identity '${name}'\nLinked ${link} -> ${name}\n`
}

async function identityReject(args: string[]): Promise<string> {
  const code = args[0]
  if (!code) {
    return 'Usage: /identity reject <code>\n'
  }
  const result = await rejectCode(code)
  return result.ok ? `Rejected ${code}\n` : `No pending pairing code: ${code}\n`
}

async function identityLink(args: string[]): Promise<string> {
  const [name, rawLink] = args
  if (!name || !rawLink) {
    return 'Usage: /identity link <name> <channel:id>\n'
  }
  try {
    parseSenderKey(rawLink)
  } catch (error) {
    return `${error instanceof Error ? error.message : String(error)}\n`
  }
  const boundTo = lookupBySender(rawLink as SenderKey)
  if (boundTo && boundTo !== name) {
    return `${rawLink} is already bound to ${boundTo}\n`
  }
  const created = await createUser(name)
  if (!created.ok && created.reason !== 'exists') {
    return `Invalid identity name: ${name}\n`
  }
  const linked = await addLink(name, rawLink as SenderKey)
  if (!linked.ok) {
    return linked.reason === 'already-bound'
      ? `${rawLink} is already bound to ${linked.boundTo}\n`
      : `No such user: ${name}\n`
  }
  return `Linked ${rawLink} -> ${name}\n`
}

async function identityUnlink(args: string[]): Promise<string> {
  const [rawLink] = args
  if (!rawLink) {
    return 'Usage: /identity unlink <channel:id>\n'
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

async function identityRemove(args: string[]): Promise<string> {
  const name = args[0]
  if (!name) {
    return 'Usage: /identity remove <name> [--purge]\n'
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
