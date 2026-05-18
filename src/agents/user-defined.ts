import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import type { Dirent } from 'node:fs'
import path from 'node:path'

import { parseFrontmatter } from '../memory/auto-memory.js'
import { lightclawHome } from '../paths.js'
import { getBundledSkillByName } from '../skill/bundled/index.js'
import { BUNDLED_AGENTS } from './bundled/index.js'
import type { OutputContract, ResumePolicy, Role, RoleKind, RoleResourceAllowlist } from './types.js'

export type UserDefinedRoleErrorReason =
  | 'yaml-parse-failed'
  | 'missing-required-field'
  | 'wildcard-tools-not-allowed'
  | 'dispatch-not-allowed-for-user-defined'
  | 'user-defined-skill-not-allowed'
  | 'mcp-not-allowed-for-non-admin-user-defined'
  | 'role-name-collision-with-bundled'
  | 'role-name-collision-with-user-defined'
  | 'invalid-kind'

export class UserDefinedRoleError extends Error {
  constructor(
    readonly reason: UserDefinedRoleErrorReason,
    readonly filePath: string,
    readonly detail?: string,
  ) {
    super(`user-defined role ${reason} at ${filePath}${detail ? `: ${detail}` : ''}`)
    this.name = 'UserDefinedRoleError'
  }
}

export type UserDefinedRoleLoadResult = {
  roles: Role[]
  errors: UserDefinedRoleError[]
}

const ROLE_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const watcherByHome = new Map<string, { root?: FSWatcher; dirs: FSWatcher[]; timer?: NodeJS.Timeout }>()

export async function loadUserDefinedRoles(home = lightclawHome()): Promise<UserDefinedRoleLoadResult> {
  const root = rolesRoot(home)
  let entries: Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { roles: [], errors: [] }
    }
    throw error
  }

  const roles: Role[] = []
  const errors: UserDefinedRoleError[] = []
  const seen = new Set<string>()
  for (const entry of entries.filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const filePath = path.join(root, entry.name, 'ROLE.md')
    try {
      await stat(filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }
      throw error
    }
    try {
      const role = await parseUserDefinedRole(filePath)
      if (seen.has(role.agentType)) {
        throw new UserDefinedRoleError('role-name-collision-with-user-defined', filePath, String(role.agentType))
      }
      seen.add(role.agentType)
      roles.push(role)
    } catch (error) {
      if (error instanceof UserDefinedRoleError) {
        errors.push(error)
      } else {
        errors.push(new UserDefinedRoleError('yaml-parse-failed', filePath, error instanceof Error ? error.message : String(error)))
      }
    }
  }
  return { roles, errors }
}

