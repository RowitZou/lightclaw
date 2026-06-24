import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { LightClawConfig } from '../config.js'
import { setLang } from '../i18n/index.js'
import { getMemoryDir } from '../memory/auto-memory.js'
import { userConfigPath, userMemoryRoot } from '../identity/paths.js'
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

    const out = await runConfigCommand(`set-workspace ${ws} --y`, { config: clusterConfig(), userId: 'alice' })
    assert.match(out, /Workspace directory set to/)
    assert.match(out, /contains 2 entries/)
    assert.match(out, /restart/)

    const persisted = JSON.parse(readFileSync(userConfigPath('alice'), 'utf8'))
    assert.equal(persisted.workspace, ws)
  })

  it('reports an empty workspace directory', async () => {
    const ws = path.join(gpfsRoot, 'empty')
    mkdirSync(ws, { recursive: true })
    const out = await runConfigCommand(`set-workspace ${ws} --y`, { config: clusterConfig(), userId: 'bob' })
    assert.match(out, /is currently empty/)
    assert.equal(JSON.parse(readFileSync(userConfigPath('bob'), 'utf8')).workspace, ws)
  })

  it('rejects an invalid path with a reason and does NOT write the file', async () => {
    const out = await runConfigCommand(
      `set-workspace ${path.join(tmpHome, 'no-such-dir')} --y`,
      { config: clusterConfig(), userId: 'carol' },
    )
    assert.match(out, /gpfs host prefix|cannot access/)
    assert.equal(existsSync(userConfigPath('carol')), false)
  })

  it('rejects a relative path', async () => {
    const out = await runConfigCommand('set-workspace ./relative --y', { config: localConfig(), userId: 'dave' })
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

    await runConfigCommand(`set-workspace ${ws} --y`, { config: clusterConfig(), userId: 'erin' })
    const persisted = JSON.parse(readFileSync(userConfigPath('erin'), 'utf8'))
    assert.equal(persisted.keepMe, 42)
    assert.equal(persisted.workspace, ws)
  })

  it('removes the .workspace key on reset', async () => {
    const ws = path.join(gpfsRoot, 'reset-me')
    mkdirSync(ws, { recursive: true })
    await runConfigCommand(`set-workspace ${ws} --y`, { config: clusterConfig(), userId: 'frank' })
    assert.ok('workspace' in JSON.parse(readFileSync(userConfigPath('frank'), 'utf8')))

    const out = await runConfigCommand('set-workspace reset --y', { config: clusterConfig(), userId: 'frank' })
    assert.match(out, /restored to the default/)
    assert.equal('workspace' in JSON.parse(readFileSync(userConfigPath('frank'), 'utf8')), false)
  })

  it('requires an identity', async () => {
    const out = await runConfigCommand('set-workspace /tmp/x --y', { config: localConfig() })
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
    lane: {},
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
    assert.match(out, /Current model\*\*: sonnet/)
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

  it('routes `model add ...` (relocated BYO verb) to the /config backend hint', async () => {
    const cfg = modelConfig()
    const out = await inSession('frank', cfg, () =>
      runConfigCommand('model add', { config: cfg, userId: 'frank' }),
    )
    // B3: BYO model registration moved to /config backend; model emits a hint.
    assert.match(out, /\/config backend/)
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
    const out = await runConfigCommand(`workspace set ${ws} --y`, { config: clusterConfig(), userId: 'nina' })
    assert.match(out, /Workspace directory set to/)
    assert.equal(JSON.parse(readFileSync(userConfigPath('nina'), 'utf8')).workspace, ws)
  })

  it('workspace reset restores the default', async () => {
    const ws = path.join(gpfsRoot, 'wsreset')
    mkdirSync(ws, { recursive: true })
    await runConfigCommand(`workspace set ${ws} --y`, { config: clusterConfig(), userId: 'oscar' })
    const out = await runConfigCommand('workspace reset --y', { config: clusterConfig(), userId: 'oscar' })
    assert.match(out, /restored to the default/)
    assert.equal('workspace' in JSON.parse(readFileSync(userConfigPath('oscar'), 'utf8')), false)
  })

  it('bare workspace shows current (read)', async () => {
    const out = await runConfigCommand('workspace', { config: clusterConfig(), userId: 'pam' })
    assert.match(out, /Current workspace/)
  })
})

