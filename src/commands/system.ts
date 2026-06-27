import { existsSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { LightClawConfig } from '../config.js'
import { loadUserConfigOverride } from '../config/user-override.js'
import { t } from '../i18n/index.js'
import { expandHomePath } from '../paths.js'
import { getChannelFileSender, getRuntimeIfInitialized } from '../state.js'
import { exportUserData, importUserData, type ImportResult } from '../system-data/archive.js'

import { loadUserRlaunchMounts } from '../runtime/rlaunch-mounts.js'
import { listUserSecretMetadata } from '../secrets/store.js'

import { commandList } from './card-format.js'
import {
  formatCommandListSpecAsText,
  systemDataCardSpec,
  systemKeyCardSpec,
  systemMountCardSpec,
  type KeyShowRow,
  type MountShowRow,
} from './card-specs.js'
import { requireConfirm } from './confirm.js'
import { runMountCommand } from './mount.js'
import type { MountRebuildResult } from './mount-ops.js'
import type { CommandListCardSpec } from './registry.js'
import { runSecretCommand } from './secret.js'

/**
 * Context for the `/system` hub. It is the union of what the delegated
 * runners need: `key` → secret runner (userId only), `mount` → mount runner
 * (config + userId + the rlaunch restart hook the channel passes through),
 * `data` → export/import (userId + the inbound `attachmentPaths` that
 * `import --feishu` ingests).
 */
type SystemCommandContext = {
  config: LightClawConfig
  userId?: string
  attachmentPaths?: string[]
  // Channel-only: lets the bare `/system` overview render as the structured
  // column_set command-list card. Absent on terminal / minimal callers, where
  // the plain-text fallback applies.
  setCommandListCard?: (spec: CommandListCardSpec) => void
}

// The `/system` noun list (L1 card). Left = the command, right = an i18n
// description key; rendered as the per-row column_set card on the channel.
const SYSTEM_NOUNS: ReadonlyArray<readonly [string, string]> = [
  ['/system key', 'system.list.key'],
  ['/system mount', 'system.list.mount'],
  ['/system data', 'system.list.data'],
]

function systemNounRows(): Array<readonly [string, string]> {
  return SYSTEM_NOUNS.map(([cmd, key]) => [cmd, t(key as 'system.list.key')] as const)
}

/** Structured `/system` overview for the channel column_set card. */
export function systemListSpec(): CommandListCardSpec {
  return {
    title: t('card.cmdHelp.title', { cmd: '/system' }),
    sections: [{ rows: systemNounRows() }],
    footer: t('system.list.footer'),
  }
}

/** Plain-text `/system` overview — terminal fallback. */
function formatSystemUsageCard(): string {
  return `${commandList(systemNounRows())}\n\n${t('system.list.footer')}`
}

type SystemCommandDeps = {
  restartRlaunch?: () => Promise<MountRebuildResult>
}

/**
 * `/system <noun> [verb] [args]` — the runtime-resource operation hub
 * (PR5.9 checkpoint B1). It additively absorbs `/system key` (noun `key`) and
 * `/system mount` (noun `mount`) by stripping the noun token and delegating the
 * remaining arg string to the existing runners — same return shape, no
 * behavior change. `data` (import/export) is registered as a grammar stub
 * here; its real logic is owned by PR7.
 *
 * `/system key` and `/system mount` stay registered in parallel (retired in B6), so
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
    case 'mount': {
      // Structured card from the live mount table = the show output AND the
      // usage reference. The mount runner (mount.js) owns add/rm and returns
      // null on any usage fallback, which we map to the card.
      const mountCard = (): string => {
        const rows: MountShowRow[] = ctx.userId
          ? loadUserRlaunchMounts(ctx.userId).map(m => ({
              path: m.path,
              mode: m.mode,
              ...(m.scope === 'worker-only' ? { scope: m.scope } : {}),
            }))
          : []
        const spec = systemMountCardSpec(rows)
        ctx.setCommandListCard?.(spec)
        return formatCommandListSpecAsText(spec)
      }
      const mountVerb = rest.split(/\s+/).filter(Boolean)[0]?.toLowerCase() ?? ''
      if (mountVerb === '' || mountVerb === 'list') {
        return mountCard()
      }
      return (await runMountCommand(rest, { config: ctx.config, userId: ctx.userId }, deps)) ?? mountCard()
    }
    case 'data':
      return runDataNoun(rest, ctx)
    default:
      // Empty or unknown noun → the /system overview (noun list card).
      ctx.setCommandListCard?.(systemListSpec())
      return `${formatSystemUsageCard()}\n`
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
  // Structured card from the live secret store = the show output AND the usage
  // reference (saved keys + set/enable/disable/rm 子命令 + 示例). The secret
  // runner returns null on any usage fallback (help / malformed verb), which we
  // map to this card so terminal + channel match.
  const keyCard = (): string => {
    const rows: KeyShowRow[] = ctx.userId
      ? listUserSecretMetadata(ctx.userId).map(m => ({ name: m.name, enabled: m.enabled }))
      : []
    const spec = systemKeyCardSpec(rows)
    ctx.setCommandListCard?.(spec)
    return formatCommandListSpecAsText(spec)
  }
  if (verb === '' || verb === 'list') {
    return keyCard()
  }
  if ((verb === 'rm' || verb === 'remove') && parts[1] && ctx.userId) {
    const name = parts[1]
    const dependents = endpointsReferencingKey(ctx.userId, name)
    if (dependents.length > 0) {
      const gate = requireConfirm(parts, {
        preview: t('confirm.key.rm', { name, endpoints: dependents.join(', ') }),
      })
      if (!gate.confirmed) return gate.message
      // Strip --y, then hand the cleaned arg string to the secret runner.
      return (await runSecretCommand(gate.rest.join(' '), { userId: ctx.userId })) ?? keyCard()
    }
  }
  return (await runSecretCommand(rest, { userId: ctx.userId })) ?? keyCard()
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
 * subtree (memory / skills / per-user settings; sessions opt-in). It is
 * available to every paired user, not admin-only. Secrets and deployment
 * bindings (rlaunch mounts / feishu workspace) are never exported, and
 * `config.json` is never imported (see `src/system-data/manifest.ts`).
 *
 *   /system data export --path <file|dir> | --feishu  [--with-sessions]
 *   /system data import --path <file> | --feishu       [--replace] [--y]
 *
 * `--path` reads/writes a filesystem path; `--feishu` reuses the channel file
 * sender (export → sends the zip to the chat, size-routed IM ≤20MB vs cloud
 * link) and the inbound attachment (import → reads the .zip the user sent /
 * replied with, via the active runtime).
 */
async function runDataNoun(rest: string, ctx: SystemCommandContext): Promise<string> {
  const parts = rest.split(/\s+/).filter(Boolean)
  const verb = (parts[0] ?? '').toLowerCase()
  if (verb !== 'export' && verb !== 'import') {
    // Bare/unknown verb = the /system data overview → pure-operation card
    // (no show-段: data has no listable state).
    const spec = systemDataCardSpec()
    ctx.setCommandListCard?.(spec)
    return formatCommandListSpecAsText(spec)
  }
  if (!ctx.userId) {
    return `${t('system.data.noIdentity')}\n`
  }
  const flags = parseDataFlags(parts.slice(1))

  if (verb === 'export') {
    if (flags.feishu) return runDataExportFeishu(ctx.userId, flags.withSessions)
    if (!flags.path) return `${t('system.data.missingPath')}\n`
    return runDataExport(ctx.userId, path.resolve(expandHomePath(flags.path)), flags.withSessions)
  }
  // import
  if (flags.feishu) {
    return runDataImportFeishu(ctx.userId, ctx.attachmentPaths ?? [], flags, parts)
  }
  if (!flags.path) return `${t('system.data.missingPath')}\n`
  return runDataImport(ctx.userId, path.resolve(expandHomePath(flags.path)), flags, parts)
}

function errorLine(err: unknown): string {
  return `${t('system.data.error', { error: err instanceof Error ? err.message : String(err) })}\n`
}

/** Shared render for an import outcome (applied components + config-skip + warnings). */
function formatImportResult(result: ImportResult): string {
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

/** Export the caller's subtree and send the zip to the current chat (size-routed). */
async function runDataExportFeishu(userId: string, withSessions: boolean): Promise<string> {
  const sender = getChannelFileSender()
  if (!sender) {
    return `${t('system.data.feishuNoSender')}\n`
  }
  let result
  try {
    result = await exportUserData(userId, { withSessions, createdAt: new Date().toISOString() })
  } catch (err) {
    return errorLine(err)
  }
  if (result.componentsPacked.length === 0) {
    return `${t('system.data.exportEmpty')}\n`
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const name = `lightclaw-data-${userId}-${stamp}.zip`
  let sent
  try {
    sent = await sender.sendFile({
      name,
      sizeBytes: result.buffer.byteLength,
      read: async () => result.buffer,
    })
  } catch (err) {
    return errorLine(err)
  }
  const components = result.componentsPacked.join(', ')
  const head =
    sent.kind === 'cloud-link'
      ? t('system.data.feishuExportCloud', { components, url: sent.url })
      : t('system.data.feishuExportIm', { components })
  return `${head}\n${t('system.data.secretsNote')}\n`
}

/** Import the .zip the user attached / replied with, read via the active runtime. */
async function runDataImportFeishu(
  userId: string,
  attachmentPaths: string[],
  flags: DataFlags,
  parts: string[],
): Promise<string> {
  const zipPath = attachmentPaths.find(p => p.toLowerCase().endsWith('.zip'))
  if (!zipPath) {
    return `${t('system.data.feishuNoAttachment')}\n`
  }
  const runtime = getRuntimeIfInitialized()
  if (!runtime) {
    return `${t('system.data.feishuNoSender')}\n`
  }
  const gate = requireConfirm(parts, {
    preview: t('confirm.data.import', {
      src: path.basename(zipPath),
      mode: flags.replace ? 'replace' : 'merge',
    }),
  })
  if (!gate.confirmed) return gate.message

  let buffer: Buffer
  try {
    buffer = await runtime.fs.readFile(zipPath)
  } catch (err) {
    return errorLine(err)
  }
  let result: ImportResult
  try {
    result = await importUserData(userId, buffer, { replace: flags.replace })
  } catch (err) {
    return errorLine(err)
  }
  return formatImportResult(result)
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
    return errorLine(err)
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
    return errorLine(err)
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
    return errorLine(err)
  }
  let result: ImportResult
  try {
    result = await importUserData(userId, buffer, { replace: flags.replace })
  } catch (err) {
    return errorLine(err)
  }
  return formatImportResult(result)
}
