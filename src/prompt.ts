import { platform } from 'node:process'

import { getAllAgents, getMainRole } from './agents/registry.js'
import { resolveRolePolicy } from './agents/role-presets.js'
import type { Role } from './agents/types.js'
import type { LightClawConfig } from './config.js'
import { memoryAge, memoryFreshnessText } from './memory/aging.js'
import { loadMemoryIndex } from './memory/auto-memory.js'
import { loadProjectMemory } from './memory/discovery.js'
import { readSessionMemory } from './memory/session-memory.js'
import type { MemoryEntry } from './memory/types.js'
import { getMcpRegistrySnapshot } from './mcp/index.js'
import { resolveRoleModel } from './model-resolution.js'
import {
  getCwd,
  getCurrentUserId,
  getMemoryDir,
  getPermissionMode,
} from './state.js'
import {
  listRegisteredSkills,
  refreshSkillRegistry,
} from './skill/registry.js'
import { filterSkillsForRole } from './skill/role-validation.js'
import type { Tool } from './tool.js'
import { formatTodosForPrompt } from './todos/store.js'
import type { TodoItem } from './types.js'
import type { PermissionMode } from './permission/types.js'

type PromptOptions = {
  autoMemory: boolean
  config: LightClawConfig
  /** Last user text used by P0 query-time recall. */
  queryText?: string
  /** Active session id, used by P1 SessionMemory injection. */
  sessionId?: string
}

export type SystemPromptTemplate = {
  preTodos: string
  postTodos: string
  includeTodos?: boolean
}

export type OrchestratorPromptContext = {
  tools: Tool[]
  cwd: string
  environmentRoot: string
  scratchRoot: string
  options: PromptOptions
}

export type SubagentPromptContext = {
  tools: Tool[]
  config: LightClawConfig
  cwd?: string
  sessionId?: string
  environmentRoot: string
  scratchRoot: string
}

/**
 * Render the system-prompt's date line in natural language plus an explicit
 * staleness anchor. The prior `new Date().toISOString()` form (e.g.
 * `2026-05-10T11:04:17.352Z`) reads with weak attention — codex / gpt-5.x
 * routinely failed to compare retrieved-data timestamps against it,
 * surfacing yesterday's web snippets as today's facts (Bug 7 in 2026-05-10
 * audit). The natural-language form anchors the comparison explicitly so
 * the model has an unambiguous "anything before this is stale" prior.
 *
 * Bug A in 2026-05-11 audit: previous impl locked every formatter call to
 * `timeZone: 'UTC'`, so at 06:26 HKT 5/11 = 22:26 UTC 5/10 the prompt read
 * "Current date: 2026-05-10 (Sunday, May 2026)" and the agent confidently
 * quoted "今天（5月10日）" back to the user. Drop the UTC lock and use the
 * daemon's system TZ (set via `TZ=Asia/Shanghai` env in the dogfood
 * deployment) so weekday / YMD reflect the operator's local clock.
 * `en-CA` locale gives a sortable `YYYY-MM-DD` shape that matches the prior
 * ISO output.
 */
function formatCurrentDateLine(now: Date = new Date()): string {
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' })
  const monthYear = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  const ymd = now.toLocaleDateString('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return (
    `Current date: ${ymd} (${weekday}, ${monthYear}). When evaluating retrieved data ` +
    `(web search snippets, document timestamps, cached pages), compare against today's date — ` +
    `anything dated before today is potentially stale and may need a follow-up WebFetch to confirm.`
  )
}

export type SystemPromptRenderOptions = {
  tools: Tool[]
  deferredTools?: Tool[]
  discoveredTools?: ReadonlyMap<string, number>
  // 2026-05-26: cache anchoring. When `inlineCatalogTools` is provided, the
  // stable `## Tool Catalog` section renders only that subset, and the
  // remainder of `tools` (discovered via ToolSearch this session) is rendered
  // separately into the variable suffix. Callers that don't pass this still
  // fall back to rendering the full `tools` array in the catalog — preserves
  // backward compat for tests / custom systemPrompt shapes.
  inlineCatalogTools?: Tool[]
  discoveredCatalogTools?: Tool[]
}

