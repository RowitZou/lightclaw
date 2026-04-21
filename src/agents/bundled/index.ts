import type { AgentDefinition } from '../types.js'
import { explorePrompt } from './explore.js'
import { generalPurposePrompt } from './general-purpose.js'

export const BUNDLED_AGENTS: AgentDefinition[] = [
  {
    agentType: 'general-purpose',
    whenToUse:
      'Multi-step research, ambiguous searches, or tasks that may span many files.',
    tools: ['*'],
    systemPrompt: generalPurposePrompt,
    maxTurns: 30,
  },
  {
    agentType: 'explore',
    whenToUse:
      'Fast read-only codebase exploration: find files, grep symbols, understand structure.',
    tools: ['Bash', 'Read', 'Grep', 'Glob'],
    systemPrompt: explorePrompt,
    maxTurns: 20,
  },
]
