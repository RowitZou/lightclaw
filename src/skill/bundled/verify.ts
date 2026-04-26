import type { LoadedSkill } from '../types.js'

export const verifySkill: LoadedSkill = {
  name: 'verify',
  description: [
    'Run relevant validation commands and confirm whether the change actually works.',
    'TRIGGER when code or state changed, before reporting a complex task complete, or when the user asks to verify / double-check / sanity check.',
    'SKIP when the task is read-only, no meaningful validation exists, or validation already ran in this turn.',
  ].join('\n'),
  whenToUse: 'Code or state changed and validation would increase confidence.',
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
