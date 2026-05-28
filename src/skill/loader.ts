import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { userSkillsRoot } from '../identity/paths.js'
import { parseFrontmatter } from '../memory/auto-memory.js'
import { lightclawHome } from '../paths.js'
import { SKILL_ASSET_SUBDIRS } from './skill-assets.js'
import type { LoadedSkill, SkillMeta, SkillSource } from './types.js'
import { bundledSkills, getBundledSkillByName } from './bundled/index.js'

const warnedLegacySkillDirs = new Set<string>()
const warnedCollisionSkills = new Set<string>()
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const ROLE_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const SHELL_INJECTION_RE = /!\s*`[^`]*`/
const SKILL_ASSET_FILE_MAX_BYTES = 64 * 1024
const SKILL_ASSET_MAX_FILES = 32
const SKILL_ASSET_TOTAL_MAX_BYTES = 256 * 1024

type SkillWriteFile = {
  path: string
  content: string
}

function toSkillMeta(skill: LoadedSkill): SkillMeta {
  return {
    name: skill.name,
    description: skill.description,
    whenToUse: skill.whenToUse,
    allowedTools: skill.allowedTools,
    roles: skill.roles,
    source: skill.source,
    filePath: skill.filePath,
    lastUsedAt: skill.lastUsedAt,
  }
}

function parseSkillFrontmatter(
  filePath: string,
  source: SkillSource,
  frontmatter: Record<string, string | string[]>,
): SkillMeta | null {
  if ('allowed_tools' in frontmatter) {
    throw new Error(
      `Skill ${filePath} uses deprecated frontmatter key "allowed_tools"; use "allowed-tools".`,
    )
  }

  const name = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : ''
  const description =
    typeof frontmatter.description === 'string'
      ? frontmatter.description.trim()
      : ''

  if (!name || !description) {
    return null
  }
  const roles = parseSkillRoles(filePath, source, frontmatter.roles)
  const lastUsedAtRaw = frontmatter.last_used_at
  const lastUsedAt =
    typeof lastUsedAtRaw === 'string' && lastUsedAtRaw.trim().length > 0
      ? lastUsedAtRaw.trim()
      : undefined

  return {
    name,
    description,
    whenToUse:
      typeof frontmatter.when_to_use === 'string'
        ? frontmatter.when_to_use.trim()
        : undefined,
    allowedTools: Array.isArray(frontmatter['allowed-tools'])
      ? frontmatter['allowed-tools'].map(value => value.trim()).filter(Boolean)
      : undefined,
    roles,
    source,
    filePath,
    lastUsedAt,
  }
}

function parseSkillRoles(
  filePath: string,
  source: SkillSource,
  value: string | string[] | undefined,
): string[] {
  if (value === undefined) {
    return source === 'user' ? ['main'] : []
  }
  if (!Array.isArray(value)) {
    throw new Error(
      `Skill ${filePath} frontmatter "roles" must be a YAML list of role names ` +
      `(e.g. \`roles: [main]\` flow-style, or block-style with one \`- name\` per ` +
      `line). Got: ${JSON.stringify(value)}.`,
    )
  }
  const roles = value.map(role => role.trim())
  if (roles.length === 0 || roles.some(role => role.length === 0)) {
    throw new Error(
      `Skill ${filePath} frontmatter "roles" must contain at least one role name. ` +
      `Got: ${JSON.stringify(value)}.`,
    )
  }
  for (const role of roles) {
    if (!ROLE_NAME_RE.test(role)) {
      throw new Error(
        `Skill ${filePath} frontmatter "roles" contains invalid role name "${role}" ` +
        `(role names must match ${ROLE_NAME_RE}). Got: ${JSON.stringify(value)}.`,
      )
    }
  }
  return roles
}

async function loadSkillsFromDirectory(
  rootDir: string,
  source: SkillSource,
): Promise<SkillMeta[]> {
  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true })
    const skills = await Promise.all(
      entries
        .filter(entry => entry.isDirectory())
        .map(async entry => {
          const filePath = path.join(rootDir, entry.name, 'SKILL.md')
          try {
            const raw = await fs.readFile(filePath, 'utf8')
            const parsed = parseFrontmatter(raw)
            rejectShellInjection(filePath, parsed.body)
            return parseSkillFrontmatter(filePath, source, parsed.frontmatter)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              return null
            }
            throw error
          }
        }),
    )

    return skills.filter((skill): skill is SkillMeta => skill !== null)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
}

export async function discoverSkills(cwd: string): Promise<SkillMeta[]> {
  return discoverSkillsForUser(cwd)
}

