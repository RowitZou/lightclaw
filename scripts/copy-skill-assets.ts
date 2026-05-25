// Build-time copy of bundled skill assets (scripts/ subdirectories) into
// dist/skill-assets/<name>/. Runs after `tsdown` so that
// `${LIGHTCLAW_SKILL_DIR}` placeholder resolves to a real on-disk directory
// in production (where SKILL.md itself is already inlined into the JS bundle).
//
// Phase 16 V1 bundled skills (remember / skillify) ship without scripts/,
// so this is effectively no-op for them. The empty placeholder directory is
// still created so `bundledSkillDir(name)` always returns an existing path.
//
// Future: if a bundled skill ships reference/ or templates/ subdirs, extend
// the per-asset-kind switch below. V1 only handles scripts/.

import { cp, mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ASSET_SUBDIRS = ['scripts'] as const

async function main(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const repoRoot = path.resolve(here, '..')
  const bundledDir = path.join(repoRoot, 'src/skill/bundled')
  const distAssetsDir = path.join(repoRoot, 'dist/skill-assets')

  const entries = await readdir(bundledDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillName = entry.name
    const destDir = path.join(distAssetsDir, skillName)
    // Always create the placeholder dir so bundledSkillDir(name) resolves
    // to an existing path even when the skill has no assets.
    await mkdir(destDir, { recursive: true })

    for (const sub of ASSET_SUBDIRS) {
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
