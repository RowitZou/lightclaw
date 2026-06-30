import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { getConfig } from '../config.js'
import { getMemoryDir } from '../memory/auto-memory.js'
import type { PermissionMode } from '../permission/types.js'
import { adminPath, identitiesPath, userSessionsRoot } from './paths.js'
import type {
  AdminFile,
  ChannelKind,
  IdentitiesFile,
  IdentityRecord,
  SenderKey,
} from './types.js'

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{1,31}$/

let cachedReverseIndex: Map<SenderKey, string> | null = null

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return fallback
    }
    // Permission / IO errors are NOT silent — falling back here would let
    // a transient EACCES look like an empty user database, then the next
    // write would clobber the real file with empty contents.
    throw error
  }

  try {
    return JSON.parse(raw) as T
  } catch (parseError) {
    // Bad JSON in identity / pending / rate-limits files is a real
    // corruption: silently overwriting with fallback would destroy user
    // bindings on the next save. Fail loudly so the admin can recover
    // from .git / backup / manual edit.
    throw new Error(
      `${filePath}: JSON parse failed (${(parseError as Error).message}). ` +
      'Refusing to silently overwrite a corrupt identity file.',
    )
  }
}

export async function writeJsonSecure(filePath: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await chmodBestEffort(filePath, 0o600)
}

export async function listIdentities(): Promise<IdentitiesFile> {
  return readJson<IdentitiesFile>(identitiesPath(), {})
}

export async function listActiveCanonicalUsers(): Promise<string[]> {
  return Object.keys(await listIdentities()).sort()
}

export async function getIdentity(name: string): Promise<IdentityRecord | null> {
  const identities = await listIdentities()
  return identities[name] ?? null
}

export function isValidIdentityName(name: string): boolean {
  return NAME_RE.test(name)
}

export async function createUser(
  name: string,
): Promise<{ ok: true } | { ok: false; reason: 'exists' | 'invalid-name' }> {
  if (!isValidIdentityName(name)) {
    return { ok: false, reason: 'invalid-name' }
  }

  const identities = await listIdentities()
  if (identities[name]) {
    return { ok: false, reason: 'exists' }
  }

  const now = new Date().toISOString()
  // permissionCeiling is intentionally NOT stamped here. Leaving it unset
  // makes getUserPermissionCeiling fall back to the live config default, so a
  // change to config.permissionCeiling applies to every identity that has not
  // had an explicit ceiling set via `/admin ceiling`. setUserPermissionCeiling is
  // the only writer of a persisted per-identity value.
  identities[name] = {
    createdAt: now,
    updatedAt: now,
    channels: {
      feishu: [],
      terminal: [],
    },
  }
  await writeIdentities(identities)
  return { ok: true }
}

export async function getUserPermissionCeiling(name: string): Promise<PermissionMode> {
  const identity = await getIdentity(name)
  return identity?.permissionCeiling ?? getConfig().permissionCeiling
}

export async function setUserPermissionCeiling(
  name: string,
  mode: PermissionMode,
): Promise<{ ok: boolean }> {
  const identities = await listIdentities()
  const record = identities[name]
  if (!record) {
    return { ok: false }
  }
  record.permissionCeiling = mode
  record.updatedAt = new Date().toISOString()
  await writeIdentities(identities)
  return { ok: true }
}

export async function addLink(
  name: string,
  link: SenderKey,
): Promise<{ ok: true } | { ok: false; reason: 'no-such-user' | 'already-bound'; boundTo?: string }> {
  const parsed = parseSenderKey(link)
  const identities = await listIdentities()
  const record = identities[name]
  if (!record) {
    return { ok: false, reason: 'no-such-user' }
  }

  for (const [candidateName, candidate] of Object.entries(identities)) {
    if (candidate.channels[parsed.channel].includes(parsed.peerId)) {
      return candidateName === name
        ? { ok: true }
        : { ok: false, reason: 'already-bound', boundTo: candidateName }
    }
  }

  record.channels[parsed.channel].push(parsed.peerId)
  record.updatedAt = new Date().toISOString()
  await writeIdentities(identities)
  return { ok: true }
}

export async function removeLink(name: string, link: SenderKey): Promise<{ ok: boolean }> {
  const parsed = parseSenderKey(link)
  const identities = await listIdentities()
  const record = identities[name]
  if (!record) {
    return { ok: false }
  }

  const before = record.channels[parsed.channel].length
  record.channels[parsed.channel] = record.channels[parsed.channel]
    .filter(peerId => peerId !== parsed.peerId)
  record.updatedAt = new Date().toISOString()
  await writeIdentities(identities)
  return { ok: record.channels[parsed.channel].length !== before }
}

export async function removeUser(
  name: string,
  opts?: { purge?: boolean },
): Promise<{ ok: boolean }> {
  const identities = await listIdentities()
  if (!identities[name]) {
    return { ok: false }
  }

  delete identities[name]
  await writeIdentities(identities)
  if (opts?.purge) {
    await purgeUserData(name)
  }
  return { ok: true }
}

export async function rebuildReverseIndex(): Promise<void> {
  const identities = await listIdentities()
  const next = new Map<SenderKey, string>()
  for (const [name, record] of Object.entries(identities)) {
    for (const channel of Object.keys(record.channels) as ChannelKind[]) {
      for (const peerId of record.channels[channel]) {
        next.set(`${channel}:${peerId}`, name)
      }
    }
  }
  cachedReverseIndex = next
}

