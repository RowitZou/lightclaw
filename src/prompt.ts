import { platform } from 'node:process'

import type { AgentDefinition } from './agents/types.js'
import type { LightClawConfig } from './config.js'
import { memoryAge, memoryFreshnessText } from './memory/aging.js'
import { loadMemoryIndex } from './memory/auto-memory.js'
import { loadProjectMemory } from './memory/discovery.js'
import { selectRelevantMemories } from './memory/recall.js'
import { readSessionMemory } from './memory/session-memory.js'
import type { MemoryEntry } from './memory/types.js'
import { getMcpRegistrySnapshot } from './mcp/index.js'
import { modelFor } from './provider/index.js'
import {
  getAllPermissionRules,
  getCurrentUserId,
  getMemoryDir,
  getPermissionMode,
} from './state.js'
import {
  listRegisteredSkills,
  refreshSkillRegistry,
} from './skill/registry.js'
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
  discoveredTools?: ReadonlySet<string>
}

function formatSkillsSection(): string {
  const skills = listRegisteredSkills()
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

// Tool catalog: name + 1-line description only. Full input schema travels via
// the API native `tools` parameter; duplicating it in the prompt wastes tokens
// and breaks the cache on any schema tweak.
function formatToolCatalog(tools: Tool[]): string {
  return tools
    .map(tool => `- ${tool.name}: ${tool.description}`)
    .join('\n')
}

function formatTodoSection(todos: TodoItem[]): string {
  if (todos.length === 0) {
    return ''
  }

  return [
    '## Current Todo List',
    formatTodosForPrompt(todos),
    'Use TodoWrite to keep this list current. Keep at most one item in_progress.',
  ].join('\n')
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

  const rules = getAllPermissionRules()
  const allowCount = rules.filter(rule => rule.behavior === 'allow').length
  const denyCount = rules.filter(rule => rule.behavior === 'deny').length
  const lines = [
    '## Permission Mode',
    `Current mode: ${mode}`,
    isSubagent
      ? 'Subagent permission checks are non-interactive; confirmation requests are denied automatically.'
      : `Rule summary: ${allowCount} allow, ${denyCount} deny across all sources.`,
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
  await refreshSkillRegistry(cwd)
  const memoryDir = getMemoryDir()
  const recallEnabled =
    options.autoMemory
    && options.config.memoryRecall.enabled
    && Boolean(options.queryText && options.queryText.trim().length > 0)
  const sessionMemoryEnabled =
    options.config.sessionMemory.enabled && Boolean(options.sessionId)
  const [projectMemory, autoMemoryIndex, recalledMemories, sessionMemory] = await Promise.all([
    loadProjectMemory(cwd),
    options.autoMemory ? loadMemoryIndex(memoryDir) : Promise.resolve(''),
    recallEnabled
      ? selectRelevantMemories(options.queryText!, memoryDir, options.config, {
          topN: options.config.memoryRecall.topN,
        })
      : Promise.resolve([] as MemoryEntry[]),
    sessionMemoryEnabled
      ? readSessionMemory(options.sessionId!, options.config.sessionsDir)
      : Promise.resolve(''),
  ])

  const preTodoSections: string[] = [
    'You are LightClaw, a personal assistant running across terminal and chat channels.',
    'You help the current user inside their private LightClaw workspace. Do not frame yourself as a project-directory coding console unless the user asks for code work.',
    '',
    `Workspace directory: ${environmentRoot}`,
    `Current LightClaw user: ${getCurrentUserId() ?? 'unbound'}`,
    formatCurrentDateLine(),
    `Platform: ${platform}`,
    `Model: ${modelFor('main', options.config)}`,
  ]

  if (projectMemory.trim().length > 0) {
    preTodoSections.push('', '## Project Memory', projectMemory)
  }

  if (options.autoMemory && autoMemoryIndex.trim().length > 0) {
    preTodoSections.push('', '## Auto Memory Index', autoMemoryIndex)
  }

  if (recalledMemories.length > 0) {
    const trimmedQuery = (options.queryText ?? '').replace(/\s+/g, ' ').slice(0, 80)
    preTodoSections.push(
      '',
      '## Relevant Memories',
      `<!-- selected by recall on query "${trimmedQuery}" -->`,
    )
    for (const memory of recalledMemories) {
      const age = memoryAge(memory.mtimeMs)
      const heading =
        age === 'today'
          ? `### ${memory.filename}`
          : `### ${memory.filename} (saved ${age})`
      preTodoSections.push('', heading, memory.content)
      const staleness = memoryFreshnessText(memory.mtimeMs)
      if (staleness) {
        preTodoSections.push('', `<system-reminder>${staleness}</system-reminder>`)
      }
    }
  }

  if (sessionMemory.trim().length > 0) {
    preTodoSections.push('', '## Session Working Memory', sessionMemory.trim())
  }

  preTodoSections.push(
    '',
    '## Available Skills',
    formatSkillsSection(),
    'Use skills naturally: when a skill description matches the task, call UseSkill automatically before proceeding. The user does not need to invoke skills explicitly.',
    'After UseSkill returns a skill with allowed_tools, stay within that tool boundary for the rest of the task unless another skill is loaded.',
    'To save durable notes for later sessions, use the MemoryWrite tool.',
    'Memory and Conversation tools are scoped to the current LightClaw user. File tools and Bash are hard-limited to the current user workspace, even in bypassPermissions mode.',
  )

  const permissionSection = formatPermissionSection()
  if (permissionSection) {
    preTodoSections.push('', permissionSection)
  }

  const mcpSection = formatMcpSection()
  if (mcpSection) {
    preTodoSections.push('', mcpSection)
  }

  const postTodoSections: string[] = [
    'Working style:',
    '- For exploratory questions ("how should we approach X?", "what do you think?"), respond in 2-3 sentences with a recommendation and the main tradeoff. Don\'t implement until the user agrees.',
    '- Don\'t add features, refactor, or introduce abstractions beyond what the task requires. A bug fix doesn\'t need surrounding cleanup. Three similar lines is better than a premature abstraction.',
    '- Don\'t add error handling, fallbacks, or validation for scenarios that can\'t happen. Trust internal code and framework guarantees. Only validate at system boundaries (user input, external APIs).',
    '- Default to writing no comments. Add one only when the WHY is non-obvious (a hidden constraint, a workaround, surprising behavior). Don\'t explain WHAT the code does — well-named identifiers do that.',
    '- Prefer editing existing files to creating new ones. Don\'t create *.md / README / CHANGELOG files unless the user explicitly asks.',
    '- Avoid backwards-compatibility shims and "// removed" placeholder comments. If something is unused, delete it.',
    '',
    'Tone:',
    '- Keep responses short and concise. Match length to the task — a one-line question gets a one-line answer.',
    '- Reference code with file_path:line_number for navigability.',
    '- Before the first tool call, state in one sentence what you\'re about to do. Give short progress updates at key moments (a decision, a surprise, a phase boundary) — silent is worse than brief.',
    '- Don\'t narrate internal deliberation. User-facing text should be useful communication, not commentary on your thought process.',
    '- End-of-turn summary: one or two sentences. What changed and what\'s next. Nothing else.',
    '- Do not put a colon before tool calls — tool calls may not render in output, leaving a dangling colon.',
    '',
    'Action safety:',
    '- Local reversible actions (edits, tests, reads) — proceed freely.',
    '- Hard-to-reverse or shared-state actions (git push, force-push, package upgrades, channel messages outside the agent reply, dropping tables) — confirm with the user first unless explicitly authorized.',
    '- When you hit an obstacle, do not use destructive actions (like --no-verify, --force) as a shortcut. Identify the root cause.',
    '',
    'Parallelism:',
    '- You can call multiple tools in one response. When tool calls are independent, send them as parallel tool_use blocks in a single message — never serially.',
    '- Independent reads (multiple Reads, Glob + Grep) should always run in parallel.',
    '- Subagent forks for independent research questions should also fan out in parallel.',
    '',
    'Tool usage rules:',
    '- Prefer direct answers when no tool is needed.',
    '- Use tools when the answer depends on workspace filesystem or shell state.',
    '- When editing files, be precise and avoid unrelated changes.',
    '- If a tool fails, explain the failure and recover with a narrower step.',
    '- Memory may be stale; verify remembered details before acting on them.',
    // Bug 10 in 2026-05-10 audit: visual content rendered to text by Read on
    // images / PDF page renders is transcribed by a smaller vision model.
    // Treat its output as a hint, not as ground truth, for any precise token
    // — main agent was copying "Suhiln Cao" / "Unslo th" verbatim into
    // answers because the OCR string was indistinguishable from a tool's
    // exact return value.
    '- Visual content described by Read on images / PDF page renders is transcribed by a smaller vision model. Names, numbers, identifiers, and other precise tokens in such transcriptions may have OCR errors. When the user is asking for an exact name / value / spelling, treat sub-LLM transcription as a hint rather than ground truth — re-render at higher fidelity (Read with `pages=` / different page range) or ask the user to confirm before committing the value to a final answer. Tokens flagged as `[unclear: ...]` MUST be re-rendered or confirmed before citing.',
    '',
    'Sandbox availability:',
    '- If an environment-domain tool (Bash, Read, Write, Edit, Grep, Glob, WebFetch, WebSearch) returns an error mentioning "Sandbox 镜像" being not ready / pulling / failed / autoPull disabled, do not retry that tool.',
    '- Acknowledge the situation to the user (sandbox is being prepared, or has failed and admin has been notified) and offer to continue with chat-only assistance — discussion, planning, explaining concepts.',
    '- Do not attempt environment-domain tools again until the user explicitly asks you to retry.',
    '',
    'Available tools:',
  ]

  return {
    preTodos: preTodoSections.join('\n'),
    postTodos: postTodoSections.join('\n'),
  }
}

export function renderSystemPrompt(
  template: SystemPromptTemplate,
  todos: TodoItem[],
  options?: SystemPromptRenderOptions,
): string {
  const todoSection = formatTodoSection(todos)
  const middle = todoSection ? `\n\n${todoSection}` : ''
  const tools = options?.tools ?? []
  const toolDescriptions = formatToolCatalog(tools)
  const base = `${template.preTodos}${middle}\n\n${template.postTodos}\n${toolDescriptions}`
  return appendDeferredToolsReminder(
    base,
    options?.deferredTools ?? [],
    options?.discoveredTools ?? new Set(),
  )
}

export function buildSubagentPrompt(
  tools: Tool[],
  environmentRoot: string,
  agent: AgentDefinition,
): string {
  const toolDescriptions = formatToolCatalog(tools)

  const permissionSection = formatPermissionSection(true)
  const sections: string[] = [
    'You are LightClaw running as an isolated subagent.',
    `Working directory: ${environmentRoot}`,
    formatCurrentDateLine(),
    `Platform: ${platform}`,
    '',
    agent.systemPrompt,
  ]

  if (permissionSection) {
    sections.push('', permissionSection)
  }

  sections.push(
    '',
    'Tool usage rules:',
    '- Prefer direct answers when no tool is needed.',
    '- Use tools when the answer depends on filesystem or shell state.',
    '- Report concise findings to the parent agent.',
    '',
    'Available tools:',
    toolDescriptions,
  )

  return sections.join('\n')
}

function appendDeferredToolsReminder(
  prompt: string,
  deferredTools: readonly Tool[],
  discoveredTools: ReadonlySet<string>,
): string {
  const undiscovered = deferredTools.filter(tool => !discoveredTools.has(tool.name))
  if (undiscovered.length === 0) {
    return prompt
  }
  return `${prompt}\n\n<system-reminder>
The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded. Calling them directly will fail. Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:
${undiscovered.map(tool => tool.name).join('\n')}
</system-reminder>`
}
