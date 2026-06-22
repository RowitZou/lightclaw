import {
  accessSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { constants } from 'node:fs'
import path from 'node:path'
import { request, type Dispatcher } from 'undici'

import { userStateRoot } from '../../identity/paths.js'
import { buildProxyDispatcher } from '../../provider/proxy.js'
import { AuthError, type AuthCredentials } from '../types.js'
import { codexCliAuthFilePath, CODEX_REFRESH_SKEW_SECONDS } from './constants.js'
import {
  loadCodexCliTokens,
  refreshCodexTokens,
  type HttpFn,
  type StoredCodexTokens,
} from './provider.js'
import { extractAccountIdFromTokens } from './jwt.js'

/**
 * Per-user BYO Codex (ChatGPT OAuth) credential store (PR5 checkpoint 2). A
 * user imports their own `codex login` `auth.json` into a per-user store, then
 * references it from a BYO `openai-auth` endpoint via `authRef: codex:<name>`.
 * Tokens resolve + refresh from the user's OWN store, never the admin global
 * `<home>/auth/codex.json`.
 *
 * On-disk layout: `userStateRoot(canonical)/auth/codex/<name>.json` (0700 dir /
 * 0600 file — these are live OAuth tokens, never world-readable). This module
 * REUSES the global codex refresh transport / token URL / JWT decode and the
 * CLI-import `expires_at`-from-JWT derivation by importing the exported
 * primitives from `./provider.js`; the per-user path can therefore never drift
 * from the global one.
 */

const AUTH_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

export type UserCodexAuthSummary = {
  name: string
  accountId: string
  expiresAt: number
  importedAt?: string
  lastRefresh?: string
  source: string
}

export function normalizeCodexAuthName(name: string | undefined): string {
  const trimmed = (name ?? 'default').trim()
  if (!AUTH_NAME_RE.test(trimmed)) {
    throw new Error('Codex auth name must match /^[A-Za-z0-9_-]{1,64}$/.')
  }
  return trimmed
}

export function parseCodexAuthRef(authRef: string): string {
  const match = /^codex:([A-Za-z0-9_-]{1,64})$/.exec(authRef.trim())
  if (!match) {
    throw new Error('authRef must look like codex:<name>, for example codex:default.')
  }
  return normalizeCodexAuthName(match[1])
}

export function userCodexAuthDir(canonicalUser: string): string {
  return path.join(userStateRoot(canonicalUser), 'auth', 'codex')
}

export function userCodexAuthPath(canonicalUser: string, rawName = 'default'): string {
  return path.join(userCodexAuthDir(canonicalUser), `${normalizeCodexAuthName(rawName)}.json`)
}

export function listUserCodexAuth(canonicalUser: string): UserCodexAuthSummary[] {
  const dir = userCodexAuthDir(canonicalUser)
  if (!existsSync(dir)) return []
  const out: UserCodexAuthSummary[] = []
  for (const name of readdirJsonBasenames(dir)) {
    const store = readUserCodexAuth(canonicalUser, name)
    if (!store) continue
    out.push(toSummary(name, store))
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function readUserCodexAuth(
  canonicalUser: string,
  rawName = 'default',
): StoredCodexTokens | null {
  const file = userCodexAuthPath(canonicalUser, rawName)
  if (!existsSync(file)) return null
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as StoredCodexTokens
  validateStored(parsed, `codex:${normalizeCodexAuthName(rawName)}`)
  return parsed
}

export function importUserCodexAuth(input: {
  canonicalUser: string
  name?: string
  fromPath?: string
}): UserCodexAuthSummary {
  const name = normalizeCodexAuthName(input.name)
  const source = input.fromPath ? path.resolve(input.fromPath) : codexCliAuthFilePath()
  ensureReadableFile(source)
  // loadCodexCliTokens parses + validates the CLI file and derives expires_at
  // from the access_token JWT `exp` claim (the CLI file has no explicit
  // expires_at); it does NOT write — we persist into the per-user store here.
  const stored = loadCodexCliTokens(source)
  writeUserCodexAuth(input.canonicalUser, name, {
    ...stored,
    source: 'codex-cli-import',
  })
  return toSummary(name, stored)
}

export function deleteUserCodexAuth(canonicalUser: string, rawName = 'default'): boolean {
  const file = userCodexAuthPath(canonicalUser, rawName)
  if (!existsSync(file)) return false
  rmSync(file, { force: true })
  return true
}

export async function refreshUserCodexAuth(input: {
  canonicalUser: string
  name?: string
  proxy?: string
}): Promise<UserCodexAuthSummary> {
  const name = normalizeCodexAuthName(input.name)
  const credentials = await getUserCodexCredentials({
    canonicalUser: input.canonicalUser,
    name,
    proxy: input.proxy,
    forceRefresh: true,
  })
  return {
    name,
    accountId: credentials.accountId,
    expiresAt: credentials.expiresAt,
    lastRefresh: new Date().toISOString(),
    source: 'lightclaw-refresh',
  }
}

export async function getUserCodexCredentials(input: {
  canonicalUser: string
  name?: string
  proxy?: string
  forceRefresh?: boolean
}): Promise<AuthCredentials> {
  const name = normalizeCodexAuthName(input.name)
  const providerName = `codex:${name}`
  const stored = readUserCodexAuth(input.canonicalUser, name)
  if (!stored) {
    throw new AuthError({
      code: 'auth_missing',
      provider: providerName,
      message:
        `No Codex credentials stored for this user authRef (${providerName}). ` +
        `Run /config codex import --from <path> --name ${name}.`,
    })
  }
  const expiring = Date.now() + CODEX_REFRESH_SKEW_SECONDS * 1000 >= stored.tokens.expires_at
  if (!input.forceRefresh && !expiring) {
    return {
      accessToken: stored.tokens.access_token,
      expiresAt: stored.tokens.expires_at,
      accountId: stored.account_id,
    }
  }

  const refreshed = await refreshCodexTokens(buildHttp(input.proxy), stored.tokens.refresh_token)
  const accountId =
    extractAccountIdFromTokens({
      id_token: refreshed.id_token,
      access_token: refreshed.access_token,
    }) || stored.account_id
  const next: StoredCodexTokens = {
    tokens: {
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      expires_at: Date.now() + refreshed.expires_in * 1000,
      ...(refreshed.id_token ? { id_token: refreshed.id_token } : {}),
    },
    account_id: accountId,
    ...(stored.imported_at ? { imported_at: stored.imported_at } : {}),
    last_refresh: new Date().toISOString(),
    source: 'lightclaw-refresh',
  }
  writeUserCodexAuth(input.canonicalUser, name, next)
  return {
    accessToken: next.tokens.access_token,
    expiresAt: next.tokens.expires_at,
    accountId: next.account_id,
  }
}

function writeUserCodexAuth(
  canonicalUser: string,
  rawName: string,
  payload: StoredCodexTokens,
): void {
  const name = normalizeCodexAuthName(rawName)
  validateStored(payload, `codex:${name}`)
  const dir = userCodexAuthDir(canonicalUser)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const target = path.join(dir, `${name}.json`)
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, target)
  chmodBestEffort(target, 0o600)
}

function validateStored(value: StoredCodexTokens, provider: string): void {
  if (
    !value ||
    typeof value !== 'object' ||
    !value.tokens ||
    typeof value.tokens.access_token !== 'string' ||
    typeof value.tokens.refresh_token !== 'string' ||
    typeof value.tokens.expires_at !== 'number'
  ) {
    throw new AuthError({
      code: 'tokens_invalid_shape',
      provider,
      message: `Codex auth store ${provider} is missing access_token, refresh_token, or expires_at.`,
    })
  }
}

function toSummary(name: string, stored: StoredCodexTokens): UserCodexAuthSummary {
  return {
    name,
    accountId: stored.account_id,
    expiresAt: stored.tokens.expires_at,
    ...(stored.imported_at ? { importedAt: stored.imported_at } : {}),
    ...(stored.last_refresh ? { lastRefresh: stored.last_refresh } : {}),
    source: stored.source,
  }
}

function ensureReadableFile(filePath: string): void {
  const stat = statSync(filePath)
  if (!stat.isFile()) {
    throw new Error(`${filePath} is not a file.`)
  }
  accessSync(filePath, constants.R_OK)
}

function readdirJsonBasenames(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => entry.name.slice(0, -'.json'.length))
    .filter(name => AUTH_NAME_RE.test(name))
}

function buildHttp(proxy: string | undefined): HttpFn {
  const dispatcher = buildProxyDispatcher(proxy)
  return async ({ url, body, headers }) => {
    const res = await request(url, {
      method: 'POST',
      body,
      headers,
      ...(dispatcher ? { dispatcher: dispatcher as Dispatcher } : {}),
    })
    const bodyText = await res.body.text()
    return { statusCode: res.statusCode, bodyText }
  }
}

function chmodBestEffort(filePath: string, mode: number): void {
  try {
    chmodSync(filePath, mode)
  } catch {
    // Some filesystems ignore chmod.
  }
}