function formatSkillsSection(role: Role): string {
  const skills = filterSkillsForRole(listRegisteredSkills(), role)
  if (skills.length === 0) {
    return 'None.'
  }

  return skills
    .map(skill => {
      const whenToUse = skill.whenToUse ?? 'Use when the task matches the skill.'
      return `- ${skill.name}: ${skill.description} | When to use: ${whenToUse}`
    })
    .join('\n')
}

// Tool catalog: name only. Full description / parameter schema travels via
// the native tools API `description` field on the provider tools array (see
// provider/{anthropic,openai,openai-auth}.ts), where it is cache-stable
// against unrelated prompt changes. Duplicating it in the prompt catalog
// breaks the prefix cache on any description tweak and offers the model
// nothing it doesn't already see in the tools array.
function formatToolCatalog(tools: Tool[]): string {
  return tools
    .map(tool => (tool.whenToUse ? `- ${tool.name}: ${tool.whenToUse}` : `- ${tool.name}`))
    .join('\n')
}

function formatTodoSection(todos: TodoItem[]): string {
  if (todos.length === 0) {
    return [
      '## Current Todo List',
      '(no todos yet)',
      'Use TodoWrite to keep this list current. Keep at most one item in_progress.',
    ].join('\n')
  }

  return [
    '## Current Todo List',
    formatTodosForPrompt(todos),
    'Use TodoWrite to keep this list current. Keep at most one item in_progress.',
  ].join('\n')
}

function formatOptionalTodoSection(todos: TodoItem[], includeTodos: boolean | undefined): string {
  if (!includeTodos) {
    return ''
  }
  if (todos.length === 0) {
    return formatTodoSection(todos)
  }

  return formatTodoSection(todos)
}

const MODE_BLURBS: Record<PermissionMode, string> = {
  default:
    'Read/search tools run freely. Write, edit, execute, network fetch, and subagent tools require confirmation; in non-interactive mode they are denied.',
  acceptEdits:
    'Read, search, write, and edit tools run freely. Execute, network fetch, and subagent tools still require confirmation.',
  bypassPermissions: '',
  plan:
    'Read/search tools only. Write, edit, execute, network fetch, and subagent tools are denied unless an explicit allow rule matches.',
}

function formatPermissionSection(isSubagent = false): string {
  const mode = getPermissionMode()
  if (mode === 'bypassPermissions') {
    return ''
  }

  const lines = [
    '## Permission Mode',
    `Current mode: ${mode}`,
    ...(isSubagent
      ? ['Subagent permission checks are non-interactive; confirmation requests are denied automatically.']
      : []),
    `In this mode: ${MODE_BLURBS[mode]}`,
    'If a tool returns "Permission denied:", do not retry the same call. Choose a read-only alternative, explain the limitation, or ask the user to add an explicit allow rule/switch mode.',
  ]

  return lines.join('\n')
}

function formatMcpSection(): string {
  const snapshot = getMcpRegistrySnapshot()
  if (!snapshot.enabled || snapshot.connections.length === 0) {
    return ''
  }

  const lines = ['## MCP Servers']
  const listedConnections = snapshot.connections.slice(0, 5)
  for (const connection of listedConnections) {
    const name = connection.config.normalizedName
    if (connection.type === 'connected') {
      const toolNames = connection.tools.slice(0, 8).map(tool => tool.name)
      const suffix =
        connection.tools.length > toolNames.length
          ? `, ... (${connection.tools.length} tools total)`
          : ''
      lines.push(
        `- ${name} (connected, ${connection.tools.length} tools): ${toolNames.join(', ')}${suffix}`,
      )
      continue
    }

    if (connection.type === 'disabled') {
      lines.push(`- ${name} (disabled)`)
      continue
    }

    lines.push(`- ${name} (failed: ${connection.error})`)
  }

  if (snapshot.connections.length > listedConnections.length) {
    lines.push(`- ${snapshot.connections.length - listedConnections.length} more server(s) not shown.`)
  }

  lines.push(
    'MCP tool names are namespaced as mcp__<server>__<tool>. Treat them like any other tool; permission rules with MCP(<server>:*) apply.',
  )

  return lines.join('\n')
}