// ── B3: endpoint --type / backend / lane ─────────────────────────────────────

import { userSecretsPath } from '../identity/paths.js'

function readUserConfigJson(user: string): Record<string, unknown> {
  return JSON.parse(readFileSync(userConfigPath(user), 'utf8'))
}

function readSecretsJson(user: string): Record<string, { value: string }> {
  const parsed = JSON.parse(readFileSync(userSecretsPath(user), 'utf8'))
  return parsed.secrets ?? {}
}

describe('/config endpoint add --type', () => {
  it('--type openai --key sk-RAW stores a secret REFERENCE (not the raw key) + baseUrl', async () => {
    const cfg = modelConfig()
    const out = await runConfigCommand(
      'endpoint add ep --type openai --key sk-RAW --base-url https://gw.example/v1',
      { config: cfg, userId: 'b3a' },
    )
    assert.match(out, /Added custom endpoint/)
    const persisted = readUserConfigJson('b3a')
    const ep = (persisted.endpoints as Record<string, Record<string, unknown>>).ep
    // config.json holds a reference + baseUrl + type, NEVER the raw key.
    assert.ok(typeof ep.apiKeyRef === 'string' && ep.apiKeyRef.length > 0)
    assert.equal(ep.baseUrl, 'https://gw.example/v1')
    assert.equal(ep.type, 'openai')
    assert.equal(JSON.stringify(persisted).includes('sk-RAW'), false)
    // The secrets store now holds the raw value under that ref.
    const secrets = readSecretsJson('b3a')
    assert.equal(secrets[ep.apiKeyRef as string]!.value, 'sk-RAW')
  })

  it('--type codex --auth-path stores authRef, no baseUrl, no key', async () => {
    const cfg = modelConfig()
    // Stage a minimal codex auth.json the importer can read: a JWT-shaped
    // access_token whose `exp` claim is far in the future (the importer derives
    // expires_at from it).
    const authFile = path.join(tmpHome, 'auth.json')
    const { writeFileSync } = await import('node:fs')
    const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
    const access = `${enc({ alg: 'none', typ: 'JWT' })}.${enc({
      exp: Math.floor(Date.now() / 1000) + 3600,
    })}.`
    writeFileSync(
      authFile,
      JSON.stringify({ tokens: { access_token: access, refresh_token: 'r', account_id: 'a' } }),
      'utf8',
    )
    const out = await runConfigCommand(
      `endpoint add cdx --type codex --auth-path ${authFile}`,
      { config: cfg, userId: 'b3codex' },
    )
    assert.match(out, /Codex endpoint/i)
    const ep = (readUserConfigJson('b3codex').endpoints as Record<string, Record<string, unknown>>).cdx
    assert.ok(typeof ep.authRef === 'string' && (ep.authRef as string).startsWith('codex:'))
    assert.equal(ep.baseUrl, undefined)
    assert.equal(ep.apiKeyRef, undefined)
  })

  it('--type bogus is an error', async () => {
    const cfg = modelConfig()
    const out = await runConfigCommand('endpoint add ep --type bogus --key x', {
      config: cfg,
      userId: 'b3bogus',
    })
    assert.match(out, /unknown --type/)
    assert.equal(existsSync(userConfigPath('b3bogus')), false)
  })

  it('--key existingSecretName references it without creating a new secret', async () => {
    const cfg = modelConfig()
    // Pre-store a secret the user references by name.
    const { setUserSecret } = await import('../secrets/store.js')
    setUserSecret('b3ref', 'MY_KEY', 'sk-existing')
    const before = Object.keys(readSecretsJson('b3ref'))
    const out = await runConfigCommand('endpoint add ep --type openai --key MY_KEY', {
      config: cfg,
      userId: 'b3ref',
    })
    assert.match(out, /Added custom endpoint/)
    const ep = (readUserConfigJson('b3ref').endpoints as Record<string, Record<string, unknown>>).ep
    assert.equal(ep.apiKeyRef, 'MY_KEY')
    // No new secret slot created.
    assert.deepEqual(Object.keys(readSecretsJson('b3ref')).sort(), before.sort())
  })

  it('add-key / add-codex are removed verbs → fall through to endpoint usage', async () => {
    const cfg = modelConfig()
    // The legacy deprecation hints are gone; an unrecognized endpoint verb now
    // lands on the endpoint usage (which names the real `add --type` path) and
    // writes no user config.
    const out1 = await runConfigCommand('endpoint add-key ep MY_KEY', { config: cfg, userId: 'b3dep' })
    assert.match(out1, /--type/)
    assert.doesNotMatch(out1, /deprecated/)
    const out2 = await runConfigCommand('endpoint add-codex ep codex:x', { config: cfg, userId: 'b3dep' })
    assert.match(out2, /--type codex/)
    assert.doesNotMatch(out2, /deprecated/)
    assert.equal(existsSync(userConfigPath('b3dep')), false)
  })
})

