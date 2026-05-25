import path from 'node:path'

import { readSessionMemory } from '../memory/session-memory.js'
import { getCurrentSessionContext } from '../session-context.js'
import { loadTranscriptFile } from '../session/storage.js'
import type { Message, UserContentBlock } from '../types.js'
import { toolResultContentToText } from '../types.js'
import { discoverSkillsForUser, loadSkillBody } from './loader.js'
import { skillDirFor } from './skill-dir.js'
import type { LoadedSkill, SkillMeta } from './types.js'

let skillRegistry = new Map<string, SkillMeta>()

export async function refreshSkillRegistry(cwd: string, userId?: string): Promise<SkillMeta[]> {
  const skills = await discoverSkillsForUser(cwd, userId)
  skillRegistry = new Map(skills.map(skill => [skill.name, skill]))
  return listRegisteredSkills()
}

export function listRegisteredSkills(): SkillMeta[] {
  return [...skillRegistry.values()].sort((left, right) => left.name.localeCompare(right.name))
}

export function getRegisteredSkill(name: string): SkillMeta | null {
  return skillRegistry.get(name) ?? null
}

export async function loadRegisteredSkill(name: string): Promise<LoadedSkill | null> {
  const skill = getRegisteredSkill(name)
  if (!skill) {
    return null
  }

  return {
    ...skill,
    body: await loadSkillBody(skill),
  }
}

export async function buildRegisteredSkillInvocation(
  name: string,
  args?: string,
): Promise<string | null> {
  const loadedSkill = await loadRegisteredSkill(name)
  if (!loadedSkill) {
    return null
  }

  const sections = [
    `Use the skill \"${loadedSkill.name}\" and follow its instructions for this task.`,
  ]

  if (loadedSkill.whenToUse) {
    sections.push(`When to use: ${loadedSkill.whenToUse}`)
  }

  if (args?.trim()) {
    sections.push(`Skill arguments:\n${args.trim()}`)
  }

  sections.push(await replaceSkillTemplateVariables(
    replaceSkillArguments(loadedSkill.body.trim(), args),
    loadedSkill,
  ))
  return sections.join('\n\n')
}

function replaceSkillArguments(body: string, args?: string): string {
  return body.replaceAll('$ARGUMENTS', args?.trim() ?? '')
}

async function replaceSkillTemplateVariables(body: string, meta: SkillMeta): Promise<string> {
  const hasCurlyPair = body.includes('{{')
  const hasShellStyle = body.includes('${LIGHTCLAW_SKILL_DIR}')
  if (!hasCurlyPair && !hasShellStyle) {
    return body
  }

  const next = hasShellStyle
    ? body.replaceAll('${LIGHTCLAW_SKILL_DIR}', skillDirFor(meta))
    : body

  if (!hasCurlyPair) {
    return next
  }

  const context = await buildSkillTemplateContext()
  return next
    .replaceAll('{{sessionMemory}}', context.sessionMemory)
    .replaceAll('{{userMessages}}', context.userMessages)
    .replaceAll('{{userDescriptionBlock}}', context.userDescriptionBlock)
}

async function buildSkillTemplateContext(): Promise<{
  sessionMemory: string
  userMessages: string
  userDescriptionBlock: string
}> {
  const session = getCurrentSessionContext()
  if (!session) {
    return {
      sessionMemory: '[empty]',
      userMessages: '[unavailable outside a session]',
      userDescriptionBlock: 'for this user',
    }
  }

  const [sessionMemory, messages] = await Promise.all([
    readSessionMemory(session.sessionId, session.sessionsDir),
    loadTranscriptFile(path.join(session.sessionsDir, session.sessionId, 'transcript.jsonl')),
  ])

  return {
    sessionMemory: sessionMemory.trim() || '[empty]',
    userMessages: formatUserMessages(messages),
    userDescriptionBlock: session.currentUserId ? `for ${session.currentUserId}` : 'for this user',
  }
}

function formatUserMessages(messages: Message[]): string {
  const lines = messages
    .filter((message): message is Extract<Message, { type: 'user' }> => message.type === 'user')
    .map((message, index) => {
      const text = userContentToText(message.message.content).trim()
      return text.length > 0 ? `${index + 1}. ${text}` : ''
    })
    .filter(Boolean)

  return lines.length > 0 ? lines.join('\n\n') : '[empty]'
}

function userContentToText(content: string | UserContentBlock[]): string {
  if (typeof content === 'string') {
    return content
  }

  return content
    .map(block => {
      if (block.type === 'text') {
        return block.text
      }
      if (block.type === 'image') {
        return `[Image: ${block.source.mediaType}]`
      }
      if (block.type === 'document') {
        return `[Document: ${block.source.mediaType}]`
      }
      return `[Tool result]\n${toolResultContentToText(block.content)}`
    })
    .filter(Boolean)
    .join('\n')
}
