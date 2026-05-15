import type { Role } from '../types.js'
import { autoDreamPrompt } from './auto-dream.js'
import { explorePrompt } from './explore.js'
import { extractMemoriesPrompt } from './extract-memories.js'
import { generalPurposePrompt } from './general-purpose.js'

export const BUNDLED_AGENTS: Role[] = [
  {
    agentType: 'general-purpose',
    whenToUse:
      'Multi-step research, ambiguous searches, or tasks that may span many files.',
    tools: ['*'],
    systemPrompt: generalPurposePrompt,
    kind: 'worker',
  },
  {
    agentType: 'explore',
    whenToUse:
      'Fast read-only codebase exploration: find files, grep symbols, understand structure.',
    tools: ['Bash', 'Read', 'Grep', 'Glob'],
    systemPrompt: explorePrompt,
    kind: 'worker',
  },
  {
    agentType: 'extract_memories',
    whenToUse:
      'Internal: framework-managed memory extraction after each main turn. Not dispatchable via AgentTool.',
    tools: ['MemoryWrite', 'MemoryRead', 'Read', 'Grep', 'Glob'],
    systemPrompt: extractMemoriesPrompt,
    maxTurns: 20,
    kind: 'internal',
    outputContract: 'side-effect',
  },
  {
    agentType: 'auto_dream',
    whenToUse:
      'Internal: framework-managed memory consolidation (autoDream). Not dispatchable via AgentTool.',
    tools: ['MemoryWrite', 'MemoryRead', 'Read', 'Grep', 'Glob', 'Bash'],
    systemPrompt: autoDreamPrompt,
    kind: 'internal',
    outputContract: 'side-effect',
  },
]