describe('/config backend (BYO model registry, ←model BYO)', () => {
  it('add m --endpoint ep --default writes the model entry, sets defaultModel, upstream==name', async () => {
    const cfg = modelConfig()
    await runConfigCommand('endpoint add ep --type openai --key sk-RAW', { config: cfg, userId: 'b3b' })
    const out = await runConfigCommand('backend add m --endpoint ep --default', {
      config: cfg,
      userId: 'b3b',
    })
    assert.match(out, /Registered model "m"/)
    const persisted = readUserConfigJson('b3b')
    const model = (persisted.models as Record<string, Record<string, unknown>>).m
    assert.equal(model.endpoint, 'ep')
    assert.equal(model.upstreamModel, 'm') // --upstream omitted ⇒ upstream==name
    assert.equal(model.schema, 'openai') // derived from endpoint --type
    assert.equal(persisted.defaultModel, 'm')
  })

  it('check m clears the cache then probes', async () => {
    const cfg = modelConfig()
    await runConfigCommand('endpoint add ep --type openai --key sk-RAW --base-url https://x', {
      config: cfg,
      userId: 'b3chk',
    })
    await runConfigCommand('backend add m --endpoint ep --upstream up-1', { config: cfg, userId: 'b3chk' })
    // The probe will fail (no real provider) but check still runs + returns a
    // localized check result, having cleared the cache first.
    const out = await runConfigCommand('backend check m', { config: cfg, userId: 'b3chk' })
    assert.match(out, /Model check/)
  })
})

describe('/config model BYO verbs now hint to /config backend', () => {
  it('model add emits the backend hint and writes no registry', async () => {
    const cfg = modelConfig()
    const out = await runConfigCommand('model add x --endpoint ep', { config: cfg, userId: 'b3hint' })
    assert.match(out, /\/config backend/)
    assert.equal(existsSync(userConfigPath('b3hint')), false)
  })

  it('model set <name> still scalar-switches', async () => {
    const cfg = modelConfig()
    await inSession('b3set', cfg, async () => {
      const out = await runConfigCommand('model set opus', { config: cfg, userId: 'b3set' })
      assert.match(out, /model: opus/)
      assert.equal(getModel(), 'opus')
    })
    assert.equal(readUserConfigJson('b3set').defaultModel, 'opus')
    assert.equal(readUserConfigJson('b3set').models, undefined)
  })
})