export async function buildSystemPromptTemplate(
  tools: Tool[],
  cwd: string,
  environmentRoot: string,
  scratchRoot: string,
  options: PromptOptions,
): Promise<SystemPromptTemplate> {
  return await buildPromptForRole(getMainRole(), {
    tools,
    cwd,
    environmentRoot,
    scratchRoot,
    options,
  })
}

export async function buildPromptForRole(
  role: Role,
  context: OrchestratorPromptContext,
): Promise<SystemPromptTemplate>
export async function buildPromptForRole(
  role: Role,
  context: SubagentPromptContext,
): Promise<string>
export async function buildPromptForRole(
  role: Role,
  context: OrchestratorPromptContext | SubagentPromptContext,
): Promise<SystemPromptTemplate | string> {
  const policy = resolveRolePolicy(role)
  if (policy.kind === 'orchestrator') {
    if (!isOrchestratorPromptContext(context)) {
      throw new Error(`Role "${policy.name}" requires orchestrator prompt context.`)
    }
    return buildOrchestratorPromptTemplate(
      role,
      context.tools,
      context.cwd,
      context.environmentRoot,
      context.scratchRoot,
      context.options,
    )
  }

  if (isOrchestratorPromptContext(context)) {
    return await buildSubagentPromptContent(role, {
      tools: context.tools,
      config: context.options.config,
      cwd: context.cwd,
      sessionId: context.options.sessionId,
      environmentRoot: context.environmentRoot,
      scratchRoot: context.scratchRoot,
    })
  }

  return await buildSubagentPromptContent(role, context)
}

function isOrchestratorPromptContext(
  context: OrchestratorPromptContext | SubagentPromptContext,
): context is OrchestratorPromptContext {
  return 'cwd' in context && 'options' in context
}

async function buildOrchestratorPromptTemplate(
  role: Role,
  tools: Tool[],
  cwd: string,
  environmentRoot: string,
  scratchRoot: string,
  options: PromptOptions,
): Promise<SystemPromptTemplate> {
  await refreshSkillRegistry(cwd, getCurrentUserId())
  const prompt = await buildRolePromptParts(role, {
    tools,
    config: options.config,
    cwd,
    environmentRoot,
    scratchRoot,
    sessionId: options.sessionId,
    isSubagent: false,
  })

  return {
    preTodos: prompt.preTodoSections.join('\n\n'),
    postTodos: prompt.postTodoSections.join('\n\n'),
    includeTodos: prompt.includeTodos,
  }
}

/**
 * Stable prefix that is cacheable across an entire query() loop (persona,
 * memory, skills, permission summary, MCP catalog, tool descriptions); plus
 * a variable suffix that changes whenever the agent flips a todo state or
 * when a new deferred tool is discovered mid-turn. Provider layer should
 * pass these as separate cache_control-tagged blocks so the prefix stays
 * cache-hit while only the suffix re-tokenizes (Codex / Anthropic both
 * benefit — see investigation report 2026-05-13).
 */
export type RenderedSystemPrompt = {
  stable: string
  variable: string
}

type RolePromptPartsInput = {
  tools: Tool[]
  config: LightClawConfig
  cwd: string
  environmentRoot: string
  scratchRoot: string
  sessionId?: string
  isSubagent: boolean
}

type RolePromptParts = {
  preTodoSections: string[]
  postTodoSections: string[]
  includeTodos: boolean
}

