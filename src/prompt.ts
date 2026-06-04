import { cpus, totalmem } from 'node:os'
import { platform } from 'node:process'

import { getAllAgents, getMainRole } from './agents/registry.js'
import { resolveRolePolicy } from './agents/role-presets.js'
import type { Role, RoleKind } from './agents/types.js'
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
  loadRegisteredSkill,
  refreshSkillRegistry,
} from './skill/registry.js'
import { skillDirFor } from './skill/skill-dir.js'
import { filterSkillsForRole } from './skill/role-validation.js'
import type { Tool } from './tool.js'
import { formatTodosForPrompt } from './todos/store.js'
import type { TodoItem } from './types.js'

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
    `Current date: ${ymd} (${weekday}, ${monthYear}). When you rely on retrieved or cached data ` +
    `(snippets, document timestamps, prior results), compare it against today's date — ` +
    `anything dated before today may be stale; re-confirm against a current source before relying on it.`
  )
}

export type SystemPromptRenderOptions = {
  tools: Tool[]
  deferredTools?: Tool[]
  discoveredTools?: ReadonlyMap<string, number>
  enabledSecrets?: ReadonlyMap<string, string>
  // 2026-05-26: cache anchoring. When `inlineCatalogTools` is provided, the
  // stable `## Tool Catalog` section renders only that subset, and the
  // remainder of `tools` (discovered via ToolSearch this session) is rendered
  // separately into the variable suffix. Callers that don't pass this still
  // fall back to rendering the full `tools` array in the catalog — preserves
  // backward compat for tests / custom systemPrompt shapes.
  inlineCatalogTools?: Tool[]
  discoveredCatalogTools?: Tool[]
}

