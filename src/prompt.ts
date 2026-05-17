import { platform } from 'node:process'

import { getAllAgents } from './agents/registry.js'
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
  options: PromptOptions
}

export type SubagentPromptContext = {
  tools: Tool[]
  config: LightClawConfig
  cwd?: string
  sessionId?: string
  environmentRoot: string
}

const MAIN_PROMPT_ROLE: Role = {
  agentType: 'main',
  name: 'main',
  kind: 'orchestrator',
  whenToUse: 'Primary user-facing orchestrator.',
  systemPrompt: '',
  tools: ['*'],
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
  return tools.map(tool => `- ${tool.name}`).join('\n')
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
  options: PromptOptions,
): Promise<SystemPromptTemplate> {
  return await buildPromptForRole(MAIN_PROMPT_ROLE, {
    tools,
    cwd,
    environmentRoot,
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
  options: PromptOptions,
): Promise<SystemPromptTemplate> {
  await refreshSkillRegistry(cwd)
  const prompt = await buildRolePromptParts(role, {
    tools,
    config: options.config,
    cwd,
    environmentRoot,
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
    input.sessionId && input.config.sessionsDir
      ? readSessionMemory(input.sessionId, input.config.sessionsDir)
      : Promise.resolve(''),
  ])
  const preTodoSections: string[] = []

  if (role.systemPrompt.trim().length > 0) {
    preTodoSections.push(role.systemPrompt)
  }

  preTodoSections.push(formatEnvironmentSection(role, input.environmentRoot, input.config))

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
  }

  const skillsSection = formatRoleSkillsSection(policy.skills, role)
  if (skillsSection) {
    preTodoSections.push(skillsSection)
  }

  const reachableRolesSection = formatReachableRolesSection(policy.reachableRoles, input.tools)
  if (reachableRolesSection) {
    preTodoSections.push(reachableRolesSection)
  }

  return {
    preTodoSections,
    postTodoSections: [],
    includeTodos: hasTool(policy.tools, 'TodoWrite'),
  }
}

function formatEnvironmentSection(
  role: Role,
  environmentRoot: string,
  config: LightClawConfig,
): string {
  return [
    '# Environment Info',
    '',
    `Workspace directory: ${environmentRoot}`,
    `Current LightClaw user: ${getCurrentUserId() ?? 'unbound'}`,
    formatCurrentDateLine(),
    `Platform: ${platform}`,
    `Model: ${resolveRoleModel(role, config)}`,
  ].join('\n')
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
    'Use skills naturally: when a skill description matches the task, call UseSkill automatically before proceeding.',
    'After UseSkill returns a skill with allowed_tools, stay within that tool boundary for the rest of the task unless another skill is loaded.',
  ].join('\n')
}

function formatChannelContextSection(): string {
  return [
    '## Channel Context',
    '',
    'This session runs in the Feishu channel. Each user message starts with a `## Channel: Feishu` block carrying per-turn context (chat type, group sender prefix, attachment paths) — read it first before the user text.',
    '',
    'You have a private Feishu cloud-space folder dedicated to this user. For any read / write / organize operations on it, dispatch feishuSecretary; do not call FeishuRead / FeishuList / FeishuCreateFile / ... yourself (you no longer have those tools).',
  ].join('\n')
}

function formatReachableRolesSection(reachableRoles: readonly string[], tools: readonly Tool[]): string {
  if (!hasLoadedTool(tools, 'Dispatch') && !hasLoadedTool(tools, 'AgentTool')) {
    return ''
  }
  const agents = new Map(getAllAgents().map(agent => [agent.agentType, agent]))
  const lines = [
    '## Reachable Workers',
    'You can dispatch the following workers via Dispatch / AgentTool:',
  ]
  for (const roleName of reachableRoles) {
    const agent = agents.get(roleName)
    if (!agent || agent.kind !== 'worker') {
      continue
    }
    lines.push(`- ${agent.agentType}: ${agent.whenToUse}`)
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
  const tools = options?.tools ?? []
  const toolDescriptions = formatToolCatalog(tools)
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
  agent: Role,
  cwd = getCwd(),
  sessionId?: string,
): Promise<string> {
  return await buildPromptForRole(agent, { tools, config, cwd, sessionId, environmentRoot })
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
${undiscovered.map(tool => tool.name).join('\n')}
</system-reminder>`
}
