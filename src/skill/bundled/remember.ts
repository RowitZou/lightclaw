import type { LoadedSkill } from '../types.js'

export const rememberSkill: LoadedSkill = {
  name: 'remember',
  description: 'Review persistent memory, decide what should be kept, promoted, or removed, and present the result clearly.',
  whenToUse: 'When the user asks to organize memory, preserve conventions, or review durable notes.',
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