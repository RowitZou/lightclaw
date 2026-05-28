import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

import { resolveAuditDir } from '../config.js'

/** Per-user skill mutation audit. SkillWrite / SkillDelete are the surfaces
 *  skillCurator + skillConsolidator (and any worker carrying the skillify
 *  workflow) use to mutate a user's skill set. Pre-2026-05-28 these wrote
 *  nothing to disk audit — the 5/26 §1 incident (skillConsolidator SkillDelete
 *  silently removing a user skill) was invisible to post-hoc audit and had to
 *  be reconstructed from fork transcripts. This module makes every skill
 *  mutation greppable under `audit/skill-ops/<YYYY-MM-DD>.jsonl`, the same
 *  per-domain layout as `memory-writes` / `feishu-writes` / `secret-ops`. */
export type SkillOpAudit = {
  at: string
  userId: string | undefined
  tool: 'SkillWrite' | 'SkillDelete'
  name: string
  /** Absolute on-disk SKILL.md path. Present on success; omitted when the op
   *  never reached the filesystem (no identity, guard refusal, bad name). */
  filePath?: string
  /** `written` / `deleted` = the mutation landed; `denied` = a guard or
   *  identity precondition refused before touching disk; `failed` = an
   *  unexpected error after the op was attempted. */
  status: 'written' | 'deleted' | 'denied' | 'failed'
  reason?: string
}

export async function recordSkillOpAudit(record: SkillOpAudit): Promise<void> {
  const dir = path.join(resolveAuditDir(), 'skill-ops')
  await mkdir(dir, { recursive: true })
  const day = record.at.slice(0, 10)
  await appendFile(path.join(dir, `${day}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8')
}
