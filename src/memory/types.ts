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
}

export type MemoryFrontmatter = {
  type: MemoryType
  description: string
}

export function isMemoryType(value: string): value is MemoryType {
  return MEMORY_TYPES.includes(value as MemoryType)
}