describe('/config lane', () => {
  it('set worker <model> writes config.lane.worker; reset clears it', async () => {
    const cfg = modelConfig()
    const out = await runConfigCommand('lane set worker opus', { config: cfg, userId: 'b3lane' })
    assert.match(out, /lane.worker = opus/)
    assert.equal(
      ((readUserConfigJson('b3lane').lane as Record<string, unknown>) ?? {}).worker,
      'opus',
    )
    const resetOut = await runConfigCommand('lane reset worker', { config: cfg, userId: 'b3lane' })
    assert.match(resetOut, /Cleared lane.worker/)
    const lane = readUserConfigJson('b3lane').lane as Record<string, unknown> | undefined
    assert.equal(lane === undefined || !('worker' in lane), true)
  })

  it('set worker <unknownModel> is an error', async () => {
    const cfg = modelConfig()
    const out = await runConfigCommand('lane set worker nope', { config: cfg, userId: 'b3laneerr' })
    assert.match(out, /unknown model "nope"/)
    assert.equal(existsSync(userConfigPath('b3laneerr')), false)
  })

  it('bare lane lists the three buckets', async () => {
    const cfg = modelConfig()
    const out = await runConfigCommand('lane', { config: cfg, userId: 'b3lanelist' })
    assert.match(out, /worker =/)
    assert.match(out, /system =/)
    assert.match(out, /image =/)
  })
})

// ── B5: --y two-step confirmation + reset-wording polish ─────────────────────

describe('/config endpoint rm --y (cascade confirmation)', () => {
  it('no --y returns a preview listing dependent backends and does NOT delete', async () => {
    const cfg = modelConfig()
    await runConfigCommand('endpoint add ep --type openai --key sk-RAW', { config: cfg, userId: 'b5erm' })
    await runConfigCommand('backend add m --endpoint ep', { config: cfg, userId: 'b5erm' })
    const before = readUserConfigJson('b5erm')

    const out = await runConfigCommand('endpoint rm ep', { config: cfg, userId: 'b5erm' })
    // Preview names the dependent backend model + the --y reminder.
    assert.match(out, /\bm\b/)
    assert.match(out, /--y/)
    // Config unchanged — the endpoint + model are still present.
    assert.deepEqual(readUserConfigJson('b5erm'), before)
  })

  it('--y deletes the endpoint and cascade-removes the dependent backend', async () => {
    const cfg = modelConfig()
    await runConfigCommand('endpoint add ep --type openai --key sk-RAW', { config: cfg, userId: 'b5erm2' })
    await runConfigCommand('backend add m --endpoint ep', { config: cfg, userId: 'b5erm2' })
    const out = await runConfigCommand('endpoint rm ep --y', { config: cfg, userId: 'b5erm2' })
    assert.match(out, /Removed custom endpoint/)
    const persisted = readUserConfigJson('b5erm2')
    const endpoints = (persisted.endpoints as Record<string, unknown>) ?? {}
    const models = (persisted.models as Record<string, unknown>) ?? {}
    assert.equal('ep' in endpoints, false)
    assert.equal('m' in models, false, 'cascade should remove the dependent backend')
  })
})

describe('/config rule rm all --y', () => {
  it('rm all requires --y (no --y = preview, no delete)', async () => {
    const cfg = modelConfig()
    await inSession('b5rule', cfg, async () => {
      await runConfigCommand('rule add Bash(git:*)', { config: cfg, userId: 'b5rule' })
      assert.equal(loadIdentityRules('b5rule').length, 1)
      const out = await runConfigCommand('rule rm all', { config: cfg, userId: 'b5rule' })
      assert.match(out, /--y/)
      assert.equal(loadIdentityRules('b5rule').length, 1, 'no --y must not delete')
      const done = await runConfigCommand('rule rm all --y', { config: cfg, userId: 'b5rule' })
      assert.match(done, /revoked|已撤销/i)
      assert.equal(loadIdentityRules('b5rule').length, 0)
    })
  })

  it('rm <n> single does NOT require --y', async () => {
    const cfg = modelConfig()
    await inSession('b5rule1', cfg, async () => {
      await runConfigCommand('rule add Bash(git:*)', { config: cfg, userId: 'b5rule1' })
      const out = await runConfigCommand('rule rm 1', { config: cfg, userId: 'b5rule1' })
      assert.doesNotMatch(out, /--y to confirm|追加 --y/)
      assert.equal(loadIdentityRules('b5rule1').length, 0)
    })
  })
})