export async function parseUserDefinedRole(filePath: string): Promise<Role> {
  let parsed: ReturnType<typeof parseFrontmatter>
  try {
    parsed = parseFrontmatter(await readFile(filePath, 'utf8'))
  } catch (error) {
    throw new UserDefinedRoleError('yaml-parse-failed', filePath, error instanceof Error ? error.message : String(error))
  }

  const name = requiredString(parsed.frontmatter, 'name', filePath)
  if (!ROLE_NAME_RE.test(name)) {
    throw new UserDefinedRoleError('missing-required-field', filePath, 'name must match /^[A-Za-z][A-Za-z0-9_-]{0,63}$/')
  }
  if (BUNDLED_AGENTS.some(role => role.agentType === name)) {
    throw new UserDefinedRoleError('role-name-collision-with-bundled', filePath, name)
  }
  const tools = requiredList(parsed.frontmatter, 'tools', filePath)
  validateTools(tools, filePath)
  const skills = optionalList(parsed.frontmatter, 'skills')
  validateSkills(skills, filePath)
  const mcpServers = optionalList(parsed.frontmatter, 'mcpServers')
  validateMcpServers(mcpServers, filePath)
  const body = parsed.body.trim()
  if (!body) {
    throw new UserDefinedRoleError('missing-required-field', filePath, 'systemPrompt body')
  }

  const kind = parseKind(optionalString(parsed.frontmatter, 'kind') ?? 'worker', filePath)
  const outputContract = parseOutputContract(optionalString(parsed.frontmatter, 'outputContract'))
  const defaultResumePolicy = parseDefaultResumePolicy(optionalString(parsed.frontmatter, 'defaultResumePolicy'))
  const maxTurns = parseMaxTurns(optionalString(parsed.frontmatter, 'maxTurns'), filePath)
  return {
    agentType: name,
    name,
    kind,
    whenToUse: requiredString(parsed.frontmatter, 'whenToUse', filePath),
    description: requiredString(parsed.frontmatter, 'description', filePath),
    tools,
    ...(skills.length > 0 ? { skills } : {}),
    ...(mcpServers.length > 0 ? { mcpServers } : {}),
    ...(optionalList(parsed.frontmatter, 'hooks').length > 0 ? { hooks: optionalList(parsed.frontmatter, 'hooks') } : {}),
    ...(optionalList(parsed.frontmatter, 'reachableRoles').length > 0 ? { reachableRoles: optionalList(parsed.frontmatter, 'reachableRoles') } : {}),
    ...(outputContract ? { outputContract } : {}),
    ...(defaultResumePolicy ? { defaultResumePolicy } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    systemPrompt: body,
  }
}

export async function ensureUserDefinedRolesReadme(home = lightclawHome()): Promise<void> {
  const root = rolesRoot(home)
  await mkdir(root, { recursive: true })
  const readmePath = path.join(root, 'README.md')
  try {
    await stat(readmePath)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
  await writeFile(readmePath, `${USER_DEFINED_ROLE_README}\n`, 'utf8')
}

export function startUserDefinedRoleWatcher(input: {
  home?: string
  onReload: () => Promise<boolean>
}): void {
  const home = path.resolve(input.home ?? lightclawHome())
  if (watcherByHome.has(home)) {
    return
  }
  const state: { root?: FSWatcher; dirs: FSWatcher[]; timer?: NodeJS.Timeout } = { dirs: [] }
  watcherByHome.set(home, state)
  void installWatchers(home, state, input.onReload)
}

export function stopUserDefinedRoleWatchersForTest(home?: string): void {
  const key = home ? path.resolve(home) : undefined
  for (const [watchedHome, state] of watcherByHome) {
    if (key && watchedHome !== key) {
      continue
    }
    state.root?.close()
    for (const watcher of state.dirs) {
      watcher.close()
    }
    if (state.timer) {
      clearTimeout(state.timer)
    }
    watcherByHome.delete(watchedHome)
  }
}

async function installWatchers(
  home: string,
  state: { root?: FSWatcher; dirs: FSWatcher[]; timer?: NodeJS.Timeout },
  onReload: () => Promise<boolean>,
): Promise<void> {
  const root = rolesRoot(home)
  await mkdir(root, { recursive: true })
  const schedule = () => {
    if (state.timer) {
      clearTimeout(state.timer)
    }
    state.timer = setTimeout(() => {
      state.timer = undefined
      void onReload().then(ok => {
        if (ok) {
          void refreshDirWatchers(root, state, schedule)
        }
      })
    }, 100)
  }
  state.root = watch(root, schedule)
  await refreshDirWatchers(root, state, schedule)
}

async function refreshDirWatchers(
  root: string,
  state: { dirs: FSWatcher[] },
  schedule: () => void,
): Promise<void> {
  for (const watcher of state.dirs) {
    watcher.close()
  }
  state.dirs = []
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }
    state.dirs.push(watch(path.join(root, entry.name), schedule))
  }
}

function rolesRoot(home: string): string {
  return path.join(home, 'roles')
}

function requiredString(
  frontmatter: Record<string, string | string[]>,
  key: string,
  filePath: string,
): string {
  const value = optionalString(frontmatter, key)
  if (!value) {
    throw new UserDefinedRoleError('missing-required-field', filePath, key)
  }
  return value
}

