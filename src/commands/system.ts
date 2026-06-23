import { existsSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { LightClawConfig } from '../config.js'
import { loadUserConfigOverride } from '../config/user-override.js'
import { t } from '../i18n/index.js'
import { expandHomePath } from '../paths.js'
import { exportUserData, importUserData } from '../system-data/archive.js'

import { requireConfirm } from './confirm.js'
import { runMountCommand } from './mount.js'
import { runSecretCommand } from './secret.js'

/**
 * Context for the `/system` hub. It is the union of what the delegated
 * runners need: `key` → secret runner (userId only), `mount` → mount runner
 * (config + userId + the rlaunch restart hook the channel passes through).
 */
type SystemCommandContext = {
  config: LightClawConfig
  userId?: string
}

type SystemCommandDeps = {
  restartRlaunch?: () => Promise<string>
}

/**
 * `/system <noun> [verb] [args]` — the runtime-resource operation hub
 * (PR5.9 checkpoint B1). It additively absorbs `/secret` (noun `key`) and
 * `/mount` (noun `mount`) by stripping the noun token and delegating the
 * remaining arg string to the existing runners — same return shape, no
 * behavior change. `data` (import/export) is registered as a grammar stub
 * here; its real logic is owned by PR7.
 *
 * `/secret` and `/mount` stay registered in parallel (retired in B6), so
 * this is a strict superset surface, not a replacement.
 */
export async function runSystemCommand(
  rawArgs: string,
  ctx: SystemCommandContext,
  deps: SystemCommandDeps = {},
): Promise<string> {
  const trimmed = rawArgs.trim()
  const firstSpace = trimmed.search(/\s/)
  const noun = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase()
  const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim()

  switch (noun) {
    case 'key':
      // The secret runner already accepts bare/list/status (read) and
      // set/enable/disable/rm|remove (write); pass through verbatim — except
      // `rm <NAME>`, which is --y-gated ONLY when the key is referenced by some
      // endpoint (design F.3b: unreferenced keys delete directly).
      return runKeyNoun(rest, ctx)
    case 'mount':
      // The mount runner already accepts bare/list (read) and add/rm|remove
      // (write); pass through verbatim plus the restart hook.
      return runMountCommand(rest, { config: ctx.config, userId: ctx.userId }, deps)
    case 'data':
      return runDataNoun(rest, ctx)
    default:
      // Empty or unknown noun → the /system overview (nouns + verb hints).
      return `${t('system.usage')}\n`
  }
}

/**
 * `key` noun. Delegates to the shared secret runner, but interposes a --y gate
 * on `rm <NAME>` when the key is referenced by one of the user's BYO endpoints
 * (apiKeyRef). An unreferenced key deletes directly (no --y) — there is nothing
 * to cascade. A referenced key without --y returns a preview listing the
 * dependent endpoint(s) and performs no delete.
 */
async function runKeyNoun(rest: string, ctx: SystemCommandContext): Promise<string> {
  const parts = rest.split(/\s+/).filter(Boolean)
  const verb = (parts[0] ?? '').toLowerCase()
  if ((verb === 'rm' || verb === 'remove') && parts[1] && ctx.userId) {
    const name = parts[1]
    const dependents = endpointsReferencingKey(ctx.userId, name)
    if (dependents.length > 0) {
      const gate = requireConfirm(parts, {
        preview: t('confirm.key.rm', { name, endpoints: dependents.join(', ') }),
      })
      if (!gate.confirmed) return gate.message
      // Strip --y, then hand the cleaned arg string to the secret runner.
      return runSecretCommand(gate.rest.join(' '), { userId: ctx.userId })
    }
  }
  return runSecretCommand(rest, { userId: ctx.userId })
}

/** The user's BYO endpoint aliases whose `apiKeyRef` points at `name`. */
function endpointsReferencingKey(userId: string, name: string): string[] {
  const override = loadUserConfigOverride(userId)
  return Object.entries(override.endpoints ?? {})
    .filter(([, ep]) => ep.apiKeyRef === name)
    .map(([alias]) => alias)
}

/**
 * `data` noun — per-user backup / restore of the CALLER's own `users/<canonical>/`
 * subtree (memory / skills / mounts / per-user settings; sessions opt-in). It is
 * available to every paired user, not admin-only. Secrets are never exported and
 * `config.json` is never imported (see `src/system-data/manifest.ts`).
 *
 *   /system data export --path <file|dir> [--with-sessions]
 *   /system data import --path <file> [--replace] [--y]
 *
 * The `--feishu` transport (send/receive the zip as a Feishu file message) needs
 * the channel sender + inbound attachment threaded into this command and is wired
 * separately; for now it returns a use-`--path` notice.
 */
async function runDataNoun(rest: string, ctx: SystemCommandContext): Promise<string> {
  const parts = rest.split(/\s+/).filter(Boolean)
  const verb = (parts[0] ?? '').toLowerCase()
  if (verb !== 'export' && verb !== 'import') {
    return `${t('system.data.usage')}\n`
  }
  if (!ctx.userId) {
    return `${t('system.data.noIdentity')}\n`
  }
  const flags = parseDataFlags(parts.slice(1))
  if (flags.feishu) {
    return `${t('system.data.feishuPending')}\n`
  }
  if (!flags.path) {
    return `${t('system.data.missingPath')}\n`
  }
  const resolvedPath = path.resolve(expandHomePath(flags.path))

  if (verb === 'export') {
    return runDataExport(ctx.userId, resolvedPath, flags.withSessions)
  }
  return runDataImport(ctx.userId, resolvedPath, flags, parts)
}

interface DataFlags {
  path?: string
  feishu: boolean
  withSessions: boolean
  replace: boolean
}

function parseDataFlags(tokens: string[]): DataFlags {
  const flags: DataFlags = { feishu: false, withSessions: false, replace: false }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token === '--path') {
      flags.path = tokens[++i]
    } else if (token === '--feishu') {
      flags.feishu = true
    } else if (token === '--with-sessions') {
      flags.withSessions = true
    } else if (token === '--replace') {
      flags.replace = true
    } else if (token !== '--y' && !flags.path && !token.startsWith('--')) {
      // Bare positional path (e.g. `export ~/backup.zip`) is accepted as --path.
      flags.path = token
    }
  }
  return flags
}