describe('/config workspace set --y', () => {
  it('set <abs> requires --y; --y migrates and keeps the restart note', async () => {
    const ws = path.join(gpfsRoot, 'b5ws')
    mkdirSync(ws, { recursive: true })
    const cfg = clusterConfig()
    const preview = await runConfigCommand(`workspace set ${ws}`, { config: cfg, userId: 'b5ws' })
    assert.match(preview, /--y/)
    assert.equal(existsSync(userConfigPath('b5ws')), false, 'no --y must not write')

    const out = await runConfigCommand(`workspace set ${ws} --y`, { config: cfg, userId: 'b5ws' })
    assert.match(out, /Workspace directory set to/)
    assert.match(out, /restart/)
    assert.equal(JSON.parse(readFileSync(userConfigPath('b5ws'), 'utf8')).workspace, ws)
  })

  it('workspace reset requires --y and keeps the restart note', async () => {
    const ws = path.join(gpfsRoot, 'b5wsr')
    mkdirSync(ws, { recursive: true })
    const cfg = clusterConfig()
    await runConfigCommand(`workspace set ${ws} --y`, { config: cfg, userId: 'b5wsr' })
    const preview = await runConfigCommand('workspace reset', { config: cfg, userId: 'b5wsr' })
    assert.match(preview, /--y/)
    assert.equal('workspace' in JSON.parse(readFileSync(userConfigPath('b5wsr'), 'utf8')), true)
    const out = await runConfigCommand('workspace reset --y', { config: cfg, userId: 'b5wsr' })
    assert.match(out, /restart/)
    assert.equal('workspace' in JSON.parse(readFileSync(userConfigPath('b5wsr'), 'utf8')), false)
  })
})

describe('/config reset wording polish', () => {
  it('mode reset indicates fallback to the admin/default mode', async () => {
    const cfg = modelConfig()
    await createUser('b5mode')
    const out = await inSession('b5mode', cfg, () =>
      runConfigCommand('mode reset', { config: cfg, userId: 'b5mode' }),
    )
    assert.match(out, /admin\/default mode|admin \/ 默认模式/)
  })

  it('model reset indicates fallback to the admin/default model', async () => {
    const cfg = modelConfig()
    const out = await inSession('b5model', cfg, async () => {
      await runConfigCommand('model set opus', { config: cfg, userId: 'b5model' })
      return runConfigCommand('model reset', { config: cfg, userId: 'b5model' })
    })
    assert.match(out, /admin\/default model|admin \/ 默认模型/)
    // The fallback value (admin defaultModel = sonnet) is named.
    assert.match(out, /sonnet/)
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

// Regression (§十 directory refactor): memory must land in the per-user root
// `users/<u>/memory` like sessions / skills / taskruns — NOT pooled under
// `<home>/memory/<u>`. Pre-fix, config.ts hard-set paths.memory to
// `<home>/memory` and getMemoryDir returned `path.join(paths.memory, <u>)`, so
// every user's memory pooled at home root. The pooled branch + paths.memory
// field are now deleted; getMemoryDir always routes to userMemoryRoot. This
// assertion fails on the old code (it returned `<home>/memory/alice`).
describe('memory dir routing (§十 per-user inverted layout)', () => {
  it('routes a bound user to users/<u>/memory, not the pooled <home>/memory/<u>', () => {
    const dir = getMemoryDir('alice')
    assert.equal(dir, userMemoryRoot('alice'))
    assert.ok(dir.endsWith(path.join('users', 'alice', 'memory')))
    assert.ok(!dir.includes(`${path.sep}memory${path.sep}alice`))
  })

  it('routes the unbound bootstrap to users/_unbound_/memory', () => {
    assert.equal(getMemoryDir(undefined), userMemoryRoot('_unbound_'))
  })
})
