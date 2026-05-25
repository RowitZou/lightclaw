import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { BUNDLED_AGENTS } from '../agents/bundled/index.js'
import { builtinTools } from '../tools.js'
import { bundledSkills } from './bundled/index.js'
import { isSkillCompatibleWithRole, isSkillNameAllowedForRole } from './role-validation.js'

// Framework-level tools that legitimately surface in skill bodies as
// instructions without being part of the skill's declared workflow contract.
// - ToolSearch: dynamically injected when deferred loading is active; bodies
//   mention it as the way to load a deferred tool the agent needs (e.g.
//   skillify's "load it via ToolSearch first if it isn't in your tool list").
//   Role tool gate already governs whether the agent can actually call it.
const FRAMEWORK_EXEMPT_TOKENS = new Set<string>(['ToolSearch'])

// Only lint multi-word PascalCase tool names. Single-word tools like
// `Read` / `Write` / `Edit` / `Bash` / `Grep` / `Glob` / `Sleep` / `Dispatch`
// / `Notify` collide with common English verbs in skill prose ("Read the
// request", "Write the SKILL.md") and would generate untenable noise.
// Multi-word names (`SkillWrite`, `MemoryWrite`, `FeishuWriteDoc`,
// `AskUserQuestion`, ...) live in a unique namespace — if a body word-boundary
// matches one, the skill genuinely intends a tool call.
const MULTI_WORD_TOOL_RE = /^[A-Z][a-z]+[A-Z]/

const TOOL_NAMES: string[] = builtinTools
  .map(t => t.name)
  .filter(name => MULTI_WORD_TOOL_RE.test(name))

// Strip backtick-quoted spans before token scanning so example patterns like
// `Bash(gh:*)` or shell snippets such as `pnpm typecheck` don't trigger a
// word-boundary match on the bare head. Skills consistently put tool
// patterns / commands inside backticks; prose that genuinely teaches the
// agent to call a tool ("Read the request") is unbacktick-ed.
function stripBacktickSpans(body: string): string {
  // Triple-backtick fenced blocks first (handles SKILL.md examples and
  // skillify's frontmatter sample inside its own body), then inline `...`
  // spans. Both are non-greedy to avoid swallowing intervening prose.
  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
}

function findToolTokensInBody(body: string): Set<string> {
  const scanText = stripBacktickSpans(body)
  const found = new Set<string>()
  for (const name of TOOL_NAMES) {
    if (FRAMEWORK_EXEMPT_TOKENS.has(name)) continue
    // Word-boundary, case-sensitive: tool names are PascalCase / unique
    // enough that bare-word matches are reliable.
    const re = new RegExp(`\\b${name}\\b`)
    if (re.test(scanText)) {
      found.add(name)
    }
  }
  return found
}

describe('bundled skill ↔ role contract manifest', () => {
  it('every bundled skill named in a bundled role.skills allowlist is tool-compatible with that role', () => {
    const mismatches: string[] = []
    for (const role of BUNDLED_AGENTS) {
      for (const skill of bundledSkills) {
        if (!isSkillNameAllowedForRole(skill, role)) continue
        if (isSkillCompatibleWithRole(skill, role)) continue
        const required = skill.allowedTools?.join(',') ?? ''
        mismatches.push(
          `role="${role.agentType}" lists skill="${skill.name}" but skill requires tools [${required}] ` +
            `not all visible to that role`,
        )
      }
    }
    assert.deepEqual(
      mismatches,
      [],
      `bundled skill/role pairing mismatches (runtime currently drops these silently via stderr):\n  ${mismatches.join('\n  ')}`,
    )
  })

  it('matches the expected visibility manifest for each bundled role', () => {
    // Snapshot of which bundled skills each bundled role actually loads.
    // Update this when Phase 17 adds workflow skills or a role's
    // `skills` allowlist changes — the diff is the contract change.
    const manifest: Record<string, string[]> = {}
    for (const role of BUNDLED_AGENTS) {
      const visible = bundledSkills
        .filter(s => isSkillNameAllowedForRole(s, role) && isSkillCompatibleWithRole(s, role))
        .map(s => s.name)
        .sort()
      manifest[role.agentType] = visible
    }
    assert.deepEqual(manifest, {
      main: ['remember', 'skillify'],
      generalist: ['remember'],
      localExplorer: ['local-exploration-workflow'],
      webSearcher: ['web-research-workflow'],
      feishuSecretary: [],
      coder: ['coding-workflow', 'remember'],
      archivist: ['remember'],
      reviewer: ['pre-delivery-review-workflow', 'remember'],
      memoryExtractor: [],
      memoryCurator: [],
      skillCurator: [],
      skillConsolidator: [],
    })
  })
})

describe('bundled skill body lint', () => {
  it('every tool name word-bounded outside backticks is declared in allowed-tools', () => {
    const violations: string[] = []
    for (const skill of bundledSkills) {
      const allowed = new Set(skill.allowedTools ?? [])
      const found = findToolTokensInBody(skill.body)
      const missing = [...found].filter(name => !allowed.has(name)).sort()
      if (missing.length > 0) {
        violations.push(
          `skill="${skill.name}" body references tools [${missing.join(', ')}] not in allowed-tools ` +
            `[${[...allowed].sort().join(', ')}] — declare them or stop teaching the agent to use them`,
        )
      }
    }
    assert.deepEqual(
      violations,
      [],
      `bundled skill body lint failures (use backticks for example patterns / shell commands; ` +
        `prose mentioning a tool name implies the skill wants the agent to call it):\n  ${violations.join('\n  ')}`,
    )
  })
})