export async function discoverSkillsForUser(
  cwd: string,
  userId?: string,
): Promise<SkillMeta[]> {
  const skillMap = new Map<string, SkillMeta>()

  for (const bundledSkill of bundledSkills) {
    skillMap.set(bundledSkill.name, toSkillMeta(bundledSkill))
  }

  if (userId) {
    for (const skill of await loadSkillsFromDirectory(userSkillsRoot(userId), 'user')) {
      if (skillMap.has(skill.name)) {
        if (!warnedCollisionSkills.has(skill.name)) {
          warnedCollisionSkills.add(skill.name)
          process.stderr.write(
            `skills: user skill "${skill.name}" (${skill.filePath}) collides with a bundled skill; ` +
              `ignoring the user skill. Rename it to load.\n`,
          )
        }
        continue
      }
      skillMap.set(skill.name, skill)
    }
  }

  void warnIfLegacySkillDir(path.join(lightclawHome(), 'skills'))
  void warnIfLegacySkillDir(path.join(path.resolve(cwd), '.lightclaw', 'skills'))

  return [...skillMap.values()].sort((left, right) => left.name.localeCompare(right.name))
}

export function normalizeSkillName(name: string): string {
  const trimmed = name.trim()
  if (!SKILL_NAME_RE.test(trimmed)) {
    throw new Error(
      'Skill name must be a kebab-case identifier matching /^[a-z0-9][a-z0-9-]{0,63}$/.',
    )
  }
  return trimmed
}

