import path from 'node:path'
import { rm, readFile } from 'node:fs/promises'

import { userSkillsRoot } from '../identity/paths.js'
import { discoverSkillsForUser, normalizeSkillName } from '../skill/loader.js'
import { getBundledSkillByName } from '../skill/bundled/index.js'

export async function runSkillCommand(args: string, input: {
  userId?: string
  cwd: string
}): Promise<string> {
  const userId = input.userId
  if (!userId) {
    return 'No active LightClaw identity; /skill requires a paired user.\n'
  }
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const action = (parts.shift() ?? 'list').toLowerCase()
  switch (action) {
    case 'list':
      return formatSkillList(await discoverSkillsForUser(input.cwd, userId))
    case 'view':
      return await viewSkill(userId, input.cwd, parts[0])
    case 'delete':
      return await deleteSkill(userId, parts[0])
    default:
      return skillUsage()
  }
}

function skillUsage(): string {
  return [
    'Usage:',
    '  /skill list',
    '  /skill view <name>',
    '  /skill delete <name>',
    '',
  ].join('\n')
}

function formatSkillList(skills: Awaited<ReturnType<typeof discoverSkillsForUser>>): string {
  if (skills.length === 0) return 'No skills found.\n'
  return `${[
    'Skills:',
    ...skills.map(skill => `  ${skill.name} source=${skill.source} - ${skill.description}`),
    '',
  ].join('\n')}`
}

async function viewSkill(userId: string, cwd: string, rawName: string | undefined): Promise<string> {
  if (!rawName) return skillUsage()
  const name = normalizeSkillName(rawName)
  const skill = (await discoverSkillsForUser(cwd, userId)).find(candidate => candidate.name === name)
  if (!skill) return `Skill "${name}" not found.\n`
  const raw = await readFile(skill.filePath, 'utf8')
  return `${raw}\n`
}

async function deleteSkill(userId: string, rawName: string | undefined): Promise<string> {
  if (!rawName) return skillUsage()
  const name = normalizeSkillName(rawName)
  if (getBundledSkillByName(name)) {
    return `Skill "${name}" is bundled and cannot be deleted.\n`
  }
  const dir = path.join(userSkillsRoot(userId), name)
  await rm(dir, { recursive: true, force: true })
  return `Deleted user skill "${name}" if it existed.\n`
}
