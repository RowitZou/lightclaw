import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { userSkillsRoot } from '../identity/paths.js'
import { setLightclawHomeOverride } from '../paths.js'
import { getRegisteredSkill } from '../skill/registry.js'
import type { ToolCallContext } from '../tool.js'
import { skillWriteTool } from './skill-write.js'

async function withTempHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), 'lightclaw-skill-write-'))
  setLightclawHomeOverride(home)
  try {
    await fn(home)
  } finally {
    setLightclawHomeOverride(undefined)
    await rm(home, { recursive: true, force: true })
  }
}

test('SkillWrite writes a per-user skill and refreshes the registry', async () => {
  await withTempHome(async home => {
    const ctx = createSessionContext({
      cwd: path.join(home, 'workspace'),
      model: 'claude-sonnet-4-6',
      sessionsDir: path.join(home, 'sessions'),
      memoryDir: path.join(home, 'memory', 'alice'),
      currentUserId: 'alice',
      sessionId: 'skill-write-test',
    })

    await runWithSessionContext(ctx, async () => {
      const result = await skillWriteTool.call({
        name: 'release-checklist',
        markdown:
          '---\n' +
          'name: release-checklist\n' +
          'description: Prepare a release.\n' +
          'when_to_use: Use when preparing a release branch.\n' +
          'allowed-tools:\n' +
          '  - Read\n' +
          '---\n\n' +
          '# Release Checklist\n',
        files: [
          { path: 'scripts/release.py', content: 'print("release")\n' },
          { path: 'references/notes.md', content: '# Notes\n' },
        ],
      }, callContext(ctx.cwd))

      assert.equal(result.isError, undefined)
      assert.match(String(result.output), /Saved skill "release-checklist"/)
      const saved = await readFile(
        path.join(userSkillsRoot('alice'), 'release-checklist', 'SKILL.md'),
        'utf8',
      )
      assert.match(saved, /# Release Checklist/)
      assert.equal(
        await readFile(
          path.join(userSkillsRoot('alice'), 'release-checklist', 'scripts', 'release.py'),
          'utf8',
        ),
        'print("release")\n',
      )
      assert.equal(
        await readFile(
          path.join(userSkillsRoot('alice'), 'release-checklist', 'references', 'notes.md'),
          'utf8',
        ),
        '# Notes\n',
      )
      assert.equal(getRegisteredSkill('release-checklist')?.source, 'user')
    })
  })
})

test('SkillWrite rejects missing user context, shell injection, invalid names, and accidental overwrite', async () => {
  await withTempHome(async home => {
    const noUser = await skillWriteTool.call({
      name: 'no-user',
      markdown: '---\nname: no-user\ndescription: Missing user.\n---\n\nBody.\n',
    }, callContext(home))
    assert.equal(noUser.isError, true)
    assert.match(String(noUser.output), /requires an active LightClaw user identity/)

    const ctx = createSessionContext({
      cwd: path.join(home, 'workspace'),
      model: 'claude-sonnet-4-6',
      sessionsDir: path.join(home, 'sessions'),
      memoryDir: path.join(home, 'memory', 'alice'),
      currentUserId: 'alice',
      sessionId: 'skill-write-errors',
    })

    await runWithSessionContext(ctx, async () => {
      const invalidName = await skillWriteTool.call({
        name: '../escape',
        markdown: '---\nname: ../escape\ndescription: Bad.\n---\n\nBody.\n',
      }, callContext(ctx.cwd))
      assert.equal(invalidName.isError, true)
      assert.match(String(invalidName.output), /kebab-case identifier/)

      const shellInjection = await skillWriteTool.call({
        name: 'shell-hint',
        markdown: '---\nname: shell-hint\ndescription: Bad.\n---\n\nRun !`rm -rf /`.\n',
      }, callContext(ctx.cwd))
      assert.equal(shellInjection.isError, true)
      assert.match(String(shellInjection.output), /shell-injection syntax/)

      const markdown = '---\nname: repeatable\ndescription: First.\n---\n\nBody.\n'
      assert.equal((await skillWriteTool.call({
        name: 'repeatable',
        markdown,
      }, callContext(ctx.cwd))).isError, undefined)
      const duplicate = await skillWriteTool.call({
        name: 'repeatable',
        markdown,
      }, callContext(ctx.cwd))
      assert.equal(duplicate.isError, true)
      assert.match(String(duplicate.output), /already exists/)

      const overwrite = await skillWriteTool.call({
        name: 'repeatable',
        markdown: '---\nname: repeatable\ndescription: Revised.\n---\n\nNew body.\n',
        overwrite: true,
      }, callContext(ctx.cwd))
      assert.equal(overwrite.isError, undefined)
    })
  })
})

test('SkillWrite suggests per-skill permission rules', () => {
  assert.deepEqual(skillWriteTool.suggestPermissionRules?.({
    name: 'release-checklist',
    markdown: '---\nname: release-checklist\ndescription: Release.\n---\n\nBody.\n',
  }), [{ toolName: 'SkillWrite', ruleContent: 'release-checklist' }])
})

test('SkillWrite accepts flow-style YAML roles array (regression for 2026-05-26 dogfood)', async () => {
  await withTempHome(async home => {
    const ctx = createSessionContext({
      cwd: path.join(home, 'workspace'),
      model: 'claude-sonnet-4-6',
      sessionsDir: path.join(home, 'sessions'),
      memoryDir: path.join(home, 'memory', 'alice'),
      currentUserId: 'alice',
      sessionId: 'skill-write-flow-roles',
    })

    await runWithSessionContext(ctx, async () => {
      const single = await skillWriteTool.call({
        name: 'alphaxiv-flow-single',
        markdown:
          '---\nname: alphaxiv-flow-single\ndescription: Single-element flow-style array.\nroles: [main]\n---\n\nBody.\n',
      }, callContext(ctx.cwd))
      assert.equal(single.isError, undefined, String(single.output))
      assert.match(String(single.output), /Saved skill "alphaxiv-flow-single"/)

      const multi = await skillWriteTool.call({
        name: 'alphaxiv-flow-multi',
        markdown:
          '---\nname: alphaxiv-flow-multi\ndescription: Multi-element flow-style array.\nroles: [main, generalist]\n---\n\nBody.\n',
      }, callContext(ctx.cwd))
      assert.equal(multi.isError, undefined, String(multi.output))
    })
  })
})

test('SkillWrite frontmatter error message names expected shape and shows actual value', async () => {
  await withTempHome(async home => {
    const ctx = createSessionContext({
      cwd: path.join(home, 'workspace'),
      model: 'claude-sonnet-4-6',
      sessionsDir: path.join(home, 'sessions'),
      memoryDir: path.join(home, 'memory', 'alice'),
      currentUserId: 'alice',
      sessionId: 'skill-write-roles-error',
    })

    await runWithSessionContext(ctx, async () => {
      const bad = await skillWriteTool.call({
        name: 'roles-bad-shape',
        markdown:
          '---\nname: roles-bad-shape\ndescription: Roles must be a list.\nroles: 12345\n---\n\nBody.\n',
      }, callContext(ctx.cwd))
      assert.equal(bad.isError, true)
      const msg = String(bad.output)
      assert.match(msg, /roles/i)
      assert.match(msg, /YAML list/i)
      assert.match(msg, /e\.g\./i, 'error message should include a concrete example shape')
      assert.match(msg, /12345/, 'error message should echo the actual value that failed')
    })
  })
})

test('SkillWrite records a skill-ops audit row on success (2026-05-28 audit coverage)', async () => {
  await withTempHome(async home => {
    const ctx = createSessionContext({
      cwd: path.join(home, 'workspace'),
      model: 'claude-sonnet-4-6',
      sessionsDir: path.join(home, 'sessions'),
      memoryDir: path.join(home, 'memory', 'alice'),
      currentUserId: 'alice',
      sessionId: 'skill-write-audit',
    })

    await runWithSessionContext(ctx, async () => {
      const result = await skillWriteTool.call({
        name: 'audited-skill',
        markdown: '---\nname: audited-skill\ndescription: Audited write.\n---\n\nBody.\n',
        files: [{ path: 'scripts/audit.py', content: 'print("audit")\n' }],
      }, callContext(ctx.cwd))
      assert.equal(result.isError, undefined)
    })

    // Pre-fix: SkillWrite wrote nothing to audit → this readFile throws ENOENT.
    const day = new Date().toISOString().slice(0, 10)
    const raw = await readFile(path.join(home, 'audit', 'skill-ops', `${day}.jsonl`), 'utf8')
    const rows = raw.trim().split('\n').map(line => JSON.parse(line))
    const write = rows.find(r => r.tool === 'SkillWrite' && r.status === 'written')
    assert.ok(write, 'expected a written skill-ops audit row')
    assert.equal(write.name, 'audited-skill')
    assert.equal(write.userId, 'alice')
    assert.match(String(write.filePath), /audited-skill\/SKILL\.md$/)
    assert.equal(write.fileCount, 1)
    assert.deepEqual(write.files, ['scripts/audit.py'])
  })
})

function callContext(cwd: string): ToolCallContext {
  return {
    cwd,
    abortSignal: new AbortController().signal,
    runtime: undefined as never,
  }
}

test('a non-internal caller may only save a skill for its own role', async () => {
  await withTempHome(async home => {
    const ctx = createSessionContext({
      cwd: path.join(home, 'workspace'),
      model: 'claude-sonnet-4-6',
      sessionsDir: path.join(home, 'sessions'),
      memoryDir: path.join(home, 'memory', 'alice'),
      currentUserId: 'alice',
      sessionId: 'skill-write-own-role',
    })
    ctx.currentRole = {
      agentType: 'coder',
      name: 'coder',
      kind: 'worker',
      tools: ['SkillWrite'],
      skills: [],
      mcpServers: [],
      hooks: [],
      outputContract: 'report',
    } as never

    await runWithSessionContext(ctx, async () => {
      // Whatever roles the markdown carries (someone else's, or none at all —
      // which would default to main), the file lands stamped with the caller.
      const crossRole = await skillWriteTool.call({
        name: 'their-flow',
        markdown:
          '---\n' +
          'name: their-flow\n' +
          'description: a flow for someone else\n' +
          'when_to_use: Use when testing.\n' +
          'roles:\n  - generalist\n' +
          '---\n\n# Their Flow\nBody.\n',
      }, { cwd: ctx.cwd } as never)
      if (crossRole.isError === true) throw new Error(`stamped save should pass: ${crossRole.output}`)
      const theirs = await readFile(
        path.join(home, 'identity', 'per-user', 'alice', 'skills', 'their-flow', 'SKILL.md'), 'utf8')
      if (!/roles:\n  - coder/.test(theirs)) throw new Error(`expected coder stamp, got:\n${theirs}`)
      if (theirs.includes('generalist')) throw new Error('foreign role must be replaced')

      const defaulted = await skillWriteTool.call({
        name: 'default-flow',
        markdown:
          '---\n' +
          'name: default-flow\n' +
          'description: no roles written\n' +
          'when_to_use: Use when testing.\n' +
          '---\n\n# Default Flow\nBody.\n',
      }, { cwd: ctx.cwd } as never)
      if (defaulted.isError === true) throw new Error(`defaulted save should pass: ${defaulted.output}`)
      const mine = await readFile(
        path.join(home, 'identity', 'per-user', 'alice', 'skills', 'default-flow', 'SKILL.md'), 'utf8')
      if (!/roles:\n  - coder/.test(mine)) throw new Error(`expected coder stamp, got:\n${mine}`)
    })
  })
})

test('revising an existing skill preserves its roles and refuses non-members', async () => {
  await withTempHome(async home => {
    const base = {
      cwd: path.join(home, 'workspace'),
      model: 'claude-sonnet-4-6',
      sessionsDir: path.join(home, 'sessions'),
      memoryDir: path.join(home, 'memory', 'alice'),
      currentUserId: 'alice',
    }
    const asRole = (agentType: string) => {
      const ctx = createSessionContext({ ...base, sessionId: `revise-${agentType}` })
      ctx.currentRole = {
        agentType, name: agentType, kind: 'worker',
        tools: ['SkillWrite'], skills: [], mcpServers: [], hooks: [], outputContract: 'report',
      } as never
      return ctx
    }
    const skillPath = path.join(home, 'identity', 'per-user', 'alice', 'skills', 'shared-flow', 'SKILL.md')
    // Seed a consolidator-style multi-role skill (internal callers are unstamped).
    await mkdir(path.dirname(skillPath), { recursive: true })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(skillPath,
      '---\nname: shared-flow\ndescription: shared\nwhen_to_use: Use when testing.\nroles:\n  - coder\n  - generalist\n---\n\n# Shared\nv1.\n')

    await runWithSessionContext(asRole('coder'), async () => {
      const revised = await skillWriteTool.call({
        name: 'shared-flow', overwrite: true,
        markdown: '---\nname: shared-flow\ndescription: shared\nwhen_to_use: Use when testing.\n---\n\n# Shared\nv2 by coder.\n',
      }, { cwd: base.cwd } as never)
      if (revised.isError === true) throw new Error(`member revise should pass: ${revised.output}`)
    })
    const afterRevise = await readFile(skillPath, 'utf8')
    if (!/roles:\n  - coder\n  - generalist/.test(afterRevise)) throw new Error(`union must survive:\n${afterRevise}`)
    if (!afterRevise.includes('v2 by coder')) throw new Error('body must update')

    await runWithSessionContext(asRole('reviewer'), async () => {
      const hijack = await skillWriteTool.call({
        name: 'shared-flow', overwrite: true,
        markdown: '---\nname: shared-flow\ndescription: shared\nwhen_to_use: Use when testing.\n---\n\n# Shared\nv3 by reviewer.\n',
      }, { cwd: base.cwd } as never)
      if (hijack.isError !== true) throw new Error('non-member revise must be refused')
      if (!String(hijack.output).includes('not yours to revise')) throw new Error(`unexpected: ${hijack.output}`)
    })
  })
})