async function buildRolePromptParts(
  role: Role,
  input: RolePromptPartsInput,
): Promise<RolePromptParts> {
  const policy = resolveRolePolicy(role)
  const memoryDir = getMemoryDir()
  const [projectMemory, autoMemoryIndex, sessionMemory] = await Promise.all([
    loadProjectMemory(input.cwd),
    loadMemoryIndex(memoryDir, role),
    input.sessionId && input.config.paths.sessions
      ? readSessionMemory(input.sessionId, input.config.paths.sessions)
      : Promise.resolve(''),
  ])
  const preTodoSections: string[] = []

  if (role.systemPrompt.trim().length > 0) {
    preTodoSections.push(role.systemPrompt)
  }

  preTodoSections.push(
    formatEnvironmentSection(
      role,
      input.environmentRoot,
      input.scratchRoot,
      input.config,
      hasTool(policy.tools, 'Bash'),
    ),
  )

  if (projectMemory.trim().length > 0) {
    preTodoSections.push(['## Project Memory', projectMemory].join('\n\n'))
  }

  if (autoMemoryIndex.trim().length > 0) {
    preTodoSections.push(['## Auto Memory Index', autoMemoryIndex].join('\n\n'))
  }

  if (sessionMemory.trim().length > 0) {
    preTodoSections.push(['## Session Working Memory', sessionMemory.trim()].join('\n\n'))
  }

  const permissionSection = formatPermissionSection(input.isSubagent)
  if (permissionSection) {
    preTodoSections.push(permissionSection)
  }

  if (policy.kind === 'orchestrator') {
    preTodoSections.push(formatChannelContextSection())
    preTodoSections.push(formatAskUserQuestionNudge())
  }

  const skillsSection = formatRoleSkillsSection(policy.skills, role)
  if (skillsSection) {
    preTodoSections.push(skillsSection)
  }

  const reachableRolesSection = formatReachableRolesSection(policy.reachableRoles, input.tools)
  if (reachableRolesSection) {
    preTodoSections.push(reachableRolesSection)
  }

  const postTodoSections: string[] = []
  if (policy.kind !== 'internal') {
    postTodoSections.push(formatSharedOperatingDiscipline())
  }

  return {
    preTodoSections,
    postTodoSections,
    includeTodos: hasTool(policy.tools, 'TodoWrite'),
  }
}

function formatEnvironmentSection(
  role: Role,
  environmentRoot: string,
  scratchRoot: string,
  config: LightClawConfig,
  includeScratch: boolean,
): string {
  const lines = [
    '# Environment Info',
    '',
    `Workspace directory: ${environmentRoot}`,
  ]
  // Scratch guidance is only rendered for roles that can run Bash — the
  // roles that actually do git / build / archive work. A role without Bash
  // (e.g. a web-only or Feishu-only worker) cannot use scratch, so telling
  // it about the directory would be irrelevant context.
  if (includeScratch) {
    lines.push(
      `Scratch directory: ${scratchRoot} — fast local disk. The workspace is on ` +
      `shared storage where bulk small-file operations (git clone, dependency ` +
      `installs, builds, unpacking archives) run very slowly, so do that work ` +
      `under the scratch directory instead. Scratch is NOT durable storage: it ` +
      `is wiped — without warning and in full — whenever the worker restarts, ` +
      `the container is removed, or the sandbox is reset, and anything left ` +
      `there is permanently lost. As soon as a clone, download, or build ` +
      `produces something the user needs, copy it into the workspace; never ` +
      `leave a deliverable sitting in scratch.`,
    )
  }
  lines.push(
    `Current LightClaw user: ${getCurrentUserId() ?? 'unbound'}`,
    formatCurrentDateLine(),
    `Platform: ${platform}`,
    `Model: ${resolveRoleModel(role, config)}`,
  )
  return lines.join('\n')
}

function formatRoleSkillsSection(skills: readonly string[], role: Role): string {
  if (skills.length === 0) {
    return ''
  }

  const body = formatSkillsSection({ ...role, skills: [...skills] })
  if (body === 'None.') {
    return ''
  }

  return [
    '## Available Skills',
    body,
  ].join('\n')
}

