import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { getConfig } from '../config.js'
import { userSkillsRoot, identityRoot, sanitizePathSegment } from '../identity/paths.js'
import { parseFrontmatter } from '../memory/auto-memory.js'
import { findUseSkillReferences } from './composition-graph.js'
import { discoverSkillsForUser, normalizeSkillName } from './loader.js'

export type CompositionParentJournalEntry = {
  name: string
  preBody: string
  postBody: string
  rewriteAt: string
  status: 'canary' | 'confirmed' | 'rolled-back'
  dormantPasses: number
}

export type CompositionJournalEntry =
  | {
      kind: 'compose'
      skill: string
      composedSub: string
      preBody: string
      postBody: string
      rewriteAt: string
      status: 'canary' | 'confirmed' | 'rolled-back'
      dormantPasses: number
    }
  | {
      kind: 'extract-new'
      newSub: string
      parents: CompositionParentJournalEntry[]
      createdAt: string
    }

export type CompositionJournalProcessResult = {
  confirmed: number
  rolledBack: number
  dormant: number
}

export function compositionJournalPath(userId: string): string {
  return path.join(
    identityRoot(),
    'per-user',
    sanitizePathSegment(userId),
    'composition-journal.jsonl',
  )
}

export async function appendCompositionJournalEntry(
  userId: string,
  entry: CompositionJournalEntry,
): Promise<void> {
  const file = compositionJournalPath(userId)
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await appendFile(file, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 })
}

