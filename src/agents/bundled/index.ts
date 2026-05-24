import type { Role } from '../types.js'
import { archivistPrompt } from './archivist.js'
import { coderPrompt } from './coder.js'
import { feishuSecretaryPrompt } from './feishuSecretary.js'
import { generalistPrompt } from './generalist.js'
import { localExplorerPrompt } from './localExplorer.js'
import { memoryCuratorPrompt } from './memoryCurator.js'
import { memoryExtractorPrompt } from './memoryExtractor.js'
import { mainPrompt } from './main.js'
import { reviewerPrompt } from './reviewer.js'
import { skillConsolidatorPrompt } from './skillConsolidator.js'
import { skillCuratorPrompt } from './skillCurator.js'
import { webSearcherPrompt } from './webSearcher.js'

export const BUNDLED_AGENTS: Role[] = [
  {
    agentType: 'main',
    name: 'main',
    whenToUse: 'Primary user-facing orchestrator.',
    tools: ['*'],
    skills: ['remember', 'skillify'],
    mcpServers: ['*'],
    // Main reaches every worker, including user-defined roles loaded from
    // `<lightclawHome>/roles/<name>/ROLE.md`. `isDispatchTargetReachable`
    // and `formatReachableRolesSection` expand '*' against the live registry
    // and filter to worker kind, so bundled and user-defined workers are
    // treated symmetrically. Phase 7 chain guards (depth / cycle /
    // privilege monotonic) still apply.
    reachableRoles: ['*'],
    hooks: ['*'],
    systemPrompt: mainPrompt,
    kind: 'orchestrator',
    outputContract: 'report',
  },
  {
    agentType: 'generalist',
    whenToUse:
      'Multi-step research, ambiguous searches, or tasks that may span many files. Self-tracks progress via TodoWrite for complex chains; saves durable findings via MemoryWrite.',
    // Wildcard covers default tool surface; Dispatch must be explicit per the
    // BLOCKED_WORKER_TOOLS gate (`explicitlyReachableDispatch` requires the
    // literal name in tools, not the wildcard). The three management tools
    // are listed alongside Dispatch as a self-documenting "dispatcher
    // capability" cluster even though wildcard would also reach them.
    tools: ['*', 'Dispatch', 'ListDispatches', 'CancelDispatch', 'UpdateDispatch'],
    skills: ['remember'],
    reachableRoles: ['coder', 'feishuSecretary', 'localExplorer', 'webSearcher'],
    systemPrompt: generalistPrompt,
    kind: 'worker',
    displayName: { cn: '正在处理', en: 'working on it' },
  },
  {
    agentType: 'localExplorer',
    whenToUse:
      'Fast read-only local exploration: files and directories, codebase contents, system state (processes, env vars, conda envs, disk usage, package versions), config files, log files. Read-only — no modifications.',
    tools: ['Bash', 'Read', 'Grep', 'Glob', 'MemoryWrite', 'MemoryRead', 'TodoWrite'],
    hooks: ['auto-compact', 'split-render', 'prompt-too-long-retry', 'memory-nudge', 'auto-memory-extract'],
    systemPrompt: localExplorerPrompt,
    kind: 'worker',
    displayName: { cn: '正在查本地资料', en: 'searching local files' },
  },
  {
    agentType: 'webSearcher',
    whenToUse:
      'Web retrieval using WebFetch + WebSearch. Dispatch when you need current info from the web — a specific question, fact, or document. The subagent digs as deep as needed to fully answer that one question (multi-hop search, cross-source verification, downloaded files surfaced with local paths, Grep over downloaded PDFs / HTMLs for specific facts when full read is too expensive), but does not drift into adjacent topics or interpret meaning. For lateral coverage across different topics, dispatch multiple separate web calls (in parallel when independent).',
    tools: ['WebFetch', 'WebSearch', 'Read', 'Grep', 'Glob', 'MemoryWrite', 'MemoryRead', 'TodoWrite'],
    hooks: ['auto-compact', 'split-render', 'prompt-too-long-retry', 'memory-nudge', 'auto-memory-extract'],
    systemPrompt: webSearcherPrompt,
    kind: 'worker',
    outputContract: 'report',
    displayName: { cn: '正在搜索互联网', en: 'searching the web' },
  },
  {
    agentType: 'feishuSecretary',
    whenToUse:
      'Feishu cloud-doc / cloud-space content lifecycle: read a doc, append to a sheet, create new docs / files, write doc content. Dispatch when the task involves new content authoring or content edits on Feishu resources (pasted URLs or workspace-scoped tokens). For pure structure operations (move / delete / create folder) without new content, archivist is also viable. The subagent handles permission grants and ancestry checks; you get back tokens, URLs, and permission outcomes.',
    description:
      'Feishu cloud-doc / cloud-space content specialist (creates + writes; pair with archivist for pure structure ops).',
    tools: [
      'FeishuRead',
      'FeishuWriteDoc',
      'FeishuWriteSheet',
      'FeishuCreateFile',
      'FeishuList',
      'FeishuCreateFolder',
      'FeishuMove',
      'FeishuDelete',
      'Read',
      'Grep',
      'Glob',
      'MemoryWrite',
      'MemoryRead',
      'TodoWrite',
      'Dispatch',
      'ListDispatches',
      'CancelDispatch',
      'UpdateDispatch',
    ],
    reachableRoles: ['localExplorer', 'webSearcher'],
    systemPrompt: feishuSecretaryPrompt,
    kind: 'worker',
    outputContract: 'report',
    displayName: { cn: '正在处理飞书文档', en: 'working on Feishu docs' },
  },
  {
    agentType: 'coder',
    whenToUse:
      'Coding heavy lifting: implement a feature, fix a bug, refactor a module, add a test. Dispatch when the task is bounded to code change in the current repo. The subagent plans, edits, runs verification (typecheck / tests / build), self-tracks multi-step progress via TodoWrite, persists durable project conventions via MemoryWrite (build commands, fixture locations, naming patterns), and reports back files touched + verification outcomes.',
    description:
      'Coding specialist (Read/Write/Edit/Grep/Glob/Bash + memory for project conventions).',
    tools: ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash', 'MemoryWrite', 'MemoryRead', 'TodoWrite', 'UseSkill', 'Dispatch', 'ListDispatches', 'CancelDispatch', 'UpdateDispatch'],
    skills: ['remember'],
    reachableRoles: ['localExplorer', 'webSearcher'],
    systemPrompt: coderPrompt,
    kind: 'worker',
    outputContract: 'report',
    displayName: { cn: '正在改代码', en: 'editing code' },
  },
  {
    agentType: 'archivist',
    whenToUse:
      'Cross-domain organization on the user\'s local system and Feishu workspace: deduplicate / classify / age out / index / clean up files on disk, runtime environments (conda envs, pip packages, virtualenvs, npm caches), or Feishu workspace structure (create classification folders, move docs, delete unneeded). Dispatch when the task is bounded to organizing existing resources (no new content authoring, no env setup from scratch). Creating Feishu documents or writing doc content is feishuSecretary\'s territory; archivist only restructures and prunes.',
    description:
      'Cross-domain archivist (local fs + runtime envs + Feishu structure operations: create folder / move / delete).',
    tools: [
      'Read',
      'Write',
      'Edit',
      'Grep',
      'Glob',
      'Bash',
      'FeishuRead',
      'FeishuList',
      'FeishuCreateFolder',
      'FeishuMove',
      'FeishuDelete',
      'MemoryWrite',
      'MemoryRead',
      'TodoWrite',
      'UseSkill',
      'Dispatch',
      'ListDispatches',
      'CancelDispatch',
      'UpdateDispatch',
    ],
    skills: ['remember'],
    reachableRoles: ['feishuSecretary', 'localExplorer', 'webSearcher'],
    systemPrompt: archivistPrompt,
    kind: 'worker',
    outputContract: 'report',
    displayName: { cn: '正在整理资料', en: 'organizing files' },
  },
  {
    agentType: 'reviewer',
    whenToUse:
      'Pre-delivery sanity check: review a code change, written report, organized data, or any artifact the requester is about to hand to the user. Dispatch when the task is "find issues" (not "fix them"). The subagent reads the artifact end-to-end, runs cheap static checks (typecheck / lint / test), applies any persisted user-specific review standards from memory (verifying each is still current before failing on it), groups findings by severity (blocker / important / nit), and returns a structured report with a ship / fix-first / needs-more-info verdict.',
    description:
      'Pre-delivery review specialist (read-only artifact survey; memory for review standards; may dispatch coder ONCE per pass for small in-line fix, otherwise returns issues to requester).',
    tools: ['Read', 'Grep', 'Glob', 'Bash', 'FeishuRead', 'FeishuList', 'MemoryWrite', 'MemoryRead', 'TodoWrite', 'UseSkill', 'Dispatch', 'ListDispatches', 'CancelDispatch', 'UpdateDispatch'],
    skills: ['remember'],
    reachableRoles: ['coder', 'feishuSecretary', 'localExplorer', 'webSearcher'],
    systemPrompt: reviewerPrompt,
    kind: 'worker',
    outputContract: 'report',
    displayName: { cn: '正在复核', en: 'reviewing' },
  },
  {
    agentType: 'memoryExtractor',
    whenToUse: 'Internal: framework-managed memory extraction after each main turn.',
    tools: ['MemoryWrite', 'MemoryRead', 'Read', 'Grep', 'Glob'],
    systemPrompt: memoryExtractorPrompt,
    kind: 'internal',
    outputContract: 'side-effect',
  },
  {
    agentType: 'memoryCurator',
    whenToUse: 'Internal: framework-managed memory consolidation.',
    tools: ['MemoryRead', 'MemoryWriteAt', 'MemoryMove', 'MemoryDelete', 'Read', 'Grep', 'Glob'],
    systemPrompt: memoryCuratorPrompt,
    kind: 'internal',
    outputContract: 'side-effect',
  },
  {
    agentType: 'skillCurator',
    whenToUse: 'Internal: framework-managed per-role skill discovery.',
    tools: ['SkillWrite', 'Read', 'Grep', 'Glob'],
    systemPrompt: skillCuratorPrompt,
    kind: 'internal',
    outputContract: 'side-effect',
  },
  {
    agentType: 'skillConsolidator',
    whenToUse: 'Internal: framework-managed per-user skill consolidation.',
    tools: ['SkillWrite', 'SkillDelete', 'Read'],
    systemPrompt: skillConsolidatorPrompt,
    kind: 'internal',
    outputContract: 'side-effect',
  },
]