function formatChannelContextSection(): string {
  return [
    '## Channel Context',
    '',
    'This session runs in the Feishu channel. User messages may include channel-specific framing around the text: a `[<senderName>]` prefix in group chats, a `<quoted-message>` block when the user reply-quotes a previous message, and an attachment list below the text with local paths. Read all of it before deciding what the user is asking.',
    '',
    'You have a private Feishu cloud-space folder dedicated to this user. For multi-step or specialized Feishu work (cloud-doc lifecycle, workspace organization), lean on delegation — the Reachable Workers section lists who has the relevant capability.',
  ].join('\n')
}

function formatAskUserQuestionNudge(): string {
  return [
    '## Structured User Questions',
    'When user intent leaves a real choice unresolved — multiple reasonable directions, or a missing fact that materially changes the result — call AskUserQuestion (load it via ToolSearch first) rather than picking blind. Decide first, ask second.',
  ].join('\n')
}

function formatSharedOperatingDiscipline(): string {
  return [
    'Working style:',
    '- For exploratory questions ("how should we approach X?", "what do you think?"), respond in 2-3 sentences with a recommendation and the main tradeoff. Don\'t implement until the requester agrees.',
    '- Don\'t add features, refactor, or introduce abstractions beyond what the task requires. A bug fix doesn\'t need surrounding cleanup. Three similar lines is better than a premature abstraction.',
    '- Don\'t add error handling, fallbacks, or validation for scenarios that can\'t happen. Trust internal code and framework guarantees. Only validate at system boundaries (user input, external APIs).',
    '- Default to writing no comments. Add one only when the WHY is non-obvious. Don\'t explain WHAT the code does — well-named identifiers already do that.',
    '- Prefer editing existing files to creating new ones. Don\'t create *.md / README / CHANGELOG files unless explicitly asked.',
    '- Avoid backwards-compatibility shims and "// removed" placeholder comments. If something is unused, delete it.',
    '',
    'Response shape:',
    '- Keep responses short and concise. Match length to the task — a one-line question gets a one-line answer.',
    '- Reference code with file_path:line_number for navigability.',
    '- Before your first action, state in one sentence what you\'re about to do. Give short progress updates at key moments — a decision, a surprise, a phase boundary. Silent is worse than brief.',
    '- Do not narrate every action, and do not narrate internal deliberation.',
    '- End-of-turn summary: one or two sentences. What changed and what\'s next.',
    '- Do not put a colon before tool calls — tool calls may not render in output, leaving a dangling colon.',
    '- Reply in the language the request used.',
    '',
    'Action safety:',
    '- Local reversible actions (edits, tests, reads) — proceed freely.',
    '- Hard-to-reverse or shared-state actions (git push, force-push, package upgrades, channel messages outside the agent reply, dropping tables) — confirm with the requester first unless explicitly authorized.',
    '- When you hit an obstacle, do not use destructive shortcuts (--no-verify, --force, bypassing checks). Identify the root cause.',
    '',
    'Parallelism:',
    '- You can call multiple tools in one response. When tool calls are independent, send them as parallel tool_use blocks in a single message — never serially.',
    '- Independent reads (multiple Reads, Glob + Grep) should always run in parallel.',
    '',
    'Tool usage:',
    '- Prefer direct answers when no tool is needed.',
    '- Prefer dedicated tools over Bash when one fits — they are permission-scoped, sandbox-aware, and produce structured results easier to review than raw Bash stdout. Use Read instead of cat / head / tail / sed; Edit instead of sed / awk; Write instead of echo > / heredoc; Glob instead of find / ls; Grep instead of grep / rg. Reserve Bash for shell-only operations not covered by a dedicated tool — git, package managers, build / test commands, system diagnostics.',
    '- When editing files, be precise and avoid unrelated changes.',
    '- If a tool fails, explain the failure and recover with a narrower step — do not retry the same call.',
    '- Visual content described by Read on images / PDF page renders is transcribed by a smaller vision model. Names, numbers, identifiers, and other precise tokens may have OCR errors. When the user asks for an exact value, treat the transcription as a hint — re-render at higher fidelity or ask the user to confirm before committing the value.',
    '',
    'Capabilities to lean on (when present):',
    '- When ## Reachable Workers is rendered above, prefer delegating any sub-task that matches a worker\'s specialty over handling it inline — you get a focused result back and stay on your own job.',
    '- When ## Available Skills is rendered above, prefer calling a skill that matches the current work over scripting the same flow from scratch — skills tend to align with project convention and save trial-and-error.',
    '- When TodoWrite is in your tool catalog and a task needs three or more sequential steps, open with a TodoWrite to lay them out, and keep at most one item in_progress throughout. Skip TodoWrite for single-step tasks.',
    '',
    'Sandbox availability:',
    '- If an environment-domain tool (Bash / Read / Write / Edit / Grep / Glob / WebFetch / WebSearch) returns an error mentioning "Sandbox image" being not ready / pulling / failed / autoPull disabled, do not retry that tool. Acknowledge to the requester that the sandbox is being prepared (or has failed and admin has been notified) and offer to continue with chat-only assistance — discussion, planning, explaining concepts. Do not attempt environment-domain tools again until explicitly asked to retry.',
  ].join('\n')
}

