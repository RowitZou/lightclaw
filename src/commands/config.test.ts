import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { LightClawConfig } from '../config.js'
import { setLang } from '../i18n/index.js'
import { userConfigPath } from '../identity/paths.js'
import { createUser, setUserPermissionCeiling } from '../identity/store.js'
import { loadIdentityPreferences } from '../identity/preferences.js'
import { loadIdentityRules } from '../permission/storage.js'
import { setLightclawHomeOverride } from '../paths.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { getModel, getPermissionMode } from '../state.js'
import { runConfigCommand, validateWorkspacePath } from './config.js'

let tmpHome = ''
let gpfsRoot = ''

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-config-command-'))
  gpfsRoot = path.join(tmpHome, 'gpfs')
  mkdirSync(gpfsRoot, { recursive: true })
  setLightclawHomeOverride(tmpHome)
  setLang('en')
})

afterEach(() => {
  setLang('cn')
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
})

describe('validateWorkspacePath', () => {
  it('passes for a real directory on a non-cluster (local) backend', async () => {
    const dir = path.join(tmpHome, 'local-ws')
    mkdirSync(dir, { recursive: true })
    assert.equal(await validateWorkspacePath(dir, localConfig()), null)
  })

  it('rejects a non-existent path', async () => {
    const result = await validateWorkspacePath(path.join(tmpHome, 'does-not-exist'), localConfig())
    assert.ok(result)
    assert.match(result!, /cannot access/)
  })

  it('rejects a path outside the gpfs prefix on a cluster backend', async () => {
    const outside = path.join(tmpHome, 'not-gpfs')
    mkdirSync(outside, { recursive: true })
    const result = await validateWorkspacePath(outside, clusterConfig())
    assert.ok(result)
    assert.match(result!, /gpfs host prefix/)
  })

  it('passes for a directory under the gpfs prefix on a cluster backend', async () => {
    const inside = path.join(gpfsRoot, 'collab')
    mkdirSync(inside, { recursive: true })
    assert.equal(await validateWorkspacePath(inside, clusterConfig()), null)
  })
})

describe('/config set-workspace', () => {
  it('writes .workspace into users/<u>/config.json and echoes entry count', async () => {
    const ws = path.join(gpfsRoot, 'shared')
    mkdirSync(path.join(ws, 'a'), { recursive: true })
    mkdirSync(path.join(ws, 'b'), { recursive: true })

    const out = await runConfigCommand(`set-workspace ${ws}`, { config: clusterConfig(), userId: 'alice' })
    assert.match(out, /Workspace directory set to/)
    assert.match(out, /contains 2 entries/)
    assert.match(out, /restart/)

    const persisted = JSON.parse(readFileSync(userConfigPath('alice'), 'utf8'))
    assert.equal(persisted.workspace, ws)
  })

  it('reports an empty workspace directory', async () => {
    const ws = path.join(gpfsRoot, 'empty')
    mkdirSync(ws, { recursive: true })
    const out = await runConfigCommand(`set-workspace ${ws}`, { config: clusterConfig(), userId: 'bob' })
    assert.match(out, /is currently empty/)
    assert.equal(JSON.parse(readFileSync(userConfigPath('bob'), 'utf8')).workspace, ws)
  })

  it('rejects an invalid path with a reason and does NOT write the file', async () => {
    const out = await runConfigCommand(
      `set-workspace ${path.join(tmpHome, 'no-such-dir')}`,
      { config: clusterConfig(), userId: 'carol' },
    )
    assert.match(out, /gpfs host prefix|cannot access/)
    assert.equal(existsSync(userConfigPath('carol')), false)
  })

  it('rejects a relative path', async () => {
    const out = await runConfigCommand('set-workspace ./relative', { config: localConfig(), userId: 'dave' })
    assert.match(out, /must be an absolute path/)
    assert.equal(existsSync(userConfigPath('dave')), false)
  })

  it('preserves unrelated keys when writing .workspace', async () => {
    const ws = path.join(gpfsRoot, 'keep')
    mkdirSync(ws, { recursive: true })
    // Pre-seed config.json with an unrelated key the writer must round-trip.
    mkdirSync(path.dirname(userConfigPath('erin')), { recursive: true })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(userConfigPath('erin'), JSON.stringify({ keepMe: 42 }), 'utf8')

    await runConfigCommand(`set-workspace ${ws}`, { config: clusterConfig(), userId: 'erin' })
    const persisted = JSON.parse(readFileSync(userConfigPath('erin'), 'utf8'))
    assert.equal(persisted.keepMe, 42)
    assert.equal(persisted.workspace, ws)
  })

  it('removes the .workspace key on reset', async () => {
    const ws = path.join(gpfsRoot, 'reset-me')
    mkdirSync(ws, { recursive: true })
    await runConfigCommand(`set-workspace ${ws}`, { config: clusterConfig(), userId: 'frank' })
    assert.ok('workspace' in JSON.parse(readFileSync(userConfigPath('frank'), 'utf8')))

    const out = await runConfigCommand('set-workspace reset', { config: clusterConfig(), userId: 'frank' })
    assert.match(out, /restored to the default/)
    assert.equal('workspace' in JSON.parse(readFileSync(userConfigPath('frank'), 'utf8')), false)
  })

  it('requires an identity', async () => {
    const out = await runConfigCommand('set-workspace /tmp/x', { config: localConfig() })
    assert.match(out, /No active LightClaw identity/)
  })

  it('prints noun-verb usage for no args / unknown subcommand', async () => {
    assert.match(await runConfigCommand('', { config: localConfig(), userId: 'alice' }), /\/config workspace/)
    assert.match(await runConfigCommand('bogus', { config: localConfig(), userId: 'alice' }), /\/config workspace/)
  })
})

