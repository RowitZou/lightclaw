export const MEMORY_TYPES = [
  'user',
  'feedback',
  'project',
  'reference',
] as const

export type MemoryType = (typeof MEMORY_TYPES)[number]

export type MemoryEntry = {
  filename: string
  type: MemoryType
  description: string
  content: string
  /** mtime in ms since epoch — populated by scanMemoryFiles via fs.stat,
   *  or Date.now() for in-memory entries built by extract before write.
   *  Used by aging helpers to render "(saved N days ago)" prefix and
   *  staleness reminder for memories older than one day. */
  mtimeMs: number
}

/** Coarse origin of a memory entry relative to the reading role: `'own'` is
 *  the role's own write dir (where MemoryWrite lands), `'shared'` is any other
 *  readable dir (user-root L1, the `_shared` workboard, or — for curators —
 *  another role's private dir). Surfaced as a list label so the agent can tell
 *  its own notes from shared context without exposing a real path prefix. */
export type MemoryScope = 'own' | 'shared'

export type MemoryEntryWithScope = MemoryEntry & { scope: MemoryScope }

export type MemoryFrontmatter = {
  type: MemoryType
  description: string
}

export function isMemoryType(value: string): value is MemoryType {
  return MEMORY_TYPES.includes(value as MemoryType)
}