function formatReachableRolesSection(reachableRoles: readonly string[], tools: readonly Tool[]): string {
  if (!hasLoadedTool(tools, 'Dispatch')) {
    return ''
  }
  const allAgents = getAllAgents()
  const lines = [
    '## Reachable Workers',
    'You can dispatch the following workers via Dispatch:',
  ]
  if (reachableRoles.includes('*')) {
    // Wildcard expands to every registered worker (bundled + user-defined,
    // in registration order). main uses this to stay symmetric over the
    // user-defined role roster without an admin slash to re-list each role.
    for (const agent of allAgents) {
      if (agent.kind !== 'worker') continue
      lines.push(`- ${agent.agentType}: ${agent.whenToUse}`)
    }
  } else {
    const agents = new Map(allAgents.map(agent => [agent.agentType, agent]))
    for (const roleName of reachableRoles) {
      const agent = agents.get(roleName)
      if (!agent || agent.kind !== 'worker') {
        continue
      }
      lines.push(`- ${agent.agentType}: ${agent.whenToUse}`)
    }
  }
  return lines.length > 2 ? lines.join('\n') : ''
}

function hasTool(tools: readonly string[], name: string): boolean {
  return tools.includes('*') || tools.includes(name)
}

function hasLoadedTool(tools: readonly Tool[], name: string): boolean {
  return tools.some(tool => tool.name === name)
}

export function renderSystemPromptSplit(
  template: SystemPromptTemplate,
  todos: TodoItem[],
  options?: SystemPromptRenderOptions,
): RenderedSystemPrompt {
  // Stable catalog: prefer the caller-supplied inlineCatalogTools subset (the
  // always-loaded tools, whose membership is fixed for the query loop). Fall
  // back to the full tools[] for callers that haven't opted into the split
  // (tests, future custom systemPrompt shapes). The discovered subset is
  // routed into the variable suffix below.
  const stableCatalogTools = options?.inlineCatalogTools ?? options?.tools ?? []
  const toolDescriptions = formatToolCatalog(stableCatalogTools)
  const toolSection = [
    '## Tool Catalog',
    'Available tools (full schemas / usage live in the tools API description field):',
    toolDescriptions,
  ].join('\n')
  const stable = [template.preTodos, toolSection, template.postTodos]
    .filter(section => section.trim().length > 0)
    .join('\n\n')

  const variableParts: string[] = []
  const todoSection = formatOptionalTodoSection(todos, template.includeTodos)
  if (todoSection) {
    variableParts.push(todoSection)
  }
  const discoveredReminder = buildDiscoveredToolsReminder(
    options?.discoveredCatalogTools ?? [],
  )
  if (discoveredReminder) {
    variableParts.push(discoveredReminder)
  }
  const deferredReminder = buildDeferredToolsReminder(
    options?.deferredTools ?? [],
    options?.discoveredTools ?? new Map(),
  )
  if (deferredReminder) {
    variableParts.push(deferredReminder)
  }

  return {
    stable,
    variable: variableParts.join('\n\n'),
  }
}

