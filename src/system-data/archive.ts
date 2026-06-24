import { existsSync, type Dirent } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import AdmZip from 'adm-zip'

import { userMemoryRoot } from '../identity/paths.js'
import { rebuildMemoryIndex } from '../memory/auto-memory.js'
import { VERSION } from '../version.js'

import {
  COMPONENTS,
  entryBelongsToComponent,
  SYSTEM_DATA_FORMAT,
  SYSTEM_DATA_VERSION,
  type ComponentDef,
  type ComponentId,
  type SystemDataManifest,
} from './manifest.js'

/** Zip-bomb backstop for import. adm-zip has no streaming reader, so every entry
 *  is decompressed into memory; a tiny hostile archive could otherwise expand to
 *  GBs and OOM the daemon. This is a safety ceiling, not a per-user quota —
 *  legitimate memory/skills/preferences are tiny and even `--with-sessions`
 *  transcripts stay well under it. */
const MAX_IMPORT_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024 // 1 GiB

export interface ExportOptions {
  withSessions?: boolean
  /** Modules cannot read the clock — the command layer stamps this. */
  createdAt?: string
}

export interface ExportResult {
  buffer: Buffer
  manifest: SystemDataManifest
  /** Components that had on-disk data and made it into the archive. */
  componentsPacked: ComponentId[]
}

export interface ImportOptions {
  /** `false`/absent => merge (union, archive overwrites on collision, target-only
   *  files kept). `true` => replace each present directory component exactly
   *  (rm the target subtree first), scoped only to components the archive carries. */
  replace?: boolean
}

export interface ImportResult {
  manifest: SystemDataManifest
  /** Components actually written to the caller's subtree. */
  applied: ComponentId[]
  /** Components present in the archive but intentionally not written (config). */
  skipped: ComponentId[]
  warnings: string[]
}

/** Recursively list file paths under `root`, returned relative to `root` with
 *  forward slashes. Missing root => empty. */
async function listFilesRelative(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), rel)
      } else if (entry.isFile()) {
        out.push(rel)
      }
    }
  }
  await walk(root, '')
  return out
}

/**
 * Pack the caller's own per-user subtree into a zip. Secrets are never read —
 * `state/secrets.json` is not a component. `config.json` IS packed (backup
 * record) but import never writes it back.
 */
export async function exportUserData(
  canonicalUser: string,
  opts: ExportOptions = {},
): Promise<ExportResult> {
  const zip = new AdmZip()
  const packed: ComponentId[] = []

  for (const def of COMPONENTS) {
    if (def.optInSessions && !opts.withSessions) continue
    const src = def.resolve(canonicalUser)
    if (def.kind === 'file') {
      if (!existsSync(src)) continue
      zip.addFile(def.archivePath, await readFile(src))
      packed.push(def.id)
    } else {
      const files = await listFilesRelative(src)
      if (files.length === 0) continue
      for (const rel of files) {
        zip.addFile(`${def.archivePath}/${rel}`, await readFile(path.join(src, rel)))
      }
      packed.push(def.id)
    }
  }

  const manifest: SystemDataManifest = {
    format: SYSTEM_DATA_FORMAT,
    version: SYSTEM_DATA_VERSION,
    createdAt: opts.createdAt,
    lightclawVersion: VERSION,
    canonicalUser,
    components: packed,
    includesSessions: packed.includes('sessions'),
    secretsIncluded: false,
  }
  zip.addFile('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'))

  return { buffer: zip.toBuffer(), manifest, componentsPacked: packed }
}

/** Strip a dir component's archive prefix from an entry name. */
function relativeWithinComponent(entryName: string, def: ComponentDef): string {
  return entryName.slice(def.archivePath.length + 1)
}

/** Rebuild the framework-owned MEMORY.md index for the memory root and every
 *  subdirectory that holds at least one non-index `.md` file. The archive
 *  carries the indexes verbatim, but a merge that leaves target-only files in
 *  place can make them stale, so we regenerate after writing. */
async function rebuildMemoryIndexes(memoryRoot: string): Promise<void> {
  const dirs: string[] = []
  async function scan(dir: string): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    let hasMarkdown = false
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await scan(path.join(dir, entry.name))
      } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'MEMORY.md') {
        hasMarkdown = true
      }
    }
    if (hasMarkdown) dirs.push(dir)
  }
  await scan(memoryRoot)
  for (const dir of dirs) {
    await rebuildMemoryIndex(dir)
  }
}

