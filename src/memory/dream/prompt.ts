import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { scanMemoryFiles } from '../auto-memory.js'
import type { MemoryEntry } from '../types.js'

export type DreamMemoryTreeSection = {
  label: string
  relativeDir: string
  entries: MemoryEntry[]
}

export type DreamMemoryTree = {
  root: DreamMemoryTreeSection
  shared: DreamMemoryTreeSection | null
  roleDirs: DreamMemoryTreeSection[]
}

export async function gatherDreamMemoryTree(memoryDir: string): Promise<DreamMemoryTree> {
  const roleDirs = await listRoleDirs(memoryDir)
  const sharedDir = path.join(memoryDir, '_shared')
  const hasSharedDir = await directoryExists(sharedDir)
  const sharedEntries = await scanMemoryFiles(sharedDir)

  return {
    root: {
      label: 'user-level root',
      relativeDir: '.',
      entries: await scanMemoryFiles(memoryDir),
    },
    shared:
      hasSharedDir
        ? {
            label: 'shared workboard',
            relativeDir: '_shared',
            entries: sharedEntries,
          }
        : null,
    roleDirs: await Promise.all(
      roleDirs.map(async dirName => ({
        label: `role-private: ${dirName}`,
        relativeDir: dirName,
        entries: await scanMemoryFiles(path.join(memoryDir, dirName)),
      })),
    ),
  }
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
}

export function buildDreamPrompt(params: {
  memoryDir: string
  transcriptDir: string
  sessionIds: string[]
  memoryTree: DreamMemoryTree
}): string {
  const sessionList = params.sessionIds.length > 0
    ? params.sessionIds.map(sessionId => `- ${sessionId}`).join('\n')
    : '- [none]'
  const treeText = formatDreamMemoryTree(params.memoryTree)

  return `# Dream: User Memory Consolidation

You are performing a dream: a reflective pass over this user's durable memory tree. Synthesize recent learning into organized memory files so future sessions and roles can orient quickly.

Memory directory: \`${params.memoryDir}\`
Session transcripts root: \`${params.transcriptDir}\` (large JSONL files; search narrowly, do not read whole files)

## Current Memory Tree

${treeText}

Sessions touched since last consolidation (${params.sessionIds.length}):
${sessionList}

## Workflow

1. Survey the tree above. Use MemoryRead / Read / Grep / Glob only when the manifest shows a specific file or topic worth inspecting.
2. Consolidate duplicates within the same directory by merging into the best file and deleting superseded files.
3. Promote broadly useful cross-role or role-agnostic findings into \`_shared/\` using MemoryMove or MemoryWriteAt, then delete obsolete source files.
4. Keep role-specific operational notes inside that role's private directory.
5. Fix contradicted facts at the source when newer evidence clearly disproves them. Convert relative dates to absolute dates.

\`MEMORY.md\` files are framework-managed. Do not write, move, or delete any path whose basename is \`MEMORY.md\`; MemoryWriteAt / MemoryMove / MemoryDelete will rebuild indexes automatically after content-file changes.

Return a brief summary of what you consolidated, updated, or pruned. If nothing changed, say so.`
}

async function listRoleDirs(memoryDir: string): Promise<string[]> {
  try {
    const entries = await readdir(memoryDir, { withFileTypes: true })
    return entries
      .filter(entry =>
        entry.isDirectory()
        && entry.name !== '_shared'
        && !entry.name.startsWith('.'),
      )
      .map(entry => entry.name)
      .sort((left, right) => left.localeCompare(right))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
}

function formatDreamMemoryTree(tree: DreamMemoryTree): string {
  const sections = [formatSection(tree.root)]
  if (tree.shared) {
    sections.push(formatSection(tree.shared))
  } else {
    sections.push('### shared workboard (_shared/)\n- [not present]')
  }

  if (tree.roleDirs.length === 0) {
    sections.push('### role-private directories\n- [none]')
  } else {
    sections.push(...tree.roleDirs.map(formatSection))
  }

  return sections.join('\n\n')
}

function formatSection(section: DreamMemoryTreeSection): string {
  const entries = section.entries.length > 0
    ? section.entries
        .map(entry => `- [${entry.type}] ${pathForSection(section.relativeDir, entry.filename)}: ${entry.description}`)
        .join('\n')
    : '- [empty]'

  return `### ${section.label} (${section.relativeDir}/)\n${entries}`
}

function pathForSection(relativeDir: string, filename: string): string {
  return relativeDir === '.' ? filename : path.join(relativeDir, filename)
}