export function renderSystemPrompt(
  template: SystemPromptTemplate,
  todos: TodoItem[],
  options?: SystemPromptRenderOptions,
): string {
  const tools = options?.tools ?? []
  const toolSection = [
    '## Tool Catalog',
    'Available tools (full schemas / usage live in the tools API description field):',
    formatToolCatalog(tools),
  ].join('\n')
  const deferredReminder = buildDeferredToolsReminder(
    options?.deferredTools ?? [],
    options?.discoveredTools ?? new Map(),
  )
  const sections = [
    template.preTodos,
    toolSection,
    template.postTodos,
    formatOptionalTodoSection(todos, template.includeTodos),
    deferredReminder,
  ].filter(section => section.trim().length > 0)
  return sections.join('\n\n')
}

export async function buildSubagentPrompt(
  tools: Tool[],
  config: LightClawConfig,
  environmentRoot: string,
  scratchRoot: string,
  agent: Role,
  cwd = getCwd(),
  sessionId?: string,
): Promise<string> {
  return await buildPromptForRole(agent, {
    tools,
    config,
    cwd,
    sessionId,
    environmentRoot,
    scratchRoot,
  })
}

async function buildSubagentPromptContent(
  role: Role,
  context: SubagentPromptContext,
): Promise<string> {
  const prompt = await buildRolePromptParts(role, {
    tools: context.tools,
    config: context.config,
    cwd: context.cwd ?? getCwd(),
    sessionId: context.sessionId,
    environmentRoot: context.environmentRoot,
    scratchRoot: context.scratchRoot,
    isSubagent: true,
  })
  const template: SystemPromptTemplate = {
    preTodos: prompt.preTodoSections.join('\n\n'),
    postTodos: prompt.postTodoSections.join('\n\n'),
    includeTodos: prompt.includeTodos,
  }
  return renderSystemPrompt(template, [], { tools: context.tools })
}

function buildDeferredToolsReminder(
  deferredTools: readonly Tool[],
  discoveredTools: ReadonlyMap<string, number>,
): string {
  const undiscovered = deferredTools.filter(tool => !discoveredTools.has(tool.name))
  if (undiscovered.length === 0) {
    return ''
  }
  return `<system-reminder>
The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded. Calling them directly will fail. Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:
${undiscovered
  .map(tool => (tool.whenToUse ? `${tool.name} — ${tool.whenToUse}` : tool.name))
  .join('\n')}
</system-reminder>`
}

// 2026-05-26: discovered (already-promoted) deferred tools used to be listed
// in the stable `## Tool Catalog` section, which made the stable system
// prompt grow each time ToolSearch promoted a new tool. Under OpenAI's
// auto-cache (wire-byte prefix fingerprint), this broke prefix cache for
// every subsequent turn — dogfood §cache hit rate measured ~11% instead of
// the expected 60-80%. The fix renders these tools in the variable suffix
// (injected into the last user message) so the stable section is invariant
// under discoveredTools changes. The block name lists the tool names + their
// whenToUse so the model has the same one-line hint it had pre-fix; full
// schemas still live in the provider's tools API field.
function buildDiscoveredToolsReminder(
  discoveredCatalogTools: readonly Tool[],
): string {
  if (discoveredCatalogTools.length === 0) {
    return ''
  }
  return `<system-reminder>
The following deferred tools were loaded via ToolSearch earlier in this session and are now callable. Full schemas live in the tools API description field — call them by name:
${discoveredCatalogTools
  .map(tool => (tool.whenToUse ? `- ${tool.name}: ${tool.whenToUse}` : `- ${tool.name}`))
  .join('\n')}
</system-reminder>`
}
