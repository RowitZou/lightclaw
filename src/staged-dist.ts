// Staged-build promotion for self-update.
//
// `/admin version update` builds into `dist.next/` (see self-update.ts) so the
// RUNNING daemon's `dist/` is never mutated while it is still serving. ESM
// dynamic imports resolve from disk at call time, so overwriting `dist/` in
// place used to crash any lazy chunk load that happened between the rebuild
// and the restart (2026-06-30 prod: a pairing approval during that window hit
// `Cannot find module dist/welcome-card-<oldhash>.js` and the user's preheat +
// welcome card were lost for a day).
//
// The swap happens at the very end of the update-restart shutdown path in
// cli.ts — after every drain has finished, synchronously, right before
// `process.exit(75)` — when no further imports can occur:
//
//   rm -rf dist.prev; mv dist dist.prev; mv dist.next dist
//
// `dist.prev/` is kept as a manual rollback of the last known-good build. If
// the process dies between the two renames (no `dist/`, staged `dist.next/`
// present), run.sh promotes the staged build before relaunching — see the
// matching guard there.
//
// Kept free of project imports (fs + path only) so cli.ts can call it from the
// shutdown path without pulling anything extra into that dependency chain.

import { existsSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'

/** Directory (relative to the repo root) the staged build is written to. */
export const STAGED_DIST_DIR = 'dist.next'
/** The live build directory the daemon was launched from. */
export const ACTIVE_DIST_DIR = 'dist'
/** Where the previous build is parked on promotion (manual rollback). */
export const PREVIOUS_DIST_DIR = 'dist.prev'

export type PromoteResult =
  | { promoted: true }
  | { promoted: false; reason: 'no-staged-build' }
  | { promoted: false; reason: 'swap-failed'; error: string }

/** Promote `dist.next/` to `dist/`, parking the current `dist/` as
 *  `dist.prev/`. Synchronous on purpose: it runs immediately before
 *  process.exit, where async work would be cut off. Never throws — the caller
 *  is the shutdown path and must reach process.exit regardless; a failed swap
 *  leaves the (still intact) old `dist/` in place, so the relaunch runs the
 *  previous build instead of no build at all. */
export function promoteStagedDist(repoRoot: string): PromoteResult {
  const staged = path.join(repoRoot, STAGED_DIST_DIR)
  const active = path.join(repoRoot, ACTIVE_DIST_DIR)
  const previous = path.join(repoRoot, PREVIOUS_DIST_DIR)
  if (!existsSync(staged)) {
    return { promoted: false, reason: 'no-staged-build' }
  }
  try {
    rmSync(previous, { recursive: true, force: true })
    if (existsSync(active)) {
      renameSync(active, previous)
    }
    renameSync(staged, active)
    return { promoted: true }
  } catch (error) {
    return { promoted: false, reason: 'swap-failed', error: String(error) }
  }
}
