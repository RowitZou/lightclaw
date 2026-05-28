import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { userSkillsRoot } from '../identity/paths.js'
import type { Runtime } from '../runtime/index.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import type { ToolCallContext } from '../tool.js'
import { writeUserSkill } from '../skill/loader.js'
import { useSkillTool } from './use-skill.js'

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
      await writeFile(path.join(scriptDir, 'hello.sh'), '#!/bin/sh\necho hi\n', 'utf8')

      const writes: Array<{ path: string; content: string }> = []
      const runtime = {
        workspaceRoot: '/workspace',
        fs: {
          async writeFile(pathname: string, content: Buffer | string): Promise<void> {
            writes.push({
              path: pathname,
              content: Buffer.isBuffer(content) ? content.toString('utf8') : content,
            })
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
    })
  })
})