// ── B2: noun handlers folded into /config (model / mode / lang / rule) ────────

function modelConfig(): LightClawConfig {
  return {
    runtime: { backend: 'local' },
    permissionCeiling: 'bypassPermissions',
    permissionMode: 'default',
    lang: 'en',
    defaultModel: 'sonnet',
    endpoints: { anthropic: { baseUrl: 'https://example' } },
    models: {
      sonnet: { schema: 'anthropic', endpoint: 'anthropic', upstreamModel: 'claude-sonnet' },
      opus: { schema: 'anthropic', endpoint: 'anthropic', upstreamModel: 'claude-opus' },
    },
  } as unknown as LightClawConfig
}

/** Run runConfigCommand inside an ALS SessionContext for `user` so the scalar
 *  paths (model / mode / rule) that read live state functions work. */
async function inSession<T>(
  user: string,
  config: LightClawConfig,
  fn: () => Promise<T>,
): Promise<T> {
  const ctx = createSessionContext({
    cwd: path.join(tmpHome, 'ws'),
    model: config.defaultModel ?? 'sonnet',
    config,
    sessionsDir: path.join(tmpHome, 'sessions'),
    memoryDir: path.join(tmpHome, 'memory'),
    currentUserId: user,
    sessionId: `s-${user}`,
    permissionMode: 'default',
    permissionCeiling: 'bypassPermissions',
  })
  return runWithSessionContext(ctx, fn)
}

describe('/config model (scalar face)', () => {
  it('set <name> persists defaultModel to the user config and applies live', async () => {
    const cfg = modelConfig()
    await inSession('alice', cfg, async () => {
      const out = await runConfigCommand('model set opus', {
        config: cfg,
        userId: 'alice',
      })
      assert.match(out, /model: opus/)
      assert.equal(getModel(), 'opus')
    })
    assert.equal(JSON.parse(readFileSync(userConfigPath('alice'), 'utf8')).defaultModel, 'opus')
  })

  it('reset deletes the per-user defaultModel override', async () => {
    const cfg = modelConfig()
    await inSession('bob', cfg, async () => {
      await runConfigCommand('model set opus', { config: cfg, userId: 'bob' })
      assert.equal(JSON.parse(readFileSync(userConfigPath('bob'), 'utf8')).defaultModel, 'opus')
      const out = await runConfigCommand('model reset', { config: cfg, userId: 'bob' })
      assert.match(out, /fall(s|ing) back/i)
    })
    assert.equal('defaultModel' in JSON.parse(readFileSync(userConfigPath('bob'), 'utf8')), false)
  })

  it('bare model lists models + current (read)', async () => {
    const cfg = modelConfig()
    const out = await inSession('carol', cfg, () =>
      runConfigCommand('model', { config: cfg, userId: 'carol' }),
    )
    assert.match(out, /current model: sonnet/)
    assert.match(out, /opus/)
  })

  it('rejects an unknown scalar model name', async () => {
    const cfg = modelConfig()
    const out = await inSession('dave', cfg, () =>
      runConfigCommand('model nope', { config: cfg, userId: 'dave' }),
    )
    assert.match(out, /unknown model: nope/)
  })
})

describe('/config model disambiguation (scalar switch vs BYO registry)', () => {
  it('routes `model set <name>` (no BYO flags) to the scalar switch', async () => {
    const cfg = modelConfig()
    await inSession('erin', cfg, async () => {
      const out = await runConfigCommand('model set opus', { config: cfg, userId: 'erin' })
      assert.match(out, /model: opus/)
      assert.equal(getModel(), 'opus')
    })
    // Scalar switch writes defaultModel, NOT a BYO `models` entry.
    const persisted = JSON.parse(readFileSync(userConfigPath('erin'), 'utf8'))
    assert.equal(persisted.defaultModel, 'opus')
    assert.equal(persisted.models, undefined)
  })

  it('routes `model add ...` (reserved BYO verb) to the BYO registry path', async () => {
    const cfg = modelConfig()
    const out = await inSession('frank', cfg, () =>
      runConfigCommand('model add', { config: cfg, userId: 'frank' }),
    )
    // BYO registry usage, not a scalar "model: ..." switch.
    assert.match(out, /\/config model add <displayName>/)
    assert.doesNotMatch(out, /^model: /m)
  })
})

