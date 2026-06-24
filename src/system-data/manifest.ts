import {
  identityPermissionsPath,
  userConfigPath,
  userMemoryRoot,
  userPreferencesPath,
  userSessionsRoot,
  userSkillsRoot,
} from '../identity/paths.js'

/** Stable archive format tag — import refuses anything else. */
export const SYSTEM_DATA_FORMAT = 'lightclaw-system-data' as const
/** Bump only on a breaking archive-layout change; import rejects unknown majors. */
export const SYSTEM_DATA_VERSION = 1 as const

export type ComponentId =
  | 'memory'
  | 'skills'
  | 'sessions'
  | 'preferences'
  | 'permissions'
  | 'config'

export interface ComponentDef {
  id: ComponentId
  /** A directory tree (recursive) or a single JSON file. */
  kind: 'dir' | 'file'
  /** Path of this component INSIDE the archive (forward slashes), relative to
   *  the per-user root. Import maps it back onto the caller's own user root. */
  archivePath: string
  /** Absolute on-disk location under `users/<canonical>/`, source for export
   *  and target for import. */
  resolve: (canonicalUser: string) => string
  /** `false` => packed as a backup record but NEVER written on import. Only
   *  `config` is non-importable: it is the user's own config (with their key
   *  references); overwriting it would replace their keys with the archive's
   *  placeholders. The real keys in `state/secrets.json` are never in the
   *  archive at all. */
  importable: boolean
  /** Sessions are bulk history — only packed when `--with-sessions` is set. */
  optInSessions?: boolean
}

/**
 * `/system data` operates on the CALLER's own `users/<canonical>/` subtree — it
 * is per-user, available to every paired user, not admin-only. The components
 * below are the portable slices of that subtree.
 *
 * Deliberately excluded (never packed, neither exported nor imported):
 *  - `state/secrets.json` — the user's real API keys; exporting them would leak
 *    key material onto disk / IM.
 *  - Live scheduler/ledger state (`state/bg-tasks*.json`, `taskruns/`) — it
 *    references sessions and would re-fire stale work on another box.
 *  - Deployment bindings: `state/rlaunch-mounts.json` (gpfs mount paths bound to
 *    one cluster) and `state/feishu-workspace.json` (a cloud-folder token bound
 *    to one tenant). These are box/tenant-specific — restoring them verbatim is
 *    wrong on any other deployment; they must be re-bound after a move, not
 *    carried in the archive. (Same reasoning as the scheduler state above.)
 *  - Transient caches (`state/feishu-uploads.json`) and `workspace/` (bulk).
 */
export const COMPONENTS: readonly ComponentDef[] = [
  { id: 'memory', kind: 'dir', archivePath: 'memory', resolve: userMemoryRoot, importable: true },
  { id: 'skills', kind: 'dir', archivePath: 'skills', resolve: userSkillsRoot, importable: true },
  {
    id: 'sessions',
    kind: 'dir',
    archivePath: 'sessions',
    resolve: userSessionsRoot,
    importable: true,
    optInSessions: true,
  },
  {
    id: 'preferences',
    kind: 'file',
    archivePath: 'state/preferences.json',
    resolve: userPreferencesPath,
    importable: true,
  },
  {
    id: 'permissions',
    kind: 'file',
    archivePath: 'state/permissions.json',
    resolve: identityPermissionsPath,
    importable: true,
  },
  // Packed for backup completeness, NEVER imported — see `importable` doc above.
  { id: 'config', kind: 'file', archivePath: 'config.json', resolve: userConfigPath, importable: false },
] as const

export interface SystemDataManifest {
  format: typeof SYSTEM_DATA_FORMAT
  version: number
  /** Stamped by the command layer (modules cannot read the clock). */
  createdAt?: string
  /** LightClaw VERSION at export time — informational compatibility hint. */
  lightclawVersion: string
  /** The user whose subtree was exported — informational; import targets the
   *  CALLER's own subtree regardless, and warns on mismatch. */
  canonicalUser: string
  /** Which components are actually present in the archive. */
  components: ComponentId[]
  includesSessions: boolean
  /** Always false — the user's API keys are never exported. */
  secretsIncluded: false
}

/** True iff a forward-slash archive entry name belongs to `def`'s component.
 *  File components match exactly; dir components match the path prefix at a
 *  segment boundary (so `memory` does not capture `memory-notes.json`). */
export function entryBelongsToComponent(entryName: string, def: ComponentDef): boolean {
  if (def.kind === 'file') return entryName === def.archivePath
  return entryName === def.archivePath || entryName.startsWith(`${def.archivePath}/`)
}
