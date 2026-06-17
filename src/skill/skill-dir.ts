import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { SkillMeta } from './types.js'

// Self module path. In dev (tsx) this resolves to `.../src/skill/skill-dir.ts`;
// in prod (tsdown bundle) it resolves inside `dist/cli.js`.
const SELF_PATH = fileURLToPath(import.meta.url)
const SELF_DIR = path.dirname(SELF_PATH)
const IS_DIST = SELF_PATH.includes(`${path.sep}dist${path.sep}`)

/**
 * On-disk asset directory for a bundled skill.
 *
 * - dev (tsx):  `src/skill/bundled/<name>`  (SKILL.md + optional assets in source tree)
 * - prod (dist): `dist/skill-assets/<name>` (assets copied here at build time;
 *                                            SKILL.md is inlined into the JS bundle)
 *
 * The path always resolves so bundled skills can reference materialized assets
 * from SKILL.md body without further framework changes.
 */
export function bundledSkillDir(name: string): string {
  if (IS_DIST) {
    // SELF_DIR == .../dist (bundled cli.js cwd)
    return path.resolve(SELF_DIR, 'skill-assets', name)
  }
  // SELF_DIR == .../src/skill
  return path.resolve(SELF_DIR, 'bundled', name)
}

/**
 * On-disk asset directory for a user skill.
 *
 * `<lightclawHome>/users/<canonical>/skills/<name>/` — the parent
 * directory of the skill's SKILL.md path. Any scripts/ subdirectory lives
 * next to SKILL.md.
 */
export function userSkillDir(filePath: string): string {
  return path.dirname(filePath)
}

/**
 * Resolve the asset directory for an arbitrary skill via its meta.
 */
export function skillDirFor(meta: SkillMeta): string {
  return meta.source === 'builtin' ? bundledSkillDir(meta.name) : userSkillDir(meta.filePath)
}