export async function readCompositionJournal(
  userId: string,
): Promise<CompositionJournalEntry[]> {
  let raw: string
  try {
    raw = await readFile(compositionJournalPath(userId), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as CompositionJournalEntry)
}

export async function writeCompositionJournal(
  userId: string,
  entries: CompositionJournalEntry[],
): Promise<void> {
  const file = compositionJournalPath(userId)
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const data = entries.map(entry => JSON.stringify(entry)).join('\n')
  await writeFile(file, data ? `${data}\n` : '', { encoding: 'utf8', mode: 0o600 })
}

export function buildCompositionJournalEntry(input: {
  skill: string
  preBody: string
  postBody: string
  rewriteAt: string
  currentPassCreatedSkills?: ReadonlySet<string>
}): CompositionJournalEntry | undefined {
  const before = new Set(findUseSkillReferences(input.preBody))
  const introduced = findUseSkillReferences(input.postBody).filter(name => !before.has(name))
  const sub = introduced[0]
  if (!sub) return undefined
  if (input.currentPassCreatedSkills?.has(sub)) {
    return {
      kind: 'extract-new',
      newSub: sub,
      createdAt: input.rewriteAt,
      parents: [{
        name: input.skill,
        preBody: input.preBody,
        postBody: input.postBody,
        rewriteAt: input.rewriteAt,
        status: 'canary',
        dormantPasses: 0,
      }],
    }
  }
  return {
    kind: 'compose',
    skill: input.skill,
    composedSub: sub,
    preBody: input.preBody,
    postBody: input.postBody,
    rewriteAt: input.rewriteAt,
    status: 'canary',
    dormantPasses: 0,
  }
}

export async function processCompositionCanaries(
  userId: string,
  options: { maxDormantPasses?: number } = {},
): Promise<CompositionJournalProcessResult> {
  const entries = await readCompositionJournal(userId)
  const maxDormantPasses =
    Math.max(1, Math.floor(options.maxDormantPasses ?? getConfig().skills.maxDormantPasses))
  const skills = await discoverSkillsForUser(process.cwd(), userId)
  const lastUsed = new Map(skills.map(skill => [skill.name, skill.lastUsedAt]))

  let confirmed = 0
  let rolledBack = 0
  let dormant = 0
  const nextEntries: CompositionJournalEntry[] = []

  for (const entry of entries) {
    if (entry.kind === 'compose') {
      const next = await processParentCanary({
        userId,
        parentName: entry.skill,
        subName: entry.composedSub,
        preBody: entry.preBody,
        rewriteAt: entry.rewriteAt,
        status: entry.status,
        dormantPasses: entry.dormantPasses,
        maxDormantPasses,
        lastUsed,
        onRollback: async () => {
          await restoreSkillBody(userId, entry.skill, entry.preBody, entry.postBody)
        },
      })
      confirmed += next.delta.confirmed
      rolledBack += next.delta.rolledBack
      dormant += next.delta.dormant
      nextEntries.push({ ...entry, status: next.status, dormantPasses: next.dormantPasses })
      continue
    }

    let anyConfirmed = false
    const parents: CompositionParentJournalEntry[] = []
    for (const parent of entry.parents) {
      const next = await processParentCanary({
        userId,
        parentName: parent.name,
        subName: entry.newSub,
        preBody: parent.preBody,
        rewriteAt: parent.rewriteAt,
        status: parent.status,
        dormantPasses: parent.dormantPasses,
        maxDormantPasses,
        lastUsed,
        onRollback: async () => {
          await restoreSkillBody(userId, parent.name, parent.preBody, parent.postBody)
        },
      })
      confirmed += next.delta.confirmed
      rolledBack += next.delta.rolledBack
      dormant += next.delta.dormant
      if (next.status === 'confirmed') anyConfirmed = true
      parents.push({ ...parent, status: next.status, dormantPasses: next.dormantPasses })
    }
    if (!anyConfirmed && parents.every(parent => parent.status === 'rolled-back')) {
      await removeUserSkillDir(userId, entry.newSub)
    }
    nextEntries.push({ ...entry, parents })
  }

  await writeCompositionJournal(userId, nextEntries)
  return { confirmed, rolledBack, dormant }
}

async function processParentCanary(input: {
  userId: string
  parentName: string
  subName: string
  preBody: string
  rewriteAt: string
  status: 'canary' | 'confirmed' | 'rolled-back'
  dormantPasses: number
  maxDormantPasses: number
  lastUsed: Map<string, string | undefined>
  onRollback: () => Promise<void>
}): Promise<{
  status: 'canary' | 'confirmed' | 'rolled-back'
  dormantPasses: number
  delta: CompositionJournalProcessResult
}> {
  if (input.status !== 'canary') {
    return {
      status: input.status,
      dormantPasses: input.dormantPasses,
      delta: { confirmed: 0, rolledBack: 0, dormant: 0 },
    }
  }
  if (isAfter(input.lastUsed.get(input.subName), input.rewriteAt)) {
    return {
      status: 'confirmed',
      dormantPasses: input.dormantPasses,
      delta: { confirmed: 1, rolledBack: 0, dormant: 0 },
    }
  }
  if (isAfter(input.lastUsed.get(input.parentName), input.rewriteAt)) {
    await input.onRollback()
    return {
      status: 'rolled-back',
      dormantPasses: input.dormantPasses,
      delta: { confirmed: 0, rolledBack: 1, dormant: 0 },
    }
  }
  const dormantPasses = input.dormantPasses + 1
  if (dormantPasses >= input.maxDormantPasses) {
    return {
      status: 'confirmed',
      dormantPasses,
      delta: { confirmed: 1, rolledBack: 0, dormant: 0 },
    }
  }
  return {
    status: 'canary',
    dormantPasses,
    delta: { confirmed: 0, rolledBack: 0, dormant: 1 },
  }
}

function isAfter(value: string | undefined, baseline: string): boolean {
  const parsed = value ? Date.parse(value) : Number.NaN
  const base = Date.parse(baseline)
  return Number.isFinite(parsed) && Number.isFinite(base) && parsed > base
}

async function restoreSkillBody(
  userId: string,
  name: string,
  preBody: string,
  postBody: string,
): Promise<void> {
  const skillFile = path.join(userSkillsRoot(userId), normalizeSkillName(name), 'SKILL.md')
  const raw = await readFile(skillFile, 'utf8')
  const parsed = parseFrontmatter(raw)
  const currentBody = parsed.body.trim()
  // Already at the pre-rewrite body — nothing to restore.
  if (currentBody === preBody.trim()) return
  // Only roll back when the rewrite we journaled is still in place. If a later
  // pass (or any other writer) has since changed the body, restoring preBody
  // would clobber that newer edit — leave it and let the next signal decide.
  if (currentBody !== postBody.trim()) return
  const next = `${renderFrontmatter(raw)}\n${preBody.trimEnd()}\n`
  await writeFile(skillFile, next, { encoding: 'utf8', mode: 0o600 })
}

function renderFrontmatter(raw: string): string {
  const closeIndex = raw.indexOf('\n---\n', 4)
  if (raw.startsWith('---\n') && closeIndex !== -1) {
    return raw.slice(0, closeIndex + '\n---'.length)
  }
  return '---\nname: restored-skill\ndescription: Restored skill.\n---'
}

async function removeUserSkillDir(userId: string, name: string): Promise<void> {
  const skillDir = path.join(userSkillsRoot(userId), normalizeSkillName(name))
  const trash = `${skillDir}.composition-rollback-${Date.now()}`
  try {
    await rename(skillDir, trash)
    await rm(trash, { recursive: true, force: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}
