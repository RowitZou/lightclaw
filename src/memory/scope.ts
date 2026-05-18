import { readdir } from 'node:fs/promises'
import path from 'node:path'

import type { Role } from '../agents/types.js'

export type ResolvedMemoryDirs = {
  selfWriteDir: string
  readableDirs: string[]
}

export function resolveMemoryDirsForRole(
  role: Role,
  memoryDir: string,
): ResolvedMemoryDirs {
  const root = path.resolve(memoryDir)
  const kind = role.kind ?? 'worker'
  const selfWriteDir =
    kind === 'worker'
      ? path.join(root, role.agentType)
      : root

  const readableDirs =
    kind === 'orchestrator' || kind === 'internal'
      ? [root, path.join(root, '_shared')]
      : [root, path.join(root, '_shared'), selfWriteDir]

  return {
    selfWriteDir,
    readableDirs: dedupePaths(readableDirs),
  }
}

export async function resolveReadableMemoryDirsForRole(
  role: Role,
  memoryDir: string,
): Promise<ResolvedMemoryDirs> {
  const root = path.resolve(memoryDir)
  const resolved = resolveMemoryDirsForRole(role, root)
  const kind = role.kind ?? 'worker'

  if (kind !== 'internal') {
    return resolved
  }

  const roleDirs = await listTopLevelRoleDirs(root)
  return {
    selfWriteDir: resolved.selfWriteDir,
    readableDirs: dedupePaths([...resolved.readableDirs, ...roleDirs]),
  }
}

/** Classify a target path relative to the memory root into the L1/L2/L3
 *  tier system documented in `# LightClaw Memory Layers Notes`:
 *  - **L1** — file at the user root (`<memoryDir>/foo.md`).
 *  - **L2** — file under the cross-role shared workboard (`<memoryDir>/_shared/...`).
 *  - **L3** — file under a worker's role-private dir (`<memoryDir>/<agentType>/...`).
 *  Returns null when the target sits outside the memory root (boundary
 *  violation; caller treats as denied). Used by `MemoryWrite` audit row
 *  `sourceTier` field so post-hoc audit can attribute writes per tier
 *  without re-deriving from path strings. */
export function resolveSourceTier(targetPath: string, memoryDir: string): 'L1' | 'L2' | 'L3' | null {
  const rel = path.relative(path.resolve(memoryDir), path.resolve(targetPath))
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return null
  }
  const segments = rel.split(path.sep).filter(Boolean)
  if (segments.length === 1) {
    return 'L1'
  }
  if (segments[0] === '_shared') {
    return 'L2'
  }
  return 'L3'
}

export function memoryPathWithinDir(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function relativeMemoryFilename(memoryDir: string, dir: string, filename: string): string {
  const relativeDir = path.relative(path.resolve(memoryDir), path.resolve(dir))
  return relativeDir.length === 0
    ? filename
    : path.join(relativeDir, filename)
}

async function listTopLevelRoleDirs(memoryDir: string): Promise<string[]> {
  try {
    const entries = await readdir(memoryDir, { withFileTypes: true })
    return entries
      .filter(entry => entry.isDirectory() && entry.name !== '_shared')
      .map(entry => path.join(memoryDir, entry.name))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const candidate of paths) {
    const resolved = path.resolve(candidate)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    out.push(resolved)
  }
  return out
}