function optionalString(frontmatter: Record<string, string | string[]>, key: string): string | undefined {
  const value = frontmatter[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function requiredList(
  frontmatter: Record<string, string | string[]>,
  key: string,
  filePath: string,
): RoleResourceAllowlist {
  const value = optionalList(frontmatter, key)
  if (value.length === 0) {
    throw new UserDefinedRoleError('missing-required-field', filePath, key)
  }
  return value
}

function optionalList(frontmatter: Record<string, string | string[]>, key: string): string[] {
  const value = frontmatter[key]
  if (Array.isArray(value)) {
    return value.map(item => item.trim()).filter(Boolean)
  }
  if (typeof value === 'string' && value.trim()) {
    return [value.trim()]
  }
  return []
}

function validateTools(tools: RoleResourceAllowlist, filePath: string): void {
  const toolList = tools as readonly string[]
  if (toolList.includes('*')) {
    throw new UserDefinedRoleError('wildcard-tools-not-allowed', filePath)
  }
  if (toolList.includes('Dispatch')) {
    throw new UserDefinedRoleError('dispatch-not-allowed-for-user-defined', filePath)
  }
}

function validateSkills(skills: string[], filePath: string): void {
  for (const skill of skills) {
    if (!getBundledSkillByName(skill)) {
      throw new UserDefinedRoleError('user-defined-skill-not-allowed', filePath, skill)
    }
  }
}

/**
 * V1 (Phase 7.5) ships only admin-owned user-defined roles at
 * `<lightclawHome>/roles/<name>/ROLE.md`. The path itself is the admin-owned
 * signal: only the daemon-process user (admin) can write into that directory
 * by default. Per `info/dev-plan-reference.md` §4.2, the `mcpServers`
 * paired-non-admin invariant is therefore vacuously true in V1 — no
 * enforcement code is needed because no paired non-admin path exists yet.
 *
 * Phase 8+ may add `<lightclawHome>/per-user/<canonical>/roles/...` for
 * paired-user-authored roles. When that lands, this validator must throw
 * `'mcp-not-allowed-for-non-admin-user-defined'` (the enum reason is already
 * defined above for forward-compat) using the caller's owner determination.
 *
 * Keeping the call site is deliberate scaffolding: it documents the V1
 * vacuous case + makes Phase 8+ a single-function diff rather than a
 * find-the-missing-hook hunt.
 */
function validateMcpServers(_mcpServers: string[], _filePath: string): void {
  // V1 no-op — all user-defined roles are admin-owned by location convention.
}

function parseKind(value: string, filePath: string): RoleKind {
  if (value === 'orchestrator' || value === 'worker' || value === 'internal') {
    return value
  }
  throw new UserDefinedRoleError('invalid-kind', filePath, value)
}

function parseOutputContract(value: string | undefined): OutputContract | undefined {
  if (value === 'report' || value === 'side-effect') {
    return value
  }
  return undefined
}

function parseDefaultResumePolicy(value: string | undefined): ResumePolicy | undefined {
  if (value === 'always' || value === 'never' || value === 'auto') {
    return value
  }
  return undefined
}

function parseMaxTurns(value: string | undefined, filePath: string): number | undefined {
  if (value === undefined) {
    return undefined
  }
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new UserDefinedRoleError('missing-required-field', filePath, 'maxTurns must be a positive integer')
  }
  return parsed
}

const USER_DEFINED_ROLE_README = `# LightClaw User-Defined Roles

LightClaw lets admins extend the bundled role roster by dropping \`<lightclawHome>/roles/<name>/ROLE.md\` files into this directory. The daemon picks them up on cold start and hot-reloads them on mtime change.

This is a thin extensibility layer — bundled roles (\`main\`, \`generalist\`, \`coder\`, \`reviewer\`, \`archivist\`, \`feishuSecretary\`, \`localExplorer\`, \`webSearcher\`, \`memoryExtractor\`, \`memoryCurator\`) stay first-class; user-defined roles are **append-only** additions.

## File format

\`<lightclawHome>/roles/<name>/ROLE.md\` is YAML frontmatter + Markdown body:

\`\`\`markdown
---
name: my-coordinator              # role agentType; camelCase or snake_case; must not collide with bundled
whenToUse: One-line description shown in catalog / dispatch context.
description: Same one-liner, used for tool catalog rendering.
tools:                            # explicit tool list — wildcard \`['*']\` is REJECTED
  - Read
  - Grep
  - MemoryWrite
  - TodoWrite
skills:                           # optional; bundled-only — \`verify\`, \`verify-env\`, \`remember\`
  - remember
kind: worker                      # 'orchestrator' | 'worker' | 'internal'; default 'worker'
hooks:                            # optional; defaults to worker policy
  - auto-compact
  - split-render
defaultResumePolicy: never        # optional; always | never | auto
maxTurns: 20                      # optional
---

You are <name>, a focused <description>.

Workflow ... (body becomes systemPrompt verbatim)
\`\`\`

## Security invariants (framework-enforced, no opt-out)

- **\`tools\` cannot be \`['*']\`** — wildcard tools on a user-defined role is unbounded privilege; you must list each tool explicitly.
- **\`tools\` cannot include \`Dispatch\`** — only bundled \`main\` / \`reviewer\` dispatch sub-roles. A user-defined role with \`Dispatch\` would let you bypass the bundled \`reachableRoles\` enforcement that protects the worker-to-worker dispatch graph.
- **\`Bash\` + destructive heads forces ask** — if your user-defined role has \`'Bash'\`, destructive heads (\`rm\` / \`dd\` / \`sudo\` / shells / package runners / wrappers / command substitution) are routed through the framework permission ask flow even if you grant "always allow" on a previous turn.
- **\`skills\` must be bundled** — only \`verify\`, \`verify-env\`, \`remember\` are loadable today. User-defined skills are a Phase 8+ feature.
- **\`mcpServers\` is admin-owned** — Phase 7.5 ships only admin-owned roles under \`<lightclawHome>/roles/\`, so the invariant is vacuously enforced; Phase 8+ per-user role paths will activate \`'mcp-not-allowed-for-non-admin-user-defined'\` directly.

Files that violate any of the above fail loudly on cold start (daemon does not start) or are silently ignored on hot reload (warning logged, previous version kept).

## Hot reload

- The daemon watches mtime on \`<lightclawHome>/roles/\`. Any change rebuilds the in-memory role roster.
- **In-flight dispatches keep their spawn-time role definition** — only the next new dispatch sees the reloaded version.
- Hot reload failures keep the previous version; cold start failures hard-fail.

## Example

\`\`\`markdown
---
name: paper-coordinator
whenToUse: User asks to coordinate paper-reading tasks (organize PDFs, summarize sections, file refs).
description: Reads papers and proposes organization actions; does not modify files itself.
tools:
  - Read
  - Grep
  - Glob
  - MemoryWrite
  - MemoryRead
  - TodoWrite
skills:
  - remember
kind: worker
maxTurns: 30
---

You are paper-coordinator, a focused reader and organizer for academic papers.

Workflow:
1. Read the request. Identify which paper(s) are in scope.
2. Use Glob to locate the PDFs under the user's reference root.
3. For each paper: Read to extract title / authors / abstract / conclusions; MemoryWrite a one-paragraph summary tied to the paper's filename.
4. Propose an organization scheme (by topic, by venue, by year) in your report. Do not move files — the requester will dispatch archivist if they want the moves executed.
\`\`\`

## Disabling / removing

Delete the \`<lightclawHome>/roles/<name>/\` directory (or move it out of \`<lightclawHome>/roles/\`). The next hot-reload tick drops the role from the roster. In-flight dispatches finish under the old definition.

## See also

- LightClaw bundled roles: \`info/lightclaw-wiki.md\`
- Security invariants source: \`lightclaw/src/agents/user-defined.ts\`
- Permission high-risk classifier: \`lightclaw/src/permission/high-risk.ts\``
