import { chmod, mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { userSkillsRoot } from '../identity/paths.js'
import { parseFrontmatter } from '../memory/auto-memory.js'
import { lightclawHome } from '../paths.js'
import type { LoadedSkill, SkillMeta, SkillSource } from './types.js'
import { bundledSkills, getBundledSkillByName } from './bundled/index.js'

const warnedLegacySkillDirs = new Set<string>()
const warnedCollisionSkills = new Set<string>()
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const ROLE_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const SHELL_INJECTION_RE = /!\s*`[^`]*`/

function toSkillMeta(skill: LoadedSkill): SkillMeta {
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
    throw new Error(`Skill ${filePath} frontmatter "roles" must be a YAML list of role names.`)
  }
  const roles = value.map(role => role.trim())
  if (roles.length === 0 || roles.some(role => role.length === 0)) {
    throw new Error(`Skill ${filePath} frontmatter "roles" must contain at least one role name.`)
  }
  for (const role of roles) {
    if (!ROLE_NAME_RE.test(role)) {
      throw new Error(`Skill ${filePath} frontmatter "roles" contains invalid role name "${role}".`)
    }
  }
  return roles
}

async function loadSkillsFromDirectory(
  rootDir: string,
  source: SkillSource,
): Promise<SkillMeta[]> {
  try {
    const entries = await readdir(rootDir, { withFileTypes: true })
    const skills = await Promise.all(
      entries
        .filter(entry => entry.isDirectory())
        .map(async entry => {
          const filePath = path.join(rootDir, entry.name, 'SKILL.md')
          try {
            const raw = await readFile(filePath, 'utf8')
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

  if (!input.overwrite) {
    try {
      await readFile(filePath, 'utf8')
      throw new Error(`Skill "${name}" already exists. Set overwrite=true to replace it.`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
  }

  await mkdir(skillDir, { recursive: true, mode: 0o700 })
  await writeFile(filePath, input.markdown, { encoding: 'utf8', mode: 0o600 })
  await chmod(filePath, 0o600)
  return meta
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
    await unlink(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Skill "${name}" does not exist in the current user's skill set.`)
    }
    throw error
  }
  await rm(skillDir, { recursive: true, force: true })
  return { name, filePath }
}

export async function loadSkillBody(skill: SkillMeta): Promise<string> {
  if (skill.source === 'builtin') {
    const bundledSkill = getBundledSkillByName(skill.name)
    if (!bundledSkill) {
      throw new Error(`Unknown built-in skill: ${skill.name}`)
    }
    return bundledSkill.body
  }

  const raw = await readFile(skill.filePath, 'utf8')
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
    const entries = await readdir(dir, { withFileTypes: true })
    if (entries.some(entry => entry.isDirectory())) {
      process.stderr.write(
        `skills: ${dir} is no longer scanned. Move reviewed skills to the owning user's per-user skill directory.\n`,
      )
    }
  } catch {
    // Missing or unreadable legacy directories are ignored.
  }
}
