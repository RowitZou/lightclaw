import type { Role } from '../types.js'
import { autoDreamPrompt } from './auto-dream.js'
import { explorePrompt } from './explore.js'
import { extractMemoriesPrompt } from './extract-memories.js'
import { generalPurposePrompt } from './general-purpose.js'
import { mainPrompt } from './main.js'
import { webPrompt } from './web.js'

export const BUNDLED_AGENTS: Role[] = [
  {
    agentType: 'main',
    name: 'main',
    whenToUse:
      'Primary user-facing orchestrator. Not dispatchable through AgentTool.',
    tools: ['*'],
    skills: ['*'],
    mcpServers: ['*'],
    reachableRoles: ['general-purpose', 'explore', 'web'],
    hooks: ['*'],
    systemPrompt: mainPrompt,
    kind: 'orchestrator',
    outputContract: 'report',
  },
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
    agentType: 'web',
    whenToUse:
      'Web retrieval using WebFetch + WebSearch. Dispatch when you need current info from the web — a specific question, fact, or document. The subagent digs as deep as needed to fully answer that one question (multi-hop search, cross-source verification, downloaded files surfaced with local paths), but does not drift into adjacent topics or interpret meaning. For lateral coverage across different topics, dispatch multiple separate web calls (in parallel when independent).',
    tools: ['WebFetch', 'WebSearch', 'Read', 'MemoryWrite', 'MemoryRead'],
    systemPrompt: webPrompt,
    kind: 'worker',
    outputContract: 'report',
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
    tools: ['MemoryRead', 'MemoryWriteAt', 'MemoryMove', 'MemoryDelete', 'Read', 'Grep', 'Glob'],
    systemPrompt: autoDreamPrompt,
    kind: 'internal',
    outputContract: 'side-effect',
  },
]