async function runDataExport(
  userId: string,
  dest: string,
  withSessions: boolean,
): Promise<string> {
  let result
  try {
    result = await exportUserData(userId, {
      withSessions,
      createdAt: new Date().toISOString(),
    })
  } catch (err) {
    return `${t('system.data.error', { error: err instanceof Error ? err.message : String(err) })}\n`
  }
  if (result.componentsPacked.length === 0) {
    return `${t('system.data.exportEmpty')}\n`
  }

  // A directory destination gets a generated filename; a file path is used as-is.
  let target = dest
  if (existsSync(dest) && statSync(dest).isDirectory()) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    target = path.join(dest, `lightclaw-data-${userId}-${stamp}.zip`)
  }
  try {
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, result.buffer)
  } catch (err) {
    return `${t('system.data.error', { error: err instanceof Error ? err.message : String(err) })}\n`
  }

  const lines = [
    t('system.data.exportOk', {
      components: result.componentsPacked.join(', '),
      dest: target,
      kb: String(Math.max(1, Math.round(result.buffer.length / 1024))),
    }),
    t('system.data.secretsNote'),
  ]
  return `${lines.join('\n')}\n`
}

async function runDataImport(
  userId: string,
  src: string,
  flags: DataFlags,
  parts: string[],
): Promise<string> {
  if (!existsSync(src)) {
    return `${t('system.data.notFound', { path: src })}\n`
  }
  const gate = requireConfirm(parts, {
    preview: t('confirm.data.import', { src, mode: flags.replace ? 'replace' : 'merge' }),
  })
  if (!gate.confirmed) return gate.message

  let buffer: Buffer
  try {
    buffer = await readFile(src)
  } catch (err) {
    return `${t('system.data.error', { error: err instanceof Error ? err.message : String(err) })}\n`
  }
  let result
  try {
    result = await importUserData(userId, buffer, { replace: flags.replace })
  } catch (err) {
    return `${t('system.data.error', { error: err instanceof Error ? err.message : String(err) })}\n`
  }

  const lines = [
    t('system.data.importOk', {
      applied: result.applied.length > 0 ? result.applied.join(', ') : '—',
    }),
  ]
  if (result.skipped.includes('config')) {
    lines.push(t('system.data.configSkipped'))
  }
  for (const warning of result.warnings) {
    lines.push(t('system.data.warning', { warning }))
  }
  return `${lines.join('\n')}\n`
}
