import type { LoadedSkill } from '../types.js'

export const rememberSkill: LoadedSkill = {
  name: 'remember',
  description: [
    'Persist or review durable facts the user wants remembered later.',
    'TRIGGER when the user explicitly says remember / do not forget / save this preference, or asks to organize durable memory.',
    'SKIP when the user is only narrating context without asking to preserve it, or when the fact is temporary.',
  ].join('\n'),
  whenToUse: 'The user clearly wants a durable memory saved or reviewed.',
  userInvocable: true,
  allowedTools: ['MemoryRead', 'MemoryWrite', 'Read', 'Grep', 'Glob'],
  source: 'builtin',
  filePath: 'builtin:remember',
  body: [
    '# Remember',
    '',
    'Review the current memory set and improve its signal-to-noise ratio.',
    '',
    '## Process',
    '1. Gather project memory and auto-memory entries.',
    '2. Classify each item as keep, revise, promote to LIGHTCLAW.md, or delete.',
    '3. Explain why each action is appropriate.',
    '4. Ask for confirmation before destructive cleanup if the user did not explicitly request it.',
    '',
    '## Guidance',
    '- Preserve stable conventions and durable preferences.',
    '- Remove stale, temporary, or redundant notes.',
    '- Prefer concise durable memory over long transcripts or task-specific noise.',
  ].join('\n'),
}
