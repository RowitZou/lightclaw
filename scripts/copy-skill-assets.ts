// Build-time copy of bundled skill assets (scripts/ and references/) into
// <outDir>/skill-assets/<name>/. Runs after `tsdown` so that
// `${LIGHTCLAW_SKILL_DIR}` placeholder resolves to a real on-disk directory
// in production (where SKILL.md itself is already inlined into the JS bundle).
// The optional first CLI arg is the output dir name relative to the repo root
// (default `dist`; the self-update staged build passes `dist.next`).
//
// Phase 16 V1 bundled skills (remember / skillify) shipped without scripts/,
// so this is effectively no-op for them. The empty placeholder directory is
// still created so `bundledSkillDir(name)` always returns an existing path.

import { cp, mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { SKILL_ASSET_SUBDIRS } from '../src/skill/skill-assets.js'

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const repoRoot = path.resolve(here, '..')
  const outDirName = process.argv[2] ?? 'dist'
  const bundledDir = path.join(repoRoot, 'src/skill/bundled')
  const distAssetsDir = path.join(repoRoot, outDirName, 'skill-assets')

  const entries = await readdir(bundledDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillName = entry.name
    const destDir = path.join(distAssetsDir, skillName)
    // Always create the placeholder dir so bundledSkillDir(name) resolves
    // to an existing path even when the skill has no assets.
    await mkdir(destDir, { recursive: true })

    for (const sub of SKILL_ASSET_SUBDIRS) {
      const src = path.join(bundledDir, skillName, sub)
      try {
        const stats = await stat(src)
        if (stats.isDirectory()) {
          await cp(src, path.join(destDir, sub), { recursive: true })
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') throw err
        // Subdir does not exist for this skill — skip silently.
      }
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
