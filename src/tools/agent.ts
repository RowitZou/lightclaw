import { z } from 'zod'

import { buildTool } from '../tool.js'

const AGENT_TOOL_DESCRIPTION = `Launch a subagent to handle a focused task with an isolated context.

Available subagent types:
- generalist: Multi-step research, ambiguous searches, or tasks that may span many files. Self-tracks progress via TodoWrite for complex chains; saves durable findings via MemoryWrite.
- localExplorer: Fast read-only local exploration: files and directories, codebase contents, system state (processes, env vars, conda envs, disk usage, package versions), config files, log files. Read-only — no modifications.
- webSearcher: Web retrieval using WebFetch + WebSearch. Dispatch when you need current info from the web — a specific question, fact, or document. The subagent digs as deep as needed to fully answer that one question (multi-hop search, cross-source verification, downloaded files surfaced with local paths, Grep over downloaded PDFs / HTMLs for specific facts when full read is too expensive), but does not drift into adjacent topics or interpret meaning. For lateral coverage across different topics, dispatch multiple separate web calls (in parallel when independent).
- feishuSecretary: Feishu cloud-doc / cloud-space content lifecycle: read a doc, append to a sheet, create new docs / files, write doc content. Dispatch when the task involves new content authoring or content edits on Feishu resources (pasted URLs or workspace-scoped tokens). For pure structure operations (move / delete / create folder) without new content, archivist is also viable. The subagent handles permission grants and ancestry checks; you get back tokens, URLs, and permission outcomes.
- coder: Coding heavy lifting: implement a feature, fix a bug, refactor a module, add a test. Dispatch when the task is bounded to code change in the current repo. The subagent plans, edits, runs verification (typecheck / tests / build) via the verify skill, self-tracks multi-step progress via TodoWrite, persists durable project conventions via MemoryWrite (build commands, fixture locations, naming patterns), and reports back files touched + verification outcomes.
- archivist: Cross-domain organization on the user's local system and Feishu workspace: deduplicate / classify / age out / index / clean up files on disk, runtime environments (conda envs, pip packages, virtualenvs, npm caches), or Feishu workspace structure (create classification folders, move docs, delete unneeded). Dispatch when the task is bounded to organizing existing resources (no new content authoring, no env setup from scratch). Creating Feishu documents or writing doc content is feishuSecretary's territory; archivist only restructures and prunes.
- reviewer: Pre-delivery sanity check: review a code change, written report, organized data, or any artifact the requester is about to hand to the user. Dispatch when the task is "find issues" (not "fix them"). The subagent reads the artifact end-to-end, runs cheap static checks via the verify skill (typecheck / lint / test), applies any persisted user-specific review standards from memory (verifying each is still current before failing on it), groups findings by severity (blocker / important / nit), and returns a structured report with a ship / fix-first / needs-more-info verdict. V1 reviewer does not fix or re-dispatch — the requester owns next steps.

When NOT to use AgentTool:
- Reading a specific file → use Read.
- Finding a specific symbol / class / function → use Grep.
- Searching 2-3 known files → use Read in parallel.
- Trivial questions answerable from your own context.
- Work whose result you do NOT need in this turn (a reminder, a scheduled report, background monitoring) → use BackgroundTask, not AgentTool.

AgentTool vs BackgroundTask — the dividing line is WHEN you need the result:
- In THIS turn, and you can afford to wait for it → AgentTool. Forks now; the turn blocks until every forked agent returns its summary.
- Later, on a schedule, or not at all unless something happens → BackgroundTask. Detached: returns immediately, the result lands later via a user card or a wake-up.

Parallelism:
- Launch independent agents as multiple AgentTool tool_use blocks in a SINGLE assistant message — they run concurrently.
- Only parallelize tasks that touch disjoint files / branches / resources. The runtime does not isolate subagent file systems; concurrent writes to the same path will race. If two tasks could touch the same resource, run them serially in successive turns instead.

Writing the prompt — the agent has NOT seen this conversation:
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough surrounding context that the agent can make judgment calls, not just follow a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact pattern / path. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.
- NEVER write "based on your findings, fix the bug" or "based on the research, implement it". That pushes synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.

Trust but verify: the agent returns a single final-text summary. Tool results from inside the agent are NOT visible to you. If the agent reports writing code, check the actual changes before reporting the task as done.

Each subagent starts a fresh context and is relatively expensive. Don't use it for trivial tasks.`

export const agentTool = buildTool({
  name: 'AgentTool',
  shouldDefer: true,
  description: AGENT_TOOL_DESCRIPTION,
  searchHint: 'web search browse fetch url 查资料 查证 取网页 找链接 检索 fact-check verify research explore codebase',
  domain: 'host',
  riskLevel: 'execute',
  // Multiple AgentTool tool_use blocks emitted in the same assistant message
  // run as a single Promise.all batch (query.ts dispatcher). Independence is
  // the dispatching model's responsibility — see the description above.
  concurrencySafe: true,
  inputSchema: z.object({
    subagent_type: z.enum([
      'generalist',
      'localExplorer',
      'webSearcher',
      'feishuSecretary',
      'coder',
      'archivist',
      'reviewer',
    ]),
    description: z.string().min(3).max(80),
    prompt: z.string().min(10),
  }),
  async call(input, context) {
    const { executeDispatch } = await import('./dispatch.js')
    return executeDispatch({
      role: input.subagent_type,
      prompt: input.prompt,
      schedule: 'now',
      mode: 'blocking',
      label: input.description,
    }, context)
  },
})
