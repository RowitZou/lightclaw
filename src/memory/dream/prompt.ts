import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

import type { Role } from '../../agents/types.js'
import { userSkillsRoot } from '../../identity/paths.js'
import { discoverSkillsForUser, loadSkillBody } from '../../skill/loader.js'
import { filterSkillsForRole } from '../../skill/role-validation.js'
import type { SkillMeta } from '../../skill/types.js'
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

export type DreamSkillSummary = {
  name: string
  description: string
  whenToUse?: string
  allowedTools?: string[]
  roles: string[]
  source: string
  filePath: string
}

export type DreamSkillDetail = DreamSkillSummary & {
  body: string
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

This run's runtime context. Apply the workflow and conventions from your system prompt to the tree below.

Memory directory: \`${params.memoryDir}\`
Session transcripts root: \`${params.transcriptDir}\` (large JSONL files; search narrowly, do not read whole files)

## Current Memory Tree

${treeText}

Sessions touched since last consolidation (${params.sessionIds.length}):
${sessionList}`
}

export async function gatherDreamVisibleSkills(params: {
  cwd: string
  userId: string
  role: Role
}): Promise<DreamSkillSummary[]> {
  const skills = await discoverSkillsForUser(params.cwd, params.userId)
  return filterSkillsForRole(skills, params.role).map(toDreamSkillSummary)
}

export async function gatherDreamUserSkillsFull(params: {
  cwd: string
  userId: string
}): Promise<DreamSkillDetail[]> {
  const skills = await discoverSkillsForUser(params.cwd, params.userId)
  const userSkills = skills.filter(skill => skill.source === 'user')
  return Promise.all(
    userSkills.map(async skill => ({
      ...toDreamSkillSummary(skill),
      body: await loadSkillBody(skill),
    })),
  )
}

export function buildSkillCuratorPrompt(params: {
  userId: string
  role: Role
  transcriptPaths: string[]
  visibleSkills: DreamSkillSummary[]
}): string {
  return `# Dream: Skill Discovery

This run's runtime context. Apply the workflow and conventions from your system prompt to the role-scoped data below.

Canonical user: \`${params.userId}\`
Target role: \`${params.role.agentType}\`
Per-user skill directory: \`${userSkillsRoot(params.userId)}\`

## Skills Currently Visible To This Role

${formatSkillSummaries(params.visibleSkills)}

## Role-Fork Transcript Paths

${formatTranscriptPaths(params.transcriptPaths)}`
}

export function buildSkillConsolidatorPrompt(params: {
  userId: string
  userSkills: DreamSkillDetail[]
}): string {
  return `# Dream: Skill Consolidation

This run's runtime context. Apply the workflow and conventions from your system prompt to the per-user skill set below.

Canonical user: \`${params.userId}\`
Per-user skill directory: \`${userSkillsRoot(params.userId)}\`

## Complete Per-User Skill Set

${formatSkillDetails(params.userSkills)}`
}

async function listRoleDirs(memoryDir: string): Promise<string[]> {
  try {
    const entries = await readdir(memoryDir, { withFileTypes: true })
    return entries
      .filter(entry =>
        entry.isDirectory()
        && entry.name !== '_shared'
        // `archive/` is the aging-eviction destination; including it as a
        // "role-private" tier would surface evicted entries to autoDream as
        // active memory and tempt it to consolidate / promote archived files.
        && entry.name !== 'archive'
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

function toDreamSkillSummary(skill: SkillMeta): DreamSkillSummary {
  return {
    name: skill.name,
    description: skill.description,
    whenToUse: skill.whenToUse,
    allowedTools: skill.allowedTools,
    roles: skill.roles,
    source: skill.source,
    filePath: skill.filePath,
  }
}

function formatSkillSummaries(skills: DreamSkillSummary[]): string {
  if (skills.length === 0) {
    return '- [none]'
  }
  return skills.map(skill => [
    `### ${skill.name}`,
    `- source: ${skill.source}`,
    `- file: ${skill.filePath}`,
    `- roles: ${skill.roles.length > 0 ? skill.roles.join(', ') : '[bundled literal allowlist]'}`,
    `- description: ${skill.description}`,
    `- when_to_use: ${skill.whenToUse ?? '[not set]'}`,
    `- allowed-tools: ${skill.allowedTools?.join(', ') ?? '[not set]'}`,
  ].join('\n')).join('\n\n')
}

function formatSkillDetails(skills: DreamSkillDetail[]): string {
  if (skills.length === 0) {
    return '- [none]'
  }
  return skills.map(skill => [
    `### ${skill.name}`,
    `- file: ${skill.filePath}`,
    `- roles: ${skill.roles.join(', ')}`,
    `- description: ${skill.description}`,
    `- when_to_use: ${skill.whenToUse ?? '[not set]'}`,
    `- allowed-tools: ${skill.allowedTools?.join(', ') ?? '[not set]'}`,
    '',
    '```markdown',
    skill.body,
    '```',
  ].join('\n')).join('\n\n')
}

function formatTranscriptPaths(paths: string[]): string {
  return paths.length > 0
    ? paths.map(filePath => `- ${filePath}`).join('\n')
    : '- [none]'
}
