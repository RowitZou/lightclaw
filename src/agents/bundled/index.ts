import type { Role } from '../types.js'
import { memoryCuratorPrompt } from './memoryCurator.js'
import { localExplorerPrompt } from './localExplorer.js'
import { memoryExtractorPrompt } from './memoryExtractor.js'
import { generalistPrompt } from './generalist.js'
import { mainPrompt } from './main.js'
import { webSearcherPrompt } from './webSearcher.js'

export const BUNDLED_AGENTS: Role[] = [
  {
    agentType: 'main',
    name: 'main',
    whenToUse:
      'Primary user-facing orchestrator. Not dispatchable through AgentTool.',
    tools: ['*'],
    skills: ['*'],
    mcpServers: ['*'],
    reachableRoles: ['generalist', 'localExplorer', 'webSearcher'],
    hooks: ['*'],
    systemPrompt: mainPrompt,
    kind: 'orchestrator',
    outputContract: 'report',
  },
  {
    agentType: 'generalist',
    whenToUse:
      'Multi-step research, ambiguous searches, or tasks that may span many files.',
    tools: ['*'],
    systemPrompt: generalistPrompt,
    kind: 'worker',
  },
  {
    agentType: 'localExplorer',
    whenToUse:
      'Fast read-only codebase exploration: find files, grep symbols, understand structure.',
    tools: ['Bash', 'Read', 'Grep', 'Glob'],
    systemPrompt: localExplorerPrompt,
    kind: 'worker',
  },
  {
    agentType: 'webSearcher',
    whenToUse:
      'Web retrieval using WebFetch + WebSearch. Dispatch when you need current info from the web — a specific question, fact, or document. The subagent digs as deep as needed to fully answer that one question (multi-hop search, cross-source verification, downloaded files surfaced with local paths), but does not drift into adjacent topics or interpret meaning. For lateral coverage across different topics, dispatch multiple separate web calls (in parallel when independent).',
    tools: ['WebFetch', 'WebSearch', 'Read', 'MemoryWrite', 'MemoryRead'],
    systemPrompt: webSearcherPrompt,
    kind: 'worker',
    outputContract: 'report',
  },
  {
    agentType: 'memoryExtractor',
    whenToUse:
      'Internal: framework-managed memory extraction after each main turn. Not dispatchable via AgentTool.',
    tools: ['MemoryWrite', 'MemoryRead', 'Read', 'Grep', 'Glob'],
    systemPrompt: memoryExtractorPrompt,
    maxTurns: 20,
    kind: 'internal',
    outputContract: 'side-effect',
  },
  {
    agentType: 'memoryCurator',
    whenToUse:
      'Internal: framework-managed memory consolidation (autoDream). Not dispatchable via AgentTool.',
    tools: ['MemoryRead', 'MemoryWriteAt', 'MemoryMove', 'MemoryDelete', 'Read', 'Grep', 'Glob'],
    systemPrompt: memoryCuratorPrompt,
    kind: 'internal',
    outputContract: 'side-effect',
  },
]
