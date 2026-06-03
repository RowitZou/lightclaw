import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { userSkillsRoot } from '../identity/paths.js'
import type { Runtime } from '../runtime/index.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import type { ToolCallContext } from '../tool.js'
import { writeUserSkill } from '../skill/loader.js'
import { useSkillTool } from './use-skill.js'

const emptyRuntime = {
  workspaceRoot: '/workspace',
} as unknown as Runtime

async function withTempHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), 'lightclaw-use-skill-'))
  const prev = process.env.LIGHTCLAW_HOME
  process.env.LIGHTCLAW_HOME = home
  try {
    await fn(home)
  } finally {
    if (prev === undefined) {
      delete process.env.LIGHTCLAW_HOME
    } else {
      process.env.LIGHTCLAW_HOME = prev
    }
    await rm(home, { recursive: true, force: true })
  }
}

async function callUseSkill(home: string, name: string): Promise<string> {
  const ctx = createSessionContext({
    cwd: process.cwd(),
    model: 'claude-sonnet-4-6',
    sessionsDir: path.join(home, 'sessions'),
    memoryDir: path.join(home, 'memory', 'alice'),
    currentUserId: 'alice',
    runtime: emptyRuntime,
  })

  return await runWithSessionContext(ctx, async () => {
    const result = await useSkillTool.call(
      { name },
      {
        cwd: process.cwd(),
        abortSignal: new AbortController().signal,
        runtime: emptyRuntime,
      } satisfies ToolCallContext,
    )

    assert.equal(result.isError, undefined)
    return result.output
  })
}

describe('UseSkill transcript output', () => {
  it('wraps the loaded skill invocation in a skill-content tag', async () => {
    await withTempHome(async home => {
      await writeUserSkill({
        userId: 'alice',
        name: 'plain-skill',
        markdown:
          '---\n' +
          'name: plain-skill\n' +
          'description: Plain skill.\n' +
          '---\n\n' +
          'Follow the plain skill steps.\n',
      })

      const output = await callUseSkill(home, 'plain-skill')

      assert.match(output, /^<skill-content name="plain-skill">\n/)
      assert.match(output, /Use the skill "plain-skill" and follow its instructions for this task\./)
      assert.match(output, /Follow the plain skill steps\./)
      assert.match(output, /\n<\/skill-content>$/)
    })
  })

  it('escapes inner skill-content close tags before wrapping', async () => {
    await withTempHome(async home => {
      await writeUserSkill({
        userId: 'alice',
        name: 'closing-tag-skill',
        markdown:
          '---\n' +
          'name: closing-tag-skill\n' +
          'description: Contains a literal close tag.\n' +
          '---\n\n' +
          'Mention </skill-content> as plain text.\n',
      })

      const output = await callUseSkill(home, 'closing-tag-skill')

      assert.equal(output.match(/<\/skill-content>/g)?.length, 1)
      assert.match(output, /Mention <\\\/skill-content> as plain text\./)
      assert.match(output, /^<skill-content name="closing-tag-skill">[\s\S]*<\/skill-content>$/)
    })
  })
})

describe('UseSkill asset materialization', () => {
  it('copies skill scripts into the runtime workspace and points SKILL_DIR there', async () => {
    await withTempHome(async home => {
      await writeUserSkill({
        userId: 'alice',
        name: 'asset-skill',
        markdown:
          '---\n' +
          'name: asset-skill\n' +
          'description: Runs a helper script.\n' +
          '---\n\n' +
          'Run "${LIGHTCLAW_SKILL_DIR}/scripts/hello.sh".\n',
      })
      const scriptDir = path.join(userSkillsRoot('alice'), 'asset-skill', 'scripts')
      await mkdir(scriptDir, { recursive: true })
      const scriptPath = path.join(scriptDir, 'hello.sh')
      await writeFile(scriptPath, '#!/bin/sh\necho hi\n', 'utf8')
      await chmod(scriptPath, 0o755)

      const writes: Array<{ path: string; content: string }> = []
      const chmods: Array<{ path: string; mode: number }> = []
      const runtime = {
        workspaceRoot: '/workspace',
        fs: {
          async writeFile(pathname: string, content: Buffer | string): Promise<void> {
            writes.push({
              path: pathname,
              content: Buffer.isBuffer(content) ? content.toString('utf8') : content,
            })
          },
          async chmod(pathname: string, mode: number): Promise<void> {
            chmods.push({ path: pathname, mode })
          },
        },
      } as unknown as Runtime
      const ctx = createSessionContext({
        cwd: process.cwd(),
        model: 'claude-sonnet-4-6',
        sessionsDir: path.join(home, 'sessions'),
        memoryDir: path.join(home, 'memory', 'alice'),
        currentUserId: 'alice',
        runtime,
      })

      await runWithSessionContext(ctx, async () => {
        const result = await useSkillTool.call(
          { name: 'asset-skill' },
          {
            cwd: process.cwd(),
            abortSignal: new AbortController().signal,
            runtime,
          } satisfies ToolCallContext,
        )

        assert.equal(result.isError, undefined)
        assert.match(
          result.output,
          /Run "\/workspace\/\.lightclaw\/skill-run\/asset-skill\/scripts\/hello\.sh"/,
        )
      })

      assert.deepEqual(writes, [
        {
          path: '/workspace/.lightclaw/skill-run/asset-skill/scripts/hello.sh',
          content: '#!/bin/sh\necho hi\n',
        },
      ])
      assert.deepEqual(chmods, [
        {
          path: '/workspace/.lightclaw/skill-run/asset-skill/scripts/hello.sh',
          mode: 0o755,
        },
      ])
    })
  })
})
