import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { LightClawConfig } from '../config.js'
import { createUser, getIdentity, setAdmin } from '../identity/store.js'
import { userSkillsRoot } from '../identity/paths.js'
import { setLightclawHomeOverride } from '../paths.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { createBuiltinReplRegistry } from './builtin.js'
import type { ReplContext } from './registry.js'

let home = ''

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'lightclaw-user-config-skill-'))
  setLightclawHomeOverride(home)
  writeFileSync(path.join(home, 'config.json'), JSON.stringify(baseConfig()))
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(home, { recursive: true, force: true })
})

describe('PR5 user config and skill slash commands', () => {
  it('shows the current user directories and first-run dataRoot hint', async () => {
    await createUser('alice')

    const output = await runSlash('/config show', { userId: 'alice', isAdmin: false })

    assert.match(output, /dataRoot=\(not set; using default userHome\)/)
    assert.match(output, new RegExp(`userHome=${escapeRegExp(path.join(home, 'users', 'alice'))}`))
    assert.match(output, new RegExp(`workspace=${escapeRegExp(path.join(home, 'workspace', 'alice'))}`))
    assert.match(output, /setupHint=No custom dataRoot is set/)
  })

  it('tells the user to create the dataRoot directory before requesting it', async () => {
    await createUser('alice')
    const missing = path.join(home, 'missing-alice-root')

    const output = await runSlash('/config set-home ' + missing, { userId: 'alice', isAdmin: false })

    assert.match(output, /dataRoot path does not exist/)
    assert.match(output, /Create the directory first/)
  })

  it('records a dataRoot request and lets admin approve it', async () => {
    await createUser('alice')
    await setAdmin('admin')
    const target = path.join(home, 'external-alice')
    mkdirSync(target)

    const userOut = await runSlash('/config set-home ' + target, { userId: 'alice', isAdmin: false })
    const adminOut = await runSlash('/user home-requests\n/user approve-home alice', { userId: 'admin', isAdmin: true })

    assert.match(userOut, /Requested dataRoot change/)
    assert.match(adminOut, /Pending dataRoot requests/)
    assert.match(adminOut, /Approved alice dataRoot/)
    assert.equal((await getIdentity('alice'))?.dataRoot, target)
  })

  it('lists and deletes only user skills', async () => {
    await createUser('alice')
    const skillDir = path.join(userSkillsRoot('alice'), 'demo-skill')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(path.join(skillDir, 'SKILL.md'), [
      '---',
      'name: demo-skill',
      'description: Demo skill.',
      '---',
      '',
      '# Demo',
      '',
    ].join('\n'))

    const output = await runSlash('/skill list\n/skill view demo-skill\n/skill delete demo-skill\n/skill list', {
      userId: 'alice',
      isAdmin: false,
    })

    assert.match(output, /demo-skill source=user/)
    assert.match(output, /# Demo/)
    assert.match(output, /Deleted user skill "demo-skill"/)
    assert.match(output, /No skills found|source=builtin/)
  })
})

async function runSlash(commands: string, opts: { userId: string; isAdmin: boolean }): Promise<string> {
  const chunks: string[] = []
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk))
      callback()
    },
  })
  const session = createSessionContext({
    config: baseConfig(),
    cwd: path.join(home, 'workspace'),
    model: 'fake',
    sessionsDir: path.join(home, 'sessions'),
    memoryDir: path.join(home, 'memory'),
    currentUserId: opts.userId,
    sessionId: `s-${opts.userId}`,
    permissionCeiling: 'bypassPermissions',
  })
  await runWithSessionContext(session, async () => {
    const registry = createBuiltinReplRegistry()
    for (const command of commands.split('\n').filter(Boolean)) {
      await registry.dispatch(command, {
        config: session.config!,
        sessionId: session.sessionId,
        createdAt: Date.now(),
        messages: [],
        output,
        userId: opts.userId,
        isAdmin: opts.isAdmin,
        isChannel: true,
        getActiveTools: () => [],
        setActiveTools() {},
        async persistMeta() {},
      } satisfies ReplContext)
    }
  })
  return chunks.join('')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function baseConfig(): LightClawConfig {
  return {
    lang: 'cn',
    defaultModel: 'fake',
    endpoints: { fake: { apiKey: 'sk-fake' } },
    models: {
      fake: { endpoint: 'fake', schema: 'anthropic', upstreamModel: 'fake' },
    },
    permissionMode: 'default',
    permissionCeiling: 'bypassPermissions',
    paths: { permissionRules: {}, workspace: path.join(home, 'workspace') },
    runtime: { backend: 'local' },
  } as unknown as LightClawConfig
}
