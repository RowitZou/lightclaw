import {
  addLink,
  createUser,
  getAdmin,
  isAdmin,
  listIdentities,
  lookupBySender,
  parseSenderKey,
  rebuildReverseIndex,
  removeLink,
  removeUser,
} from './identity/store.js'
import {
  approveCode,
  listPending,
  rejectCode,
} from './identity/pairing.js'
import type { SenderKey } from './identity/types.js'

export async function runIdentityCli(action: string, args: string[]): Promise<void> {
  await rebuildReverseIndex()
  switch (action) {
    case 'list':
      await listCommand()
      return
    case 'pending':
      await pendingCommand()
      return
    case 'approve':
      await approveCommand(args)
      return
    case 'reject':
      await rejectCommand(args)
      return
    case 'link':
      await linkCommand(args)
      return
    case 'unlink':
      await unlinkCommand(args)
      return
    case 'remove':
      await removeCommand(args)
      return
    default:
      printIdentityUsage()
  }
}

async function listCommand(): Promise<void> {
  const identities = await listIdentities()
  const names = Object.keys(identities).sort()
  if (names.length === 0) {
    console.log('No identities.')
    return
  }
  for (const name of names) {
    const record = identities[name]
    const marker = await isAdmin(name) ? ' *admin' : ''
    console.log(`${name}${marker}`)
    for (const channel of ['terminal', 'feishu', 'wechat'] as const) {
      for (const peerId of record.channels[channel]) {
        console.log(`  - ${channel}:${peerId}`)
      }
    }
  }
}

async function pendingCommand(): Promise<void> {
  const pending = await listPending()
  if (pending.length === 0) {
    console.log('No pending pairing requests.')
    return
  }
  console.log('KEY      CHANNEL  PEER_ID                                  DISPLAY          REQUESTED')
  for (const item of pending) {
    console.log([
      item.code.padEnd(8, ' '),
      item.channel.padEnd(8, ' '),
      item.peerId.slice(0, 40).padEnd(40, ' '),
      (item.displayName || '-').slice(0, 16).padEnd(16, ' '),
      formatAge(item.createdAt),
    ].join(' '))
  }
}

async function approveCommand(args: string[]): Promise<void> {
  const code = args[0]
  const asIndex = args.indexOf('--as')
  const name = asIndex >= 0 ? args[asIndex + 1] : undefined
  if (!code || !name) {
    console.error('Usage: lightclaw identity approve <code> --as <name>')
    process.exitCode = 1
    return
  }

  const entry = await approveCode(code)
  if (!entry) {
    console.error(`No pending pairing code: ${code}`)
    process.exitCode = 1
    return
  }
  const link = `${entry.channel}:${entry.peerId}` as SenderKey
  const boundTo = lookupBySender(link)
  if (boundTo && boundTo !== name) {
    console.error(`${link} is already bound to ${boundTo}`)
    process.exitCode = 1
    return
  }
  const created = await createUser(name)
  if (!created.ok && created.reason !== 'exists') {
    console.error(`Invalid identity name: ${name}`)
    process.exitCode = 1
    return
  }
  const linked = await addLink(name, link)
  if (!linked.ok) {
    console.error(
      linked.reason === 'already-bound'
        ? `${link} is already bound to ${linked.boundTo}`
        : `No such user: ${name}`,
    )
    process.exitCode = 1
    return
  }
  console.log(`${created.ok ? 'Created' : 'Updated'} identity '${name}'`)
  console.log(`Linked ${link} -> ${name}`)
}

async function rejectCommand(args: string[]): Promise<void> {
  const code = args[0]
  if (!code) {
    console.error('Usage: lightclaw identity reject <code>')
    process.exitCode = 1
    return
  }
  const result = await rejectCode(code)
  console.log(result.ok ? `Rejected ${code}` : `No pending pairing code: ${code}`)
  if (!result.ok) {
    process.exitCode = 1
  }
}

async function linkCommand(args: string[]): Promise<void> {
  const [name, rawLink] = args
  if (!name || !rawLink) {
    console.error('Usage: lightclaw identity link <name> <channel:id>')
    process.exitCode = 1
    return
  }
  try {
    parseSenderKey(rawLink)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
    return
  }
  const boundTo = lookupBySender(rawLink as SenderKey)
  if (boundTo && boundTo !== name) {
    console.error(`${rawLink} is already bound to ${boundTo}`)
    process.exitCode = 1
    return
  }
  const created = await createUser(name)
  if (!created.ok && created.reason !== 'exists') {
    console.error(`Invalid identity name: ${name}`)
    process.exitCode = 1
    return
  }
  const linked = await addLink(name, rawLink as SenderKey)
  if (!linked.ok) {
    console.error(
      linked.reason === 'already-bound'
        ? `${rawLink} is already bound to ${linked.boundTo}`
        : `No such user: ${name}`,
    )
    process.exitCode = 1
    return
  }
  console.log(`Linked ${rawLink} -> ${name}`)
}

async function unlinkCommand(args: string[]): Promise<void> {
  const [rawLink] = args
  if (!rawLink) {
    console.error('Usage: lightclaw identity unlink <channel:id>')
    process.exitCode = 1
    return
  }
  try {
    parseSenderKey(rawLink)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
    return
  }
  const boundTo = lookupBySender(rawLink as SenderKey)
  if (!boundTo) {
    console.error(`${rawLink} is not bound.`)
    process.exitCode = 1
    return
  }
  const result = await removeLink(boundTo, rawLink as SenderKey)
  console.log(result.ok ? `Unlinked ${rawLink} from ${boundTo}` : `${rawLink} was not linked.`)
}

async function removeCommand(args: string[]): Promise<void> {
  const name = args[0]
  if (!name) {
    console.error('Usage: lightclaw identity remove <name> [--purge]')
    process.exitCode = 1
    return
  }
  if ((await getAdmin()) === name) {
    console.error('Refusing to remove the v1 admin identity.')
    process.exitCode = 1
    return
  }
  const result = await removeUser(name, { purge: args.includes('--purge') })
  console.log(result.ok ? `Removed identity '${name}'` : `No such identity: ${name}`)
  if (!result.ok) {
    process.exitCode = 1
  }
}

function printIdentityUsage(): void {
  console.log(`Usage:
  lightclaw identity list
  lightclaw identity pending
  lightclaw identity approve <code> --as <name>
  lightclaw identity reject <code>
  lightclaw identity link <name> <channel:id>
  lightclaw identity unlink <channel:id>
  lightclaw identity remove <name> [--purge]
`)
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