export async function writeUserSkill(input: {
  userId: string
  name: string
  markdown: string
  overwrite?: boolean
  files?: SkillWriteFile[]
}): Promise<SkillMeta> {
  const name = normalizeSkillName(input.name)
  const root = userSkillsRoot(input.userId)
  const skillDir = path.join(root, name)
  const filePath = path.join(skillDir, 'SKILL.md')
  const parsed = parseFrontmatter(input.markdown)
  rejectShellInjection(filePath, parsed.body)
  const meta = parseSkillFrontmatter(filePath, 'user', parsed.frontmatter)
  if (!meta) {
    throw new Error('Skill markdown must include frontmatter with name and description.')
  }
  if (meta.name !== name) {
    throw new Error(`Skill frontmatter name "${meta.name}" must match requested name "${name}".`)
  }
  const files = validateSkillWriteFiles(skillDir, input.files ?? [])

  if (!input.overwrite) {
    try {
      await fs.readFile(filePath, 'utf8')
      throw new Error(`Skill "${name}" already exists. Set overwrite=true to replace it.`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
  }

  await writeStagedUserSkill({
    root,
    skillDir,
    markdown: input.markdown,
    files,
  })
  return meta
}

function validateSkillWriteFiles(
  skillDir: string,
  files: SkillWriteFile[],
): Array<SkillWriteFile & { resolvedPath: string }> {
  if (files.length > SKILL_ASSET_MAX_FILES) {
    throw new Error(`Skill supporting files exceed the ${SKILL_ASSET_MAX_FILES} file limit.`)
  }

  const seen = new Set<string>()
  let totalBytes = 0
  return files.map(file => {
    const resolved = assertSkillAssetPath(skillDir, file.path)
    const normalizedPath = path.relative(skillDir, resolved)
    if (seen.has(normalizedPath)) {
      throw new Error(`Duplicate skill supporting file path "${file.path}".`)
    }
    seen.add(normalizedPath)

    const byteLength = Buffer.byteLength(file.content, 'utf8')
    if (byteLength > SKILL_ASSET_FILE_MAX_BYTES) {
      throw new Error(
        `Skill supporting file "${file.path}" exceeds the ${SKILL_ASSET_FILE_MAX_BYTES} byte limit.`,
      )
    }
    totalBytes += byteLength
    if (totalBytes > SKILL_ASSET_TOTAL_MAX_BYTES) {
      throw new Error(
        `Skill supporting files exceed the ${SKILL_ASSET_TOTAL_MAX_BYTES} byte total limit.`,
      )
    }
    return { ...file, resolvedPath: resolved }
  })
}

function assertSkillAssetPath(skillDir: string, rawPath: string): string {
  if (!rawPath || rawPath.includes('\0') || path.isAbsolute(rawPath)) {
    throw new Error(
      `Skill supporting file path "${rawPath}" must be relative under scripts/ or references/.`,
    )
  }

  const parts = rawPath.split(/[\\/]+/)
  if (
    parts.length < 2 ||
    parts.some(part => part.length === 0 || part === '.' || part === '..') ||
    !SKILL_ASSET_SUBDIRS.includes(parts[0] as typeof SKILL_ASSET_SUBDIRS[number])
  ) {
    throw new Error(
      `Skill supporting file path "${rawPath}" must be under scripts/ or references/ and cannot contain "." or "..".`,
    )
  }

  const normalized = parts.join(path.sep)
  const resolved = path.resolve(skillDir, normalized)
  const rootWithSep = `${path.resolve(skillDir)}${path.sep}`
  if (!resolved.startsWith(rootWithSep)) {
    throw new Error(`Skill supporting file path "${rawPath}" escapes the skill directory.`)
  }
  return resolved
}

async function writeStagedUserSkill(input: {
  root: string
  skillDir: string
  markdown: string
  files: Array<SkillWriteFile & { resolvedPath: string }>
}): Promise<void> {
  await fs.mkdir(input.root, { recursive: true, mode: 0o700 })
  const suffix = randomUUID()
  const tempDir = `${input.skillDir}.tmp-${suffix}`
  const backupDir = `${input.skillDir}.bak-${suffix}`
  let hasBackup = false

  try {
    await fs.mkdir(tempDir, { recursive: true, mode: 0o700 })
    const tempSkillPath = path.join(tempDir, 'SKILL.md')
    await fs.writeFile(tempSkillPath, input.markdown, { encoding: 'utf8', mode: 0o600 })
    await fs.chmod(tempSkillPath, 0o600)

    for (const file of input.files) {
      const relativePath = path.relative(input.skillDir, file.resolvedPath)
      const tempFilePath = path.join(tempDir, relativePath)
      await fs.mkdir(path.dirname(tempFilePath), { recursive: true, mode: 0o700 })
      await fs.writeFile(tempFilePath, file.content, { encoding: 'utf8', mode: 0o600 })
      await fs.chmod(tempFilePath, 0o600)
    }

    try {
      await fs.rename(input.skillDir, backupDir)
      hasBackup = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }

    try {
      await fs.rename(tempDir, input.skillDir)
    } catch (error) {
      if (hasBackup) {
        await fs.rename(backupDir, input.skillDir)
        hasBackup = false
      }
      throw error
    }

    if (hasBackup) {
      await fs.rm(backupDir, { recursive: true, force: true })
      hasBackup = false
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
    if (hasBackup) {
      await fs.rm(backupDir, { recursive: true, force: true })
    }
  }
}

export async function deleteUserSkill(input: {
  userId: string
  name: string
}): Promise<{ name: string; filePath: string }> {
  const name = normalizeSkillName(input.name)
  if (getBundledSkillByName(name)) {
    throw new Error(`Skill "${name}" is bundled and cannot be deleted by SkillDelete.`)
  }
  const skillDir = path.join(userSkillsRoot(input.userId), name)
  const filePath = path.join(skillDir, 'SKILL.md')
  try {
    await fs.unlink(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Skill "${name}" does not exist in the current user's skill set.`)
    }
    throw error
  }
  await fs.rm(skillDir, { recursive: true, force: true })
  return { name, filePath }
}

/**
 * Best-effort write of `last_used_at: <ISO8601>` into a per-user SKILL.md
 * frontmatter. Called fire-and-forget after a UseSkill hit; failures only
 * stderr-log so a skill call is never blocked by an audit-only update. V1
 * doesn't consume this field; reserved for Phase 8+ aging / SkillSearch
 * recency heuristics.
 *
 * Updates the line in-place if present; otherwise inserts a new line right
 * before the frontmatter closing `---`. Preserves all other bytes — agent /
 * curator wrote the SKILL.md, this helper only edits one field.
 */
export async function recordSkillUsage(filePath: string, nowIso?: string): Promise<void> {
  const stamp = (nowIso ?? new Date().toISOString()).trim()
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch {
    return
  }
  if (!raw.startsWith('---\n')) {
    return
  }
  const closeIndex = raw.indexOf('\n---\n', 4)
  if (closeIndex === -1) {
    return
  }
  const header = raw.slice(0, closeIndex + 1)
  const rest = raw.slice(closeIndex + 1)
  const replaced = header.replace(/^last_used_at:.*$/m, `last_used_at: ${stamp}`)
  const next = replaced === header
    ? `${header.trimEnd()}\nlast_used_at: ${stamp}\n${rest}`
    : `${replaced}${rest}`
  if (next === raw) {
    return
  }
  await fs.writeFile(filePath, next, { encoding: 'utf8', mode: 0o600 })
}

export async function loadSkillBody(skill: SkillMeta): Promise<string> {
  if (skill.source === 'builtin') {
    const bundledSkill = getBundledSkillByName(skill.name)
    if (!bundledSkill) {
      throw new Error(`Unknown built-in skill: ${skill.name}`)
    }
    return bundledSkill.body
  }

  const raw = await fs.readFile(skill.filePath, 'utf8')
  const parsed = parseFrontmatter(raw)
  rejectShellInjection(skill.filePath, parsed.body)
  return parsed.body.trim()
}

function rejectShellInjection(filePath: string, body: string): void {
  if (SHELL_INJECTION_RE.test(body)) {
    throw new Error(`Skill ${filePath} contains shell-injection syntax (!\`...\`), which is not allowed.`)
  }
}

async function warnIfLegacySkillDir(dir: string): Promise<void> {
  if (warnedLegacySkillDirs.has(dir)) {
    return
  }
  warnedLegacySkillDirs.add(dir)
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    if (entries.some(entry => entry.isDirectory())) {
      process.stderr.write(
        `skills: ${dir} is no longer scanned. Move reviewed skills to the owning user's per-user skill directory.\n`,
      )
    }
  } catch {
    // Missing or unreadable legacy directories are ignored.
  }
}
