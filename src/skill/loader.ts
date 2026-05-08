import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { parseFrontmatter } from '../memory/auto-memory.js'
import { lightclawHome } from '../paths.js'
import type { LoadedSkill, SkillMeta, SkillSource } from './types.js'
import { bundledSkills, getBundledSkillByName } from './bundled/index.js'

const warnedLegacySkillDirs = new Set<string>()

function toBoolean(value: string | string[] | undefined, fallback: boolean): boolean {
  if (typeof value !== 'string') {
    return fallback
  }

  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(normalized)) {
    return true
  }
  if (['false', '0', 'no', 'off'].includes(normalized)) {
    return false
  }
  return fallback
}

function toSkillMeta(skill: LoadedSkill): SkillMeta {
  return {
    name: skill.name,
    description: skill.description,
    whenToUse: skill.whenToUse,
    userInvocable: skill.userInvocable,
    allowedTools: skill.allowedTools,
    source: skill.source,
    filePath: skill.filePath,
  }
}

function parseSkillFrontmatter(
  filePath: string,
  source: SkillSource,
  frontmatter: Record<string, string | string[]>,
): SkillMeta | null {
  const name = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : ''
  const description =
    typeof frontmatter.description === 'string'
      ? frontmatter.description.trim()
      : ''

  if (!name || !description) {
    return null
  }

  return {
    name,
    description,
    whenToUse:
      typeof frontmatter.when_to_use === 'string'
        ? frontmatter.when_to_use.trim()
        : undefined,
    userInvocable: toBoolean(frontmatter.user_invocable, true),
    allowedTools: Array.isArray(frontmatter.allowed_tools)
      ? frontmatter.allowed_tools.map(value => value.trim()).filter(Boolean)
      : undefined,
    source,
    filePath,
  }
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
  const skillMap = new Map<string, SkillMeta>()

  for (const bundledSkill of bundledSkills) {
    skillMap.set(bundledSkill.name, toSkillMeta(bundledSkill))
  }

  for (const skill of await loadSkillsFromDirectory(
    path.join(lightclawHome(), 'skills'),
    'user',
  )) {
    skillMap.set(skill.name, skill)
  }

  void warnIfLegacySkillDir(path.join(path.resolve(cwd), '.lightclaw', 'skills'))

  return [...skillMap.values()].sort((left, right) => left.name.localeCompare(right.name))
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
  return parseFrontmatter(raw).body.trim()
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
        `skills: ${dir} is no longer scanned. Move reviewed skills to ${path.join(lightclawHome(), 'skills')}/\n`,
      )
    }
  } catch {
    // Missing or unreadable legacy directories are ignored.
  }
}