export function lookupBySender(link: SenderKey): string | null {
  return cachedReverseIndex?.get(link) ?? null
}

export async function listAdmins(): Promise<string[]> {
  const admin = await readJson<AdminFile>(adminPath(), { admins: [] })
  return admin.admins
}

/** The primary (bootstrap) admin — `admins[0]`. This is the single user that
 *  `runtime.backend = "local"` serves: local is single-user regardless of how
 *  many admins exist, so the LocalRuntime gate and the wizard's "is an admin
 *  set" check key off this, NOT off the full admin list. Multi-admin only
 *  takes effect on the sandboxed backends (docker / rlaunch). */
export async function getAdmin(): Promise<string | null> {
  const admins = await listAdmins()
  return admins[0] ?? null
}

/** Feishu open_ids for ALL admins (skipping any without a Feishu binding).
 *  Pairing / approval cards fan out across this list so any admin can approve;
 *  first to act wins and the rest see the resolved-elsewhere card on click. */
export async function getAdminFeishuOpenIds(): Promise<string[]> {
  const admins = await listAdmins()
  if (admins.length === 0) {
    return []
  }
  const identities = await listIdentities()
  const openIds: string[] = []
  for (const name of admins) {
    const openId = identities[name]?.channels.feishu[0]
    if (openId) {
      openIds.push(openId)
    }
  }
  return openIds
}

/** The primary admin's Feishu open_id, or null. Kept for the few callers that
 *  genuinely want a single representative target rather than a fan-out. */
export async function getAdminFeishuOpenId(): Promise<string | null> {
  const adminName = await getAdmin()
  if (!adminName) {
    return null
  }
  const identities = await listIdentities()
  const bindings = identities[adminName]?.channels.feishu ?? []
  return bindings[0] ?? null
}

export async function getFeishuOpenIdForUser(canonical: string): Promise<string | null> {
  const identities = await listIdentities()
  const bindings = identities[canonical]?.channels.feishu ?? []
  return bindings[0] ?? null
}

/** Bootstrap setter: makes `name` the sole admin. Used by the init wizard for
 *  the very first admin; admin management afterwards goes through
 *  `addAdmin` / `removeAdmin`. */
export async function setAdmin(name: string): Promise<void> {
  if (!isValidIdentityName(name)) {
    throw new Error(`Invalid identity name: ${name}`)
  }
  await writeJsonSecure(adminPath(), { admins: [name] } satisfies AdminFile)
}

/** Append `name` to the admin list (idempotent). The caller is responsible for
 *  having verified `name` is an existing paired identity. */
export async function addAdmin(name: string): Promise<void> {
  if (!isValidIdentityName(name)) {
    throw new Error(`Invalid identity name: ${name}`)
  }
  const admins = await listAdmins()
  if (admins.includes(name)) {
    return
  }
  await writeJsonSecure(adminPath(), { admins: [...admins, name] } satisfies AdminFile)
}

export type RemoveAdminResult = { ok: true } | { ok: false; reason: 'not-admin' | 'last-admin' }

/** Remove `name` from the admin list, refusing to remove the last admin so the
 *  deployment never ends up with nobody who can manage it. */
export async function removeAdmin(name: string): Promise<RemoveAdminResult> {
  const admins = await listAdmins()
  if (!admins.includes(name)) {
    return { ok: false, reason: 'not-admin' }
  }
  if (admins.length <= 1) {
    return { ok: false, reason: 'last-admin' }
  }
  await writeJsonSecure(adminPath(), { admins: admins.filter(a => a !== name) } satisfies AdminFile)
  return { ok: true }
}

export async function isAdmin(name: string): Promise<boolean> {
  return (await listAdmins()).includes(name)
}

export function parseSenderKey(link: string): { channel: ChannelKind; peerId: string } {
  const separator = link.indexOf(':')
  if (separator < 1) {
    throw new Error(`Invalid sender key: ${link}`)
  }
  const channel = link.slice(0, separator)
  const peerId = link.slice(separator + 1)
  if (!isChannelKind(channel) || peerId.length === 0) {
    throw new Error(`Invalid sender key: ${link}`)
  }
  return { channel, peerId }
}

async function writeIdentities(identities: IdentitiesFile): Promise<void> {
  await writeJsonSecure(identitiesPath(), identities)
  await rebuildReverseIndex()
}

async function purgeUserData(name: string): Promise<void> {
  // Compute the user's memory dir via the same helper the runtime uses, so
  // we never drift from getMemoryDir's keying. (Pre-fix code hardcoded
  // ~/.lightclaw/memory/<name> and silently no-op'd because the actual dir
  // had a path-resolved cwd suffix in front.)
  await rm(getMemoryDir(name), { recursive: true, force: true })

  // Sessions now live under the per-user root (`users/<u>/sessions/...`), so
  // the whole subtree is the user's — no flat-dir enumeration or per-session
  // userId matching is needed anymore.
  await rm(userSessionsRoot(name), { recursive: true, force: true })
}

async function chmodBestEffort(filePath: string, mode: number): Promise<void> {
  try {
    await chmod(filePath, mode)
  } catch {
    // Some filesystems ignore chmod; JSON content is still written.
  }
}

function isChannelKind(input: string): input is ChannelKind {
  return input === 'feishu' || input === 'terminal'
}
