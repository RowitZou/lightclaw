import type { LoadedSkill } from '../types.js'

export const verifySkill: LoadedSkill = {
  name: 'verify',
  description: 'Run relevant validation commands and confirm whether the change actually works.',
  whenToUse: 'After code changes, before reporting completion, or when the user asks for validation.',
  userInvocable: true,
  allowedTools: ['Bash', 'Read', 'Grep', 'Glob'],
  source: 'builtin',
  filePath: 'builtin:verify',
  body: [
    '# Verify',
    '',
    'Validate the current change set instead of assuming it works.',
    '',
    '## Process',
    '1. Identify the most relevant validation commands for this repository.',
    '2. Run the narrowest command that gives meaningful confidence first.',
    '3. If validation fails, inspect the error, fix the issue if it is clearly within scope, and rerun.',
    '4. Summarize what was validated, what passed, what failed, and any remaining gaps.',
    '',
    '## Guidance',
    '- Prefer project-native commands from package.json, Makefile, or repo docs.',
    '- Avoid broad or slow commands when a targeted command is enough.',
    '- Do not claim success without running at least one relevant check when validation is possible.',
  ].join('\n'),
}