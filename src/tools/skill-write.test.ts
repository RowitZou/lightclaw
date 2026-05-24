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
      }, callContext(ctx.cwd))

      assert.equal(result.isError, undefined)
      assert.match(String(result.output), /Saved skill "release-checklist"/)
      const saved = await readFile(
        path.join(userSkillsRoot('alice'), 'release-checklist', 'SKILL.md'),
        'utf8',
      )
      assert.match(saved, /# Release Checklist/)
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

function callContext(cwd: string): ToolCallContext {
  return {
    cwd,
    abortSignal: new AbortController().signal,
    runtime: undefined as never,
  }
}
