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
    // Read-only manager surface (PR19 / M1): read + inspect + ledger +
    // dispatch family + presentation (SendFile / Notify / AskUserQuestion).
    // No execution face (Bash / Write / Edit / web) — execution is dispatched;
    // no Feishu WRITE face (D7) — doc authoring goes to feishuSecretary.
    tools: [
      'Read', 'Grep', 'Glob', 'ToolSearch',
      'TodoWrite', 'MemoryRead', 'MemoryWrite', 'UseSkill',
      'TaskCreate', 'TaskUpdate', 'TaskInspect',
      'Dispatch', 'UpdateSchedule', 'Message',
      'Sleep', 'AskUserQuestion', 'Notify', 'SendFile',
      'FeishuRead', 'FeishuList',
      // skillify needs the write half; SkillDelete stays withheld from the
      // interactive surface (deletes are routed to the curation pipeline).
      'SkillWrite',
      'ShowSlashCatalog',
    ],
    skills: ['remember', 'skillify', 'delivery-orchestration'],
    // Explicitly empty (PR19): no MCP server is configured today, and a
    // wildcard here would silently hand main every tool of the first server
    // anyone adds — including execution faces the M1 whitelist just removed.
    // Adding an MCP server for main is a deliberate per-server grant, audited
    // against the read-only-manager invariant at that moment.
    mcpServers: [],
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
      'The default executor for delegated work: implementation, fixes, investigations, multi-step operations, and anything mixing capabilities — reading, editing, running commands, searching — in one flow. Dispatch it whenever the work needs hands and no single narrow specialist obviously fits better; it plans its own steps, self-tracks via TodoWrite, and can sub-dispatch specialists for narrow pieces.',
    // Wildcard covers default tool surface; Dispatch must be explicit per the
    // BLOCKED_WORKER_TOOLS gate (`explicitlyReachableDispatch` requires the
    // literal name in tools, not the wildcard). The management tools
    // are listed alongside Dispatch as a self-documenting "dispatcher
    // capability" cluster even though wildcard would also reach them.
    tools: ['*', 'Dispatch', 'Message', 'UpdateSchedule'],
    skills: ['remember', 'skillify', 'brainpp-batch-job', 'build-environment'],
    reachableRoles: ['coder', 'feishuSecretary', 'localExplorer', 'webSearcher'],
    systemPrompt: generalistPrompt,
    kind: 'worker',
    // Authors code inline for branchy mixed tasks → gets the Code style /
    // Publishing discipline fragments. (archivist has the same Write/Edit
    // surface but is organize-not-author, so it does not set this.)
    traits: { authorsCode: true },
    displayName: { cn: '正在处理', en: 'working on it' },
  },
  {
    agentType: 'localExplorer',
    whenToUse:
      'Fast read-only local exploration: files and directories, codebase contents, system state (processes, env vars, conda envs, disk usage, package versions), config files, log files. Read-only — no modifications.',
    // Message here is uplink-only by construction: no Dispatch means no
    // children, and the downlink ownership guard rejects anything else.
    // What it buys a leaf is the ask channel to its requester.
    tools: ['Bash', 'Read', 'Grep', 'Glob', 'MemoryWrite', 'MemoryRead', 'TodoWrite', 'TaskInspect', 'Message', 'ToolSearch', 'SkillWrite', 'UseSkill'],
    skills: ['local-exploration-workflow', 'skillify'],
    hooks: ['auto-compact', 'split-render', 'prompt-too-long-retry', 'memory-nudge', 'auto-memory-extract'],
    systemPrompt: localExplorerPrompt,
    kind: 'worker',
    displayName: { cn: '正在查本地资料', en: 'searching local files' },
  },
  {
    agentType: 'webSearcher',
    whenToUse:
      'Web retrieval using WebFetch + WebSearch. Dispatch when you need current info from the web — a specific question, fact, or document. It digs as deep as needed to fully answer that one question (multi-hop search, cross-source verification, downloaded files surfaced with local paths, Grep over downloaded PDFs / HTMLs for specific facts when full read is too expensive), but does not drift into adjacent topics or interpret meaning. For lateral coverage across different topics, dispatch multiple separate web calls (in parallel when independent).',
    // Message: uplink-only ask channel, same as localExplorer.
    tools: ['WebFetch', 'WebSearch', 'Read', 'Grep', 'Glob', 'MemoryWrite', 'MemoryRead', 'TodoWrite', 'TaskInspect', 'Message', 'ToolSearch', 'SkillWrite', 'UseSkill'],
    skills: ['web-research-workflow', 'skillify'],
    hooks: ['auto-compact', 'split-render', 'prompt-too-long-retry', 'memory-nudge', 'auto-memory-extract'],
    systemPrompt: webSearcherPrompt,
    kind: 'worker',
    outputContract: 'report',
    displayName: { cn: '正在搜索互联网', en: 'searching the web' },
  },
  {
    agentType: 'feishuSecretary',
    whenToUse:
      'Feishu cloud-doc / cloud-space content lifecycle: read a doc, append to a sheet, create new docs / files, write doc content. Dispatch when the task involves new content authoring or content edits on Feishu resources (pasted URLs or workspace-scoped tokens). For pure structure operations (move / delete / create folder) without new content, archivist is also viable. It handles permission grants and ancestry checks; you get back tokens, URLs, and permission outcomes.',
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
      'TaskInspect',
      'TaskUpdate',
      'Sleep',
      'ToolSearch',
      'SkillWrite',
      'Dispatch',
      'Message',
      'UpdateSchedule',
      'UseSkill',
    ],
    skills: ['feishu-doc-workflow', 'skillify'],
    reachableRoles: ['localExplorer', 'webSearcher'],
    systemPrompt: feishuSecretaryPrompt,
    kind: 'worker',
    outputContract: 'report',
    displayName: { cn: '正在处理飞书文档', en: 'working on Feishu docs' },
  },
  {
    agentType: 'coder',
    whenToUse:
      'Coding heavy lifting: implement a feature, fix a bug, refactor a module, add a test — and set up or repair the project around the code: install dependencies, configure the build / toolchain / runtime environment, and get typecheck / tests / build passing. Dispatch when the task centers on code or the environment that code runs in. It plans, edits, runs verification (typecheck / tests / build), self-tracks multi-step progress via TodoWrite, persists durable project conventions via MemoryWrite (build commands, fixture locations, naming patterns), and reports back files touched + verification outcomes.',
    description:
      'Coding specialist (Read/Write/Edit/Grep/Glob/Bash + memory for project conventions).',
    tools: ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash', 'MemoryWrite', 'MemoryRead', 'TodoWrite', 'TaskInspect', 'TaskUpdate', 'Sleep', 'ToolSearch', 'SkillWrite', 'UseSkill', 'Dispatch', 'Message', 'UpdateSchedule'],
    skills: ['remember', 'skillify', 'coding-workflow', 'brainpp-batch-job', 'build-environment'],
    reachableRoles: ['localExplorer', 'webSearcher'],
    systemPrompt: coderPrompt,
    kind: 'worker',
    outputContract: 'report',
    // Repo-code authoring specialist → gets the Code style / Publishing
    // discipline fragments.
    traits: { authorsCode: true },
    displayName: { cn: '正在改代码', en: 'editing code' },
  },
  {
    agentType: 'archivist',
    whenToUse:
      'Cross-domain organization on the user\'s local system and Feishu workspace: deduplicate / classify / age out / index / clean up files on disk, runtime environments (conda envs, pip packages, virtualenvs, npm caches), or Feishu workspace structure (create classification folders, move docs, delete unneeded). Dispatch it not only when the user explicitly asks to organize, but also on your own initiative when you notice the workspace accumulating cruft in the course of other work — leftover scratch / temp / downloaded files once a task lands, duplicates, stale artifacts, a cluttered tree. Treat tidying as low-priority upkeep: fold it in after the user\'s actual request is done, never ahead of it, and keep it light rather than reorganizing everything. Scope is organizing existing resources, not authoring: creating Feishu documents or writing doc content is feishuSecretary\'s territory, and building or installing a runtime environment from scratch is coder\'s — archivist only restructures and prunes (including pruning already-installed envs: stale conda envs, pip caches).',
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
      'TaskInspect',
      'TaskUpdate',
      'Sleep',
      'ToolSearch',
      'SkillWrite',
      'UseSkill',
      'Dispatch',
      'Message',
      'UpdateSchedule',
    ],
    skills: ['archive-workflow', 'remember', 'skillify'],
    reachableRoles: ['feishuSecretary', 'localExplorer', 'webSearcher'],
    systemPrompt: archivistPrompt,
    kind: 'worker',
    outputContract: 'report',
    displayName: { cn: '正在整理资料', en: 'organizing files' },
  },
  {
    agentType: 'reviewer',
    whenToUse:
      'Pre-delivery sanity check: review a code change, written report, organized data, or any artifact the requester is about to hand to the user. Dispatch it on your own initiative when the deliverable is intended for publication or use beyond the requester, hard to reverse, or when checking it takes hands you don\'t have — running code, exercising a change, opening a built system. For an artifact you can read end-to-end yourself (a personal report, a summary, an exploration write-up), your own read against the acceptance criteria is the check; dispatch a review only when that read leaves real doubt. Web-sourced facts should arrive cross-checked and cited by the worker that gathered them. Your check on them is the read itself: load-bearing claims carry citations, sources are named rather than vague, and the claims hold together. Confirming what a cited page actually says is a focused lookup — send one at the specific claim that looks doubtful, not a review round. Reserve a review pass for systematically weak sourcing — load-bearing claims uncited, or the report contradicting itself. The reviewer finds issues (not fixes them): it reads the artifact end-to-end, runs cheap static checks (typecheck / lint / test), applies any persisted user-specific review standards from memory (verifying each is still current before failing on it), groups findings by severity (blocker / important / nit), and returns a structured report with a ship / fix-first / needs-more-info verdict.',
    description:
      'Pre-delivery review specialist (read-only artifact survey; memory for review standards; may dispatch coder ONCE per pass for small in-line fix, otherwise returns issues to requester).',
    tools: ['Read', 'Grep', 'Glob', 'Bash', 'FeishuRead', 'FeishuList', 'MemoryWrite', 'MemoryRead', 'TodoWrite', 'TaskInspect', 'TaskUpdate', 'Sleep', 'ToolSearch', 'SkillWrite', 'UseSkill', 'Dispatch', 'Message', 'UpdateSchedule'],
    skills: ['remember', 'skillify', 'pre-delivery-review-workflow'],
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
    tools: ['SkillWrite', 'SkillEdit', 'SkillDelete', 'Read'],
    systemPrompt: skillConsolidatorPrompt,
    kind: 'internal',
    outputContract: 'side-effect',
  },
]
