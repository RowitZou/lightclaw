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
