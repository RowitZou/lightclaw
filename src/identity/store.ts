import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { resolveSessionsDir } from '../config.js'
import { getSessionDir, loadMeta } from '../session/storage.js'
import { adminPath, identitiesPath, identityRoot } from './paths.js'
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
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return fallback
    }
    return fallback
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
  identities[name] = {
    createdAt: now,
    updatedAt: now,
    channels: {
      feishu: [],
      wechat: [],
      terminal: [],
    },
  }
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

export async function getAdmin(): Promise<string | null> {
  const admin = await readJson<AdminFile>(adminPath(), { admins: [] })
  if (admin.admins.length > 1) {
    throw new Error('LightClaw v1 supports exactly one admin.')
  }
  return admin.admins[0] ?? null
}

export async function setAdmin(name: string): Promise<void> {
  if (!isValidIdentityName(name)) {
    throw new Error(`Invalid identity name: ${name}`)
  }
  await writeJsonSecure(adminPath(), { admins: [name] } satisfies AdminFile)
}

export async function isAdmin(name: string): Promise<boolean> {
  return (await getAdmin()) === name
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
  await rm(path.join(identityRoot(), '..', 'memory', name), {
    recursive: true,
    force: true,
  })
  try {
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(resolveSessionsDir(), { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }
      const meta = await loadMeta(entry.name)
      if (meta?.userId === name || entry.name === `feishu-${name}` || entry.name === `wechat-${name}`) {
        await rm(getSessionDir(entry.name), { recursive: true, force: true })
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
}

async function chmodBestEffort(filePath: string, mode: number): Promise<void> {
  try {
    const { chmod } = await import('node:fs/promises')
    await chmod(filePath, mode)
  } catch {
    // Some filesystems ignore chmod; JSON content is still written.
  }
}

function isChannelKind(input: string): input is ChannelKind {
  return input === 'feishu' || input === 'wechat' || input === 'terminal'
}

