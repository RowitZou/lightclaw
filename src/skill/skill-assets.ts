import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { Runtime } from '../runtime/index.js'
import { skillDirFor } from './skill-dir.js'
import type { SkillMeta } from './types.js'

export const SKILL_ASSET_SUBDIRS = ['scripts', 'references'] as const

export async function hasSkillAssets(meta: SkillMeta): Promise<boolean> {
  const root = skillDirFor(meta)
  for (const subdir of SKILL_ASSET_SUBDIRS) {
    if (await dirHasFiles(path.join(root, subdir))) {
      return true
    }
  }
  return false
}

export async function materializeSkillAssets(
  meta: SkillMeta,
  runtime: Runtime,
  workspaceRoot = runtime.workspaceRoot,
): Promise<string> {
  const srcRoot = skillDirFor(meta)
  const dstRoot = path.join(workspaceRoot, '.lightclaw', 'skill-run', meta.name)

  for (const subdir of SKILL_ASSET_SUBDIRS) {
    const srcDir = path.join(srcRoot, subdir)
    for await (const file of walkFiles(srcDir)) {
      const rel = path.relative(srcRoot, file)
      const dst = path.join(dstRoot, rel)
      try {
        await runtime.fs.writeFile(dst, await fs.readFile(file))
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        process.stderr.write(
          `[skill-assets] failed to materialize ${meta.name}/${rel}: ${detail}\n`,
        )
      }
    }
  }

  return dstRoot
}

async function dirHasFiles(root: string): Promise<boolean> {
  try {
    for await (const _file of walkFiles(root)) {
      return true
    }
  } catch {
    return false
  }
  return false
}

async function* walkFiles(root: string): AsyncGenerator<string> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw error
  }

  for (const entry of entries) {
    const filePath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      yield* walkFiles(filePath)
    } else if (entry.isFile()) {
      yield filePath
    }
  }
}