describe('/config mode (scalar permission posture)', () => {
  it('set <mode> applies and persists', async () => {
    const cfg = modelConfig()
    await createUser('grace')
    await inSession('grace', cfg, async () => {
      const out = await runConfigCommand('mode set auto', { config: cfg, userId: 'grace' })
      assert.match(out, /mode: auto/)
      assert.equal(getPermissionMode(), 'acceptEdits')
    })
    assert.equal(loadIdentityPreferences('grace').permissionMode, 'acceptEdits')
  })

  it('rejects a mode above the user ceiling', async () => {
    const cfg = modelConfig()
    await createUser('heidi')
    await setUserPermissionCeiling('heidi', 'acceptEdits')
    const out = await inSession('heidi', cfg, () =>
      runConfigCommand('mode set yolo', { config: cfg, userId: 'heidi' }),
    )
    assert.match(out, /exceeds your ceiling/)
    assert.equal(loadIdentityPreferences('heidi').permissionMode, undefined)
  })
})

describe('/config lang (scalar UI language)', () => {
  it('set <cn|en> persists lang to the user config', async () => {
    const cfg = modelConfig()
    const out = await runConfigCommand('lang set en', { config: cfg, userId: 'ivan' })
    assert.match(out, /UI language: en/)
    assert.equal(JSON.parse(readFileSync(userConfigPath('ivan'), 'utf8')).lang, 'en')
  })

  it('reset deletes the per-user lang override', async () => {
    const cfg = modelConfig()
    await runConfigCommand('lang set cn', { config: cfg, userId: 'judy' })
    await runConfigCommand('lang reset', { config: cfg, userId: 'judy' })
    assert.equal('lang' in JSON.parse(readFileSync(userConfigPath('judy'), 'utf8')), false)
  })
})

describe('/config rule (per-user permission rules)', () => {
  it('add <pattern> appends a default-ask rule', async () => {
    const cfg = modelConfig()
    await inSession('ken', cfg, async () => {
      const out = await runConfigCommand('rule add Bash(git:*)', { config: cfg, userId: 'ken' })
      assert.match(out, /ASK rule/)
    })
    const rules = loadIdentityRules('ken')
    assert.equal(rules.length, 1)
    assert.equal(rules[0]!.behavior, 'ask')
  })

  it('add <pattern> --deny appends a deny rule', async () => {
    const cfg = modelConfig()
    await inSession('lena', cfg, () =>
      runConfigCommand('rule add Bash(rm:*) --deny', { config: cfg, userId: 'lena' }),
    )
    const rules = loadIdentityRules('lena')
    assert.equal(rules.length, 1)
    assert.equal(rules[0]!.behavior, 'deny')
  })

  it('rm <n> removes one rule', async () => {
    const cfg = modelConfig()
    await inSession('mike', cfg, async () => {
      await runConfigCommand('rule add Bash(git:*)', { config: cfg, userId: 'mike' })
      assert.equal(loadIdentityRules('mike').length, 1)
      const out = await runConfigCommand('rule rm 1', { config: cfg, userId: 'mike' })
      assert.match(out, /revoked|已撤销/i)
    })
    assert.equal(loadIdentityRules('mike').length, 0)
  })
})

describe('/config workspace (←set-workspace)', () => {
  it('workspace set <path> behaves like set-workspace', async () => {
    const ws = path.join(gpfsRoot, 'wsset')
    mkdirSync(ws, { recursive: true })
    const out = await runConfigCommand(`workspace set ${ws}`, { config: clusterConfig(), userId: 'nina' })
    assert.match(out, /Workspace directory set to/)
    assert.equal(JSON.parse(readFileSync(userConfigPath('nina'), 'utf8')).workspace, ws)
  })

  it('workspace reset restores the default', async () => {
    const ws = path.join(gpfsRoot, 'wsreset')
    mkdirSync(ws, { recursive: true })
    await runConfigCommand(`workspace set ${ws}`, { config: clusterConfig(), userId: 'oscar' })
    const out = await runConfigCommand('workspace reset', { config: clusterConfig(), userId: 'oscar' })
    assert.match(out, /restored to the default/)
    assert.equal('workspace' in JSON.parse(readFileSync(userConfigPath('oscar'), 'utf8')), false)
  })

  it('bare workspace shows current (read)', async () => {
    const out = await runConfigCommand('workspace', { config: clusterConfig(), userId: 'pam' })
    assert.match(out, /current workspace/)
  })
})

function localConfig(): LightClawConfig {
  return { runtime: { backend: 'local' } } as unknown as LightClawConfig
}

function clusterConfig(): LightClawConfig {
  return {
    runtime: {
      driver: 'brainpp',
      backend: 'cluster',
      clusterSettings: {
        gpfsMounts: [{ hostPrefix: gpfsRoot, mountPrefix: 'gpfs://gpfs1' }],
      },
    },
  } as unknown as LightClawConfig
}
