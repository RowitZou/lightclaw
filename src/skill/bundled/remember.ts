import type { LoadedSkill } from '../types.js'

export const rememberSkill: LoadedSkill = {
  name: 'remember',
  description: [
    'Persist or review durable facts the user wants remembered across sessions — what / when / who / which / a preference / a decision.',
    'TRIGGER when the user explicitly says remember / do not forget / 记一下 / save this preference, or hands over a fact worth preserving.',
    'SKIP when the request is about how to run a recurring workflow (that is the `skillify` skill), or when the fact is temporary.',
  ].join('\n'),
  whenToUse:
    "Use when the requester wants a durable FACT saved or reviewed — what / when / who / which / a preference / a decision / a constraint. Explicit ('remember that …', '记一下 …') or implicit when the request hands over a fact worth preserving across sessions. Skip if the request is about HOW to run a recurring workflow (use `skillify` instead) or if the content is temporary task state.",
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