function formatSkillsSection(role: Role, config: LightClawConfig): string {
  // Auto-loaded skills are injected as a workflow section (see
  // formatAutoLoadedWorkflowSections); they are not load-on-demand, so listing
  // them here — with a now-moot when_to_use trigger — would be misleading.
  const skills = filterSkillsForRole(
    listRegisteredSkills(),
    role,
    { runtimeDriver: config.runtime?.driver ?? null },
  ).filter(skill => !skill.autoLoad)
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

// Auto-loaded skills (frontmatter `auto_load: true`) are the role's primary
// always-on workflow: the framework injects the body on turn 1 instead of
// waiting for the model to call UseSkill, so the procedure is reliably in
// context. The skill text stays in its own file (persona / workflow stay
// separated); only the loading becomes automatic.
async function formatAutoLoadedWorkflowSections(role: Role, config: LightClawConfig): Promise<string[]> {
  const autoSkills = filterSkillsForRole(
    listRegisteredSkills(),
    role,
    { runtimeDriver: config.runtime?.driver ?? null },
  ).filter(skill => skill.autoLoad)
  const sections: string[] = []
  for (const skill of autoSkills) {
    const loaded = await loadRegisteredSkill(skill.name)
    const body = loaded?.body.trim()
    if (!body) {
      continue
    }
    // Resolve the asset-dir placeholder to the non-runtime fallback (matches
    // registry.ts); the always-on workflow body is read as guidance, not
    // entered as a tool-gated skill invocation.
    sections.push(body.replaceAll('${LIGHTCLAW_SKILL_DIR}', skillDirFor(skill)))
  }
  return sections
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

// The todo block lives in the LAST USER MESSAGE since b9e53d1 (cache anchor
// fix on 2026-05-26). User-role content with a trailing "Use TodoWrite..."
// imperative reads to the model as a fresh user instruction, which caused
// agents to silently end-turn mid-task on 2026-05-26 dogfood. Wrap in
// <system-reminder> and reword the trailing cue from imperative to state +
// continuation, mirroring the deferred-tools reminder framing.
function formatTodoSection(todos: TodoItem[]): string {
  if (todos.length === 0) {
    return [
      '<system-reminder>',
      '## Current Todo List',
      '(no todos yet)',
      '',
      "This is the framework's snapshot of your todo state, not a fresh user instruction. When a task needs three or more sequential steps, open with a TodoWrite. At most one item in_progress.",
      '</system-reminder>',
    ].join('\n')
  }

  return [
    '<system-reminder>',
    '## Current Todo List',
    formatTodosForPrompt(todos),
    '',
    "This is the framework's snapshot of your todo state, not a fresh user instruction. Keep advancing the in_progress item; update via TodoWrite as items change status. At most one item in_progress. While items remain pending or in_progress, the work isn't finished — keep going rather than ending the turn, unless you're blocked or the user only asked for progress.",
    '</system-reminder>',
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

function formatAvailableSecretsSection(enabledSecrets: ReadonlyMap<string, string> | undefined): string {
  if (!enabledSecrets || enabledSecrets.size === 0) {
    return ''
  }
  const names = [...enabledSecrets.keys()].sort()
  return [
    '## Available Secrets',
    '',
    "These environment variables are injected into Bash commands for you. Use them as `$NAME` (e.g. `git push https://$GH_TOKEN@github.com/...`). The values are confidential — never echo them, write them to files, or paste them into other tools' arguments.",
    '',
    "If a secret's purpose is unclear from its name (e.g. `API_KEY` without context, or a name you don't recognize from the conversation), ask the user what it is and how to use it before guessing.",
    '',
    ...names.map(name => `- ${name}`),
  ].join('\n')
}

function formatPermissionSection(kind: RoleKind): string {
  if (getPermissionMode() === 'plan') {
    return [
      '## Tool Use & Approvals',
      'Planning only: investigate with read and search tools, but do not write, edit, or execute — present a plan for approval instead of taking the action.',
    ].join('\n')
  }

  const lines = [
    '## Tool Use & Approvals',
    "Act on what you've decided: when a tool call is the right next step, make it — don't ask for permission to run it first. Whether an action needs approval is handled outside your turn; you'll either get the result or a \"Permission denied:\" result.",
    'On "Permission denied:", do not retry the same call — choose a read-only alternative or explain the limitation.',
  ]
  // Internal roles run autonomously in a background pass with no requester or
  // user to consult — telling them "asking is appropriate" points at a channel
  // that does not exist and conflicts with the Autonomy fragment. Only
  // non-internal roles, which report back to a live requester, get the line.
  if (kind !== 'internal') {
    lines.push('(Asking for information you genuinely need in order to decide what to do is different, and still appropriate.)')
  }
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

  const permissionSection = formatPermissionSection(policy.kind)
  if (permissionSection) {
    preTodoSections.push(permissionSection)
  }

  if (policy.kind === 'orchestrator') {
    preTodoSections.push(formatChannelContextSection())
    preTodoSections.push(formatAskUserQuestionNudge())
  }

  const skillsSection = formatRoleSkillsSection(policy.skills, role, input.config)
  if (skillsSection) {
    preTodoSections.push(skillsSection)
  }

  for (const workflowSection of await formatAutoLoadedWorkflowSections(role, input.config)) {
    preTodoSections.push(workflowSection)
  }

  const reachableRolesSection = formatReachableRolesSection(policy.reachableRoles, input.tools)
  if (reachableRolesSection) {
    preTodoSections.push(reachableRolesSection)
    if (policy.kind === 'orchestrator') {
      preTodoSections.push(formatDispatchModeSection())
    }
  }

  const dataFlags = new Set<FragmentDataFlag>()
  if (projectMemory.trim().length > 0) dataFlags.add('projectMemory')
  if (autoMemoryIndex.trim().length > 0) dataFlags.add('autoMemoryIndex')
  if (sessionMemory.trim().length > 0) dataFlags.add('sessionMemory')
  if (reachableRolesSection) dataFlags.add('reachableWorkers')
  if (skillsSection) dataFlags.add('skills')

  const facts: RoleFacts = {
    kind: policy.kind,
    tools: policy.tools,
    skills: policy.skills,
    traits: role.traits ?? {},
    data: dataFlags,
  }

  const postTodoSections: string[] = []
  const discipline = formatSharedOperatingDiscipline(facts, role)
  if (discipline) {
    postTodoSections.push(discipline)
  }

  return {
    preTodoSections,
    postTodoSections,
    includeTodos: hasTool(policy.tools, 'TodoWrite'),
  }
}

function formatComputeLine(config: LightClawConfig): string {
  const hostCores = cpus().length
  const hostGb = Math.round(totalmem() / 1024 ** 3)
  const rt = config.runtime
  if (rt?.backend === 'cluster') {
    const cs = rt.clusterSettings
    return `Available compute: ${cs.cpu} CPU cores, ${Math.round(cs.memoryMb / 1024)} GB memory, ${cs.gpu} GPU.`
  }
  if (rt?.backend === 'docker') {
    const ds = rt.dockerSettings
    const cores = ds.cpuLimit && ds.cpuLimit > 0 ? ds.cpuLimit : hostCores
    const memory =
      ds.memoryLimit && ds.memoryLimit.trim().length > 0 ? ds.memoryLimit : `${hostGb} GB`
    return `Available compute: ${cores} CPU cores, ${memory} memory.`
  }
  // local (or a config without an explicit runtime backend): the daemon host's own resources
  return `Available compute: ${hostCores} CPU cores, ${hostGb} GB memory.`
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
      `shared storage where heavy or bulk file operations run slowly, so do that ` +
      `kind of work under the scratch directory instead. Scratch is NOT durable ` +
      `storage: it is wiped — without warning and in full — whenever the worker ` +
      `restarts, the container is removed, or the sandbox is reset, and anything ` +
      `left there is permanently lost. As soon as work under scratch produces ` +
      `something the user needs, copy it into the workspace; never leave a ` +
      `deliverable sitting in scratch.`,
    )
  }
  lines.push(
    `Current LightClaw user: ${getCurrentUserId() ?? 'unbound'}`,
    formatCurrentDateLine(),
    `Platform: ${platform}`,
    formatComputeLine(config),
    `Model: ${resolveRoleModel(role, config)}`,
  )
  return lines.join('\n')
}

function formatRoleSkillsSection(
  skills: readonly string[],
  role: Role,
  config: LightClawConfig,
): string {
  if (skills.length === 0) {
    return ''
  }

  const body = formatSkillsSection({ ...role, skills: [...skills] }, config)
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

function formatDispatchModeSection(): string {
  return [
    '## Dispatch Mode',
    'Pick the dispatch mode by whether you need the result to write your current reply. Need it now and it is quick → blocking (fan out several short independent sub-tasks as parallel blocking calls in one message, then synthesize). Don\'t need it now, or it is long-running (deep research, large refactor, long build) → background, so the session stays responsive instead of freezing behind a multi-minute call; the result comes back later as a <background-task-result> for you to surface.',
  ].join('\n')
}

// ── Shared operating-discipline fragment registry ─────────────────────────
//
// The role prompt is `persona` (the only role-authored section) plus a set of
// reusable fragments assembled by rule. Each fragment carries a declarative
// `when` condition read against the role's facts (tools / skills / kind /
// declared traits / present data sections), so a NEW role — including a
// user-defined one — composes the right prompt purely from what it declares,
// without anyone editing fragment text. `Role.sections` is the surgical
// override on top of the conditions. The lone pre-existing instance of this
// pattern was the Bash-gated scratch line; this generalizes it.

type FragmentDataFlag =
  | 'projectMemory'
  | 'autoMemoryIndex'
  | 'sessionMemory'
  | 'reachableWorkers'
  | 'skills'

type RoleFacts = {
  kind: RoleKind
  tools: readonly string[]
  skills: readonly string[]
  traits: Record<string, boolean>
  data: ReadonlySet<FragmentDataFlag>
}

type FragmentCondition =
  | 'always'
  | { tool: string }
  | { anyTool: string[] }
  | { skill: string }
  | { trait: string }
  | { kind: RoleKind }
  | { dataPresent: FragmentDataFlag }
  | { not: FragmentCondition }
  | { allOf: FragmentCondition[] }
  | { anyOf: FragmentCondition[] }

function factHasTool(facts: RoleFacts, name: string): boolean {
  return facts.tools.includes('*') || facts.tools.includes(name)
}

function factHasSkill(facts: RoleFacts, name: string): boolean {
  return facts.skills.includes('*') || facts.skills.includes(name)
}

function evaluateFragmentCondition(cond: FragmentCondition, facts: RoleFacts): boolean {
  if (cond === 'always') return true
  if ('tool' in cond) return factHasTool(facts, cond.tool)
  if ('anyTool' in cond) return cond.anyTool.some(name => factHasTool(facts, name))
  if ('skill' in cond) return factHasSkill(facts, cond.skill)
  if ('trait' in cond) return facts.traits[cond.trait] === true
  if ('kind' in cond) return facts.kind === cond.kind
  if ('dataPresent' in cond) return facts.data.has(cond.dataPresent)
  if ('not' in cond) return !evaluateFragmentCondition(cond.not, facts)
  if ('allOf' in cond) return cond.allOf.every(c => evaluateFragmentCondition(c, facts))
  if ('anyOf' in cond) return cond.anyOf.some(c => evaluateFragmentCondition(c, facts))
  return false
}

type DisciplineBullet = { when?: FragmentCondition; text: string }
type DisciplineBlock = {
  id: string
  when?: FragmentCondition
  header: string
  bullets: DisciplineBullet[]
}

const NOT_INTERNAL: FragmentCondition = { not: { kind: 'internal' } }

// Ordered list of operating-discipline blocks. A block renders when its `when`
// passes (default always) and at least one of its bullets passes; only the
// passing bullets are emitted. `id` is the unit `Role.sections` can override.
const DISCIPLINE_BLOCKS: DisciplineBlock[] = [
  {
    id: 'disc.drive',
    when: NOT_INTERNAL,
    header: 'Drive to completion:',
    bullets: [
      { text: '- You are built for long-running work: keep going across many steps and turns until the request is actually fulfilled. The default is to continue, not to check in.' },
      { text: '- Keep going until one of these is true, then stop and return to the requester:\n  - the work is genuinely done and verified;\n  - the requester tells you to stop, cancels, or redirects;\n  - a boundary or stop condition the requester set has been reached ("do X until Y", "stop once Z happens");\n  - a real ambiguity or missing fact would change the result, or you need input only the requester can give;\n  - the next move is a safety or genuinely irreversible decision that needs a human call;\n  - you are truly blocked with no path forward, and a focused retry hasn\'t opened one.' },
      { text: '- Short of one of those, don\'t pause to ask "should I continue?", don\'t hand back a plan for approval, and don\'t stop at a partial result you could finish.' },
      { text: '- Before reporting something done, verify it against the request: check the result against what was asked and inspect what you produced. If you can\'t verify, say so plainly rather than implying success.' },
      { text: '- If an approach fails, diagnose the cause and try a focused fix before switching tactics or escalating. A weak or empty result means vary the query / path / source, not conclude. Don\'t abandon a viable approach after one failure.' },
      { text: '- Never call incomplete, unverified, or broken work done. If it\'s partial, keep going when the next step is clear. When you report it done, give the requester the full picture — what was delivered, where it lives, and how you verified it — not a bare "done". When you must stop without finishing, report what you completed, what\'s still left, and the specific blocker: where it is and the exact missing input, so the requester can act without re-discovering it.' },
    ],
  },
  {
    id: 'disc.scope',
    when: NOT_INTERNAL,
    header: 'Scope:',
    bullets: [
      { text: '- Complete everything the request asks for, and don\'t let any part of it quietly fall away. If more is added while you work, that adds to what you finish — it doesn\'t replace the rest, unless the requester says so.' },
      { text: '- Don\'t expand beyond what was asked: no extra features, structure, or polish the task didn\'t call for.' },
    ],
  },
  {
    id: 'disc.response',
    when: NOT_INTERNAL,
    header: 'Response shape:',
    bullets: [
      { text: '- Keep responses short and concise. Match length to the task — a one-line question gets a one-line answer.' },
      { text: '- When you reference a location, make it navigable: a file path with line number, or a URL.' },
      { text: '- Before your first action, state in one sentence what you\'re about to do. Give short progress updates at key moments — a decision, a surprise, a phase boundary. Silent is worse than brief.' },
      { text: '- Do not narrate every action, and do not narrate internal deliberation.' },
      { text: '- End-of-turn summary: one or two sentences. What changed and what\'s next.' },
      { text: '- Do not put a colon before tool calls — tool calls may not render in output, leaving a dangling colon.' },
    ],
  },
  {
    id: 'disc.actionSafety',
    when: NOT_INTERNAL,
    header: 'Action safety:',
    bullets: [
      { text: '- Reversible actions — proceed freely.' },
      { text: '- Be deliberate with hard-to-reverse or shared-state actions. Routine approval is gated by the approval layer outside your turn, so you don\'t need to ask before a normal tool call — but when an action is genuinely destructive or irreversible (deleting data, overwriting shared state, anything you can\'t take back) and the requester hasn\'t called for it, stop and confirm before you do it.' },
      { text: '- When you hit an obstacle, don\'t reach for destructive shortcuts or bypass safeguards to force it through — find the root cause.' },
    ],
  },
  {
    id: 'disc.parallelism',
    when: NOT_INTERNAL,
    header: 'Parallelism:',
    bullets: [
      { text: '- You can call multiple tools in one response. When tool calls are independent, send them as parallel tool_use blocks in a single message — never serially.' },
      { text: '- Independent reads (multiple Reads, Glob + Grep) should always run in parallel.' },
    ],
  },
  {
    id: 'disc.memoryHint',
    when: { allOf: [NOT_INTERNAL, { tool: 'MemoryRead' }] },
    header: 'Working with memory:',
    bullets: [
      { text: '- Treat any memory the framework injects as a hint to verify, not an authoritative fact. The environment may have changed since it was saved — files move, conventions drift, preferences shift. Memory shortens the lookup; it doesn\'t skip verification.' },
    ],
  },
  {
    id: 'disc.toolUsage',
    when: NOT_INTERNAL,
    header: 'Tool usage:',
    bullets: [
      { when: 'always', text: '- Prefer a direct answer when no tool is needed.' },
      { when: { tool: 'Bash' }, text: '- Prefer dedicated tools over Bash when one fits — Read instead of cat / head / tail; Grep instead of grep / rg; Glob instead of find / ls. Reserve Bash for shell-only operations — git, package managers, build / test, system diagnostics.' },
      { when: { anyTool: ['Write', 'Edit'] }, text: '- Use Edit instead of sed / awk and Write instead of echo > / heredoc. When editing files, be precise and avoid unrelated changes.' },
      { when: 'always', text: '- If a tool fails, explain the failure and recover with a narrower step — do not retry the same call.' },
      { when: { tool: 'Read' }, text: '- Visual content from Read on images / PDF page renders is transcribed by a smaller vision model. Names, numbers, and other precise tokens may have OCR errors. When an exact value matters, treat the transcription as a hint — re-render at higher fidelity or ask the requester to confirm before committing it.' },
    ],
  },
  {
    id: 'code.style',
    when: { allOf: [NOT_INTERNAL, { trait: 'authorsCode' }] },
    header: 'Code style:',
    bullets: [
      { text: '- Don\'t refactor untouched code or add abstractions beyond what the task requires — a bug fix doesn\'t need surrounding cleanup, and three similar lines beat a premature abstraction.' },
      { text: '- Don\'t add error handling, fallbacks, or validation for scenarios that can\'t happen. Trust internal code and framework guarantees; validate only at system boundaries (user input, external APIs).' },
      { text: '- Default to writing no comments. Add one only when the WHY is non-obvious — well-named identifiers already say WHAT.' },
      { text: '- Prefer editing existing files to creating new ones. Don\'t create *.md / README / CHANGELOG files unless explicitly asked.' },
      { text: '- Avoid backwards-compatibility shims and "// removed" placeholder comments. If something is unused, delete it.' },
    ],
  },
  {
    id: 'code.publishing',
    when: { allOf: [NOT_INTERNAL, { trait: 'authorsCode' }] },
    header: 'Publishing / handoff:',
    bullets: [
      { text: '- Don\'t commit, push, or open a PR — that\'s the requester\'s call, not yours. Finish the change, leave the working tree for them, and report it\'s ready to publish.' },
    ],
  },
  {
    id: 'cap.lean',
    header: 'Capabilities to lean on (when present):',
    bullets: [
      { when: { allOf: [{ kind: 'orchestrator' }, { dataPresent: 'reachableWorkers' }] }, text: '- When ## Reachable Workers is rendered above, route a sub-task to the worker whose specialty fits rather than handling it inline — your value is integrating their focused results, not doing every step yourself.' },
      { when: { allOf: [{ kind: 'worker' }, { dataPresent: 'reachableWorkers' }] }, text: '- When ## Reachable Workers is rendered above, you still do the work yourself by default — offload a sub-task to a worker only when it is heavy or clearly another specialty\'s, to keep your own context focused. Delegation is opt-in, not the default.' },
      { when: { dataPresent: 'skills' }, text: '- When ## Available Skills is rendered above, prefer a skill that matches the current work over scripting the same flow from scratch — skills tend to align with project convention and save trial-and-error.' },
      { when: { tool: 'TodoWrite' }, text: '- When TodoWrite is in your tool catalog and a task needs three or more sequential steps, open with a TodoWrite to lay them out, and keep at most one item in_progress throughout. Skip TodoWrite for single-step tasks.' },
    ],
  },
  {
    id: 'disc.sandbox',
    when: NOT_INTERNAL,
    header: 'Sandbox availability:',
    bullets: [
      { text: '- If a tool that needs the sandbox returns an error saying the sandbox image is not ready / pulling / failed / autoPull disabled, do not retry it. Tell the requester the sandbox is being prepared (or has failed and admin has been notified) and offer to continue with chat-only help — discussion, planning, explaining. Don\'t retry sandbox tools until explicitly asked.' },
    ],
  },
  {
    id: 'disc.autonomous',
    when: { kind: 'internal' },
    header: 'Autonomy:',
    bullets: [
      { text: '- You run autonomously — there is no requester to consult and no user watching, so there is no one to ask. Work only from what the request provides; when something is uncertain, make the most reasonable bounded call and move on rather than stalling. Finish the bounded task, or stop cleanly when there is nothing useful to do — never leave the pass waiting on input that will never come.' },
    ],
  },
]

function formatSharedOperatingDiscipline(facts: RoleFacts, role: Role): string {
  const include = new Set(role.sections?.include ?? [])
  const exclude = new Set(role.sections?.exclude ?? [])

  const rendered: string[] = []
  for (const block of DISCIPLINE_BLOCKS) {
    if (exclude.has(block.id)) continue
    const conditionPasses = include.has(block.id) || evaluateFragmentCondition(block.when ?? 'always', facts)
    if (!conditionPasses) continue
    const bullets = block.bullets
      .filter(bullet => evaluateFragmentCondition(bullet.when ?? 'always', facts))
      .map(bullet => bullet.text)
    if (bullets.length === 0) continue
    rendered.push([block.header, ...bullets].join('\n'))
  }
  return rendered.join('\n\n')
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
  const availableSecrets = formatAvailableSecretsSection(options?.enabledSecrets)
  if (availableSecrets) {
    variableParts.push(availableSecrets)
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
    formatAvailableSecretsSection(options?.enabledSecrets),
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