/**
 * Restore an archive into the CALLER's own per-user subtree.
 *
 * - merge (default): write archive files over the target, keep target-only
 *   files. File components are overwritten by the archive's version.
 * - replace: for each directory component the archive carries, `rm -rf` the
 *   target subtree first so it exactly matches the archive. Scoped strictly to
 *   components present in the archive — a user/subtree the archive does not
 *   carry is never touched.
 *
 * `config.json` is never written (see manifest doc). `state/secrets.json` is
 * never in the archive, so the caller's real keys are untouched in both modes.
 */
export async function importUserData(
  canonicalUser: string,
  buffer: Buffer,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  let zip: AdmZip
  try {
    zip = new AdmZip(buffer)
  } catch {
    throw new Error('not a valid archive (could not read zip)')
  }
  const manifestEntry = zip.getEntry('manifest.json')
  if (!manifestEntry) {
    throw new Error('not a LightClaw system-data archive (manifest.json missing)')
  }
  let manifest: SystemDataManifest
  try {
    manifest = JSON.parse(manifestEntry.getData().toString('utf8')) as SystemDataManifest
  } catch {
    throw new Error('archive manifest.json is corrupt')
  }
  if (manifest.format !== SYSTEM_DATA_FORMAT) {
    throw new Error(`unrecognized archive format "${manifest.format}"`)
  }
  if (manifest.version > SYSTEM_DATA_VERSION) {
    throw new Error(
      `archive version ${manifest.version} is newer than this LightClaw supports (${SYSTEM_DATA_VERSION}); upgrade first`,
    )
  }

  const entries = zip.getEntries().filter(e => !e.isDirectory)

  // Zip-bomb backstop: the central-directory header declares the uncompressed
  // size, so we can reject an over-budget archive before decompressing a byte.
  const totalUncompressed = entries.reduce((sum, e) => sum + (e.header.size || 0), 0)
  if (totalUncompressed > MAX_IMPORT_UNCOMPRESSED_BYTES) {
    throw new Error(
      `archive expands to ${Math.round(totalUncompressed / 1024 / 1024)} MB uncompressed, ` +
        `over the ${Math.round(MAX_IMPORT_UNCOMPRESSED_BYTES / 1024 / 1024)} MB import limit`,
    )
  }

  const applied: ComponentId[] = []
  const skipped: ComponentId[] = []
  const warnings: string[] = []

  for (const def of COMPONENTS) {
    const componentEntries = entries.filter(e => entryBelongsToComponent(e.entryName, def))
    if (componentEntries.length === 0) continue
    if (!def.importable) {
      skipped.push(def.id)
      continue
    }
    const target = def.resolve(canonicalUser)
    if (def.kind === 'file') {
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, componentEntries[0]!.getData())
    } else {
      if (opts.replace) {
        await rm(target, { recursive: true, force: true })
      }
      const resolvedTarget = path.resolve(target)
      for (const entry of componentEntries) {
        const rel = relativeWithinComponent(entry.entryName, def)
        const dest = path.resolve(target, rel)
        // Zip-slip guard: a hostile archive can carry `../` in an entry name
        // (adm-zip's reader preserves it from externally-crafted zips), which
        // would let the write escape the component dir and clobber another
        // user's data, hooks/, or config.json. Refuse the whole archive
        // (fail-closed) the moment any entry resolves outside its component.
        if (dest !== resolvedTarget && !dest.startsWith(resolvedTarget + path.sep)) {
          throw new Error(`archive entry "${entry.entryName}" escapes its component directory`)
        }
        await mkdir(path.dirname(dest), { recursive: true })
        await writeFile(dest, entry.getData())
      }
    }
    applied.push(def.id)
  }

  if (applied.includes('memory')) {
    await rebuildMemoryIndexes(userMemoryRoot(canonicalUser))
  }
  if (manifest.canonicalUser && manifest.canonicalUser !== canonicalUser) {
    warnings.push(
      `archive was exported by "${manifest.canonicalUser}" but imported into "${canonicalUser}"`,
    )
  }

  return { manifest, applied, skipped, warnings }
}
