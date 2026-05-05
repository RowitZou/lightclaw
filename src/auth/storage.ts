import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

import { lightclawHome } from '../paths.js'

// Atomic on-disk storage for auth provider tokens. Mirrors the existing
// LightClaw pattern (per-identity preferences, sessionMeta) — `.tmp` write
// + rename, mode 0600 on the file, 0700 on the parent directory.
//
// No file lock: process-lock.ts already enforces single LightClaw process
// per <lightclawHome>, so multi-process refresh races inside LightClaw
// cannot happen. Cross-tool races (with the official codex CLI / VS Code
// extension) are detected at the OAuth layer via `invalid_grant` errors,
// not prevented at the FS layer.

function authDir(): string {
  return path.join(lightclawHome(), 'auth')
}

function tokenFilePath(provider: string): string {
  return path.join(authDir(), `${provider}.json`)
}

function ensureAuthDir(): void {
  const dir = authDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
}

/** Read raw JSON for a provider's token store. Returns `null` when the
 *  file is missing. Throws on JSON parse failure (corrupt file is the
 *  caller's problem to escalate). */
export function readTokenFile(provider: string): unknown | null {
  const file = tokenFilePath(provider)
  if (!existsSync(file)) {
    return null
  }
  const raw = readFileSync(file, 'utf8')
  return JSON.parse(raw)
}

/** Atomically write JSON to a provider's token store. Creates `<home>/auth/`
 *  if needed (mode 0700) and writes the file with mode 0600. */
export function writeTokenFile(provider: string, payload: unknown): void {
  ensureAuthDir()
  const target = tokenFilePath(provider)
  const tmp = `${target}.tmp.${process.pid}`
  writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 })
  try {
    renameSync(tmp, target)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // best-effort cleanup
    }
    throw err
  }
}

/** Delete a provider's token store. Idempotent — missing file is a no-op. */
export function deleteTokenFile(provider: string): void {
  const file = tokenFilePath(provider)
  if (!existsSync(file)) {
    return
  }
  unlinkSync(file)
}

/** Test-only: explicit accessor for the file path so tests can assert on
 *  layout without re-implementing the join. */
export function _tokenFilePathForTests(provider: string): string {
  return tokenFilePath(provider)
}

/** Test-only: the auth directory path. */
export function _authDirForTests(): string {
  return authDir()
}
