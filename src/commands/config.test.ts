import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import {
  __setModelProbeHooksForTests,
  __setProbeStreamChatForTests,
  runConfigCommand,
  validateWorkspacePath,
} from './config.js'
import { getProviderFor, _resetProviderCacheForTests } from '../provider/index.js'
import { resolveUserConfig } from '../config/user-override.js'

let tmpHome = ''
let gpfsRoot = ''

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-config-command-'))
  gpfsRoot = path.join(tmpHome, 'gpfs')
  mkdirSync(gpfsRoot, { recursive: true })
  setLightclawHomeOverride(tmpHome)
  setLang('en')
  // Default: stub the add-time network probes so the bulk of tests stay
  // hermetic. Probe-specific tests override these hooks inline.
  __setModelProbeHooksForTests({
    endpointModels: async () => ({ ok: true, summary: '' }),
    connectivity: async () => ({ ok: true }),
  })
})

afterEach(() => {
  setLang('cn')
  setLightclawHomeOverride(undefined)
  __setModelProbeHooksForTests(null)
  __setProbeStreamChatForTests(null)
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
    assert.match(result!, /allowed storage prefix/)
  })

  it('passes for a directory under the gpfs prefix on a cluster backend', async () => {
    const inside = path.join(gpfsRoot, 'team', 'collab')
    mkdirSync(inside, { recursive: true })
    assert.equal(await validateWorkspacePath(inside, clusterConfig()), null)
  })

  // Pre-fix this returned null (a depth-1 team/share root was accepted as a
  // workspace); the depth guard now refuses it. Fails on old code.
  it('rejects a top-level shared root (mount root or team share) on a cluster backend', async () => {
    const teamShare = path.join(gpfsRoot, 'ailab-hs') // depth 1 below hostPrefix
    mkdirSync(teamShare, { recursive: true })
    const result = await validateWorkspacePath(teamShare, clusterConfig())
    assert.ok(result)
    assert.match(result!, /top-level shared storage/)
    // The gpfs mount root itself (depth 0) is refused too.
    const atRoot = await validateWorkspacePath(gpfsRoot, clusterConfig())
    assert.ok(atRoot)
    assert.match(atRoot!, /top-level shared storage/)
  })
})

describe('/config set-workspace', () => {
  it('writes .workspace into users/<u>/config.json and echoes entry count', async () => {
    const ws = path.join(gpfsRoot, 'team', 'shared')
    mkdirSync(path.join(ws, 'a'), { recursive: true })
    mkdirSync(path.join(ws, 'b'), { recursive: true })

    const out = await runConfigCommand(`set-workspace ${ws} --y`, { config: clusterConfig(), userId: 'alice' })
    assert.match(out, /Workspace directory set to/)
    assert.match(out, /contains 2 entries/)
    // No restart hook in this minimal caller → deferred-restart note.
    assert.match(out, /next start/)

    const persisted = JSON.parse(readFileSync(userConfigPath('alice'), 'utf8'))
    assert.equal(persisted.workspace, ws)
  })

  it('reports an empty workspace directory', async () => {
    const ws = path.join(gpfsRoot, 'team', 'empty')
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
    assert.match(out, /allowed storage prefix|cannot access/)
    assert.equal(existsSync(userConfigPath('carol')), false)
  })

  it('rejects a relative path', async () => {
    const out = await runConfigCommand('set-workspace ./relative --y', { config: localConfig(), userId: 'dave' })
    assert.match(out, /must be an absolute path/)
    assert.equal(existsSync(userConfigPath('dave')), false)
  })

  it('preserves unrelated keys when writing .workspace', async () => {
    const ws = path.join(gpfsRoot, 'team', 'keep')
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
    const ws = path.join(gpfsRoot, 'team', 'reset-me')
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
    // Terminal output is the textified card: numbered model list with the
    // current marker, plus the sub-command rows.
    assert.match(out, /sonnet/)
    assert.match(out, /← current/)
    assert.match(out, /opus/)
    assert.match(out, /set <model>/)
  })

  it('rejects an unknown scalar model name', async () => {
    const cfg = modelConfig()
    const out = await inSession('dave', cfg, () =>
      runConfigCommand('model nope', { config: cfg, userId: 'dave' }),
    )
    assert.match(out, /unknown model: nope/)
  })

  // A BYO entry the resolver had to disable used to be invisible on this card:
  // the list just came back shorter (2026-08-13 prod — the user read it as
  // "my gpt config vanished"). The 已禁用 / Disabled section names each dropped
  // entry and the command that restores it. Fails on old code (no section).
  it('bare model surfaces disabled BYO entries with a restore hint', async () => {
    const cfg = modelConfig()
    // A gateway endpoint whose secret was removed, plus a model on it.
    mkdirSync(path.dirname(userConfigPath('frank')), { recursive: true })
    writeFileSync(
      userConfigPath('frank'),
      JSON.stringify({
        endpoints: { gateway: { type: 'openai', apiKeyRef: 'BYO_KEY_1' } },
        models: { 'gpt-gw': { endpoint: 'gateway', schema: 'openai', upstreamModel: 'gpt-5.5' } },
      }),
    )
    const out = await inSession('frank', cfg, () =>
      runConfigCommand('model', { config: cfg, userId: 'frank' }),
    )
    // The admin models still list normally.
    assert.match(out, /sonnet/)
    // Both the broken endpoint and the model it took down are named...
    assert.match(out, /Disabled \(2\)/)
    assert.match(out, /gateway/)
    assert.match(out, /gpt-gw/)
    // ...each with the one command that brings it back.
    assert.match(out, /\/secret set BYO_KEY_1 <VALUE>/)
  })

  // Per-entry degrade means an ALREADY-broken entry must not block an unrelated
  // write. Pre-fix guardWritable rejected any write while any entry was broken.
  it('an unrelated backend write still succeeds while another entry is broken', async () => {
    const cfg = modelConfig()
    mkdirSync(path.dirname(userConfigPath('grace')), { recursive: true })
    writeFileSync(
      userConfigPath('grace'),
      JSON.stringify({
        endpoints: {
          gateway: { type: 'openai', apiKeyRef: 'MISSING_KEY' },
          good: { type: 'openai', apiKeyRef: 'GOOD_KEY' },
        },
        models: {},
      }),
    )
    mkdirSync(path.dirname(userSecretsPath('grace')), { recursive: true })
    writeFileSync(
      userSecretsPath('grace'),
      JSON.stringify({
        version: 1,
        secrets: { GOOD_KEY: { value: 'sk-good', enabled: true, updatedAt: new Date().toISOString() } },
      }),
    )
    const out = await inSession('grace', cfg, () =>
      runConfigCommand('backend add gpt-ok --endpoint good --upstream gpt-5.5', {
        config: cfg,
        userId: 'grace',
      }),
    )
    assert.doesNotMatch(out, /not written/)
    const written = JSON.parse(readFileSync(userConfigPath('grace'), 'utf8'))
    assert.ok(written.models['gpt-ok'], 'the healthy write must land')
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
      assert.match(out, /confirm rule/)
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
    const ws = path.join(gpfsRoot, 'team', 'wsset')
    mkdirSync(ws, { recursive: true })
    const out = await runConfigCommand(`workspace set ${ws} --y`, { config: clusterConfig(), userId: 'nina' })
    assert.match(out, /Workspace directory set to/)
    assert.equal(JSON.parse(readFileSync(userConfigPath('nina'), 'utf8')).workspace, ws)
  })

  it('workspace reset restores the default', async () => {
    const ws = path.join(gpfsRoot, 'team', 'wsreset')
    mkdirSync(ws, { recursive: true })
    await runConfigCommand(`workspace set ${ws} --y`, { config: clusterConfig(), userId: 'oscar' })
    const out = await runConfigCommand('workspace reset --y', { config: clusterConfig(), userId: 'oscar' })
    assert.match(out, /restored to the default/)
    assert.equal('workspace' in JSON.parse(readFileSync(userConfigPath('oscar'), 'utf8')), false)
  })

  it('bare workspace shows current (read)', async () => {
    const out = await runConfigCommand('workspace', { config: clusterConfig(), userId: 'pam' })
    // Textified card: the "Current" show-段 heading + the set sub-command.
    assert.match(out, /Current/)
    assert.match(out, /set <path>/)
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
    assert.match(out, /Added model service/)
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

  it('rejects a --base-url with a full-width character BEFORE the probe, with a half-width hint', async () => {
    const cfg = modelConfig()
    // Chinese-IME full-width colon `：` (U+FF1A). new URL() throws a bare
    // "Invalid URL" deep in the probe; the input-time gate catches it here.
    const out = await runConfigCommand(
      'endpoint add ep --type openai --key sk-RAW --base-url http：//gw.example/v1',
      { config: cfg, userId: 'baseurlfw' },
    )
    assert.match(out, /valid http\(s\) URL/)
    assert.match(out, /full-width \/ non-ASCII/) // non-ASCII hint appended
    // Rejected before persistence — nothing was written.
    assert.equal(existsSync(userConfigPath('baseurlfw')), false)
  })

  it('rejects a --base-url with no scheme (bare host:port)', async () => {
    const cfg = modelConfig()
    const out = await runConfigCommand(
      'endpoint add ep --type openai --key sk-RAW --base-url 35.220.164.252:3888/v1',
      { config: cfg, userId: 'baseurlnoscheme' },
    )
    assert.match(out, /valid http\(s\) URL/)
    assert.equal(existsSync(userConfigPath('baseurlnoscheme')), false)
  })

  it('rejects a --base-url whose scheme is not http(s)', async () => {
    const cfg = modelConfig()
    const out = await runConfigCommand(
      'endpoint add ep --type openai --key sk-RAW --base-url ftp://gw.example/v1',
      { config: cfg, userId: 'baseurlproto' },
    )
    assert.match(out, /must start with http:\/\/ or https:\/\//)
    assert.equal(existsSync(userConfigPath('baseurlproto')), false)
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
    assert.match(out, /Codex model service/i)
    const ep = (readUserConfigJson('b3codex').endpoints as Record<string, Record<string, unknown>>).cdx
    assert.ok(typeof ep.authRef === 'string' && (ep.authRef as string).startsWith('codex:'))
    assert.equal(ep.baseUrl, undefined)
    assert.equal(ep.apiKeyRef, undefined)
    // The auth-path is persisted (provenance, not a secret) and shown in the card.
    assert.equal(ep.authPath, authFile)
    assert.match(out, new RegExp(`authPath=${authFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  })

  it('--type codex accepts an em-dash-mangled —auth-path (Feishu smart-punctuation)', async () => {
    // Feishu / IME smart-punctuation rewrites a typed `--auth-path` to `—auth-path`
    // (em-dash). Without normalization the mangled flag never matches, so a user
    // who supplied a valid absolute path would silently fall through to codex
    // web-login mode instead of importing the file (2026-06-30 dogfood).
    const cfg = modelConfig()
    const authFile = path.join(tmpHome, 'auth-emdash.json')
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
      `endpoint add cdx —type codex —auth-path ${authFile}`,
      { config: cfg, userId: 'codexemdash' },
    )
    assert.match(out, /Codex model service/i)
    const ep = (readUserConfigJson('codexemdash').endpoints as Record<string, Record<string, unknown>>)
      .cdx
    assert.ok(typeof ep.authRef === 'string' && (ep.authRef as string).startsWith('codex:'))
    assert.equal(ep.authPath, authFile)
  })

  it('--type codex rejects a non-absolute --auth-path (no tilde/relative; credential-leak guard)', async () => {
    const cfg = modelConfig()
    // A `~` path would expandHomePath to the DAEMON operator's home and import the
    // host's own Codex credentials into this user's endpoint — must be refused.
    for (const bad of ['~/.codex/auth.json', './auth.json', 'auth.json']) {
      const out = await runConfigCommand(`endpoint add cdx --type codex --auth-path ${bad}`, {
        config: cfg,
        userId: 'b3codexrel',
      })
      assert.match(out, /absolute path/i)
      // Nothing persisted — the endpoint was never added.
      assert.equal(existsSync(userConfigPath('b3codexrel')), false)
    }
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
    assert.match(out, /Added model service/)
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
    assert.match(out, /Added model "m"/)
    const persisted = readUserConfigJson('b3b')
    const model = (persisted.models as Record<string, Record<string, unknown>>).m
    assert.equal(model.endpoint, 'ep')
    assert.equal(model.upstreamModel, 'm') // --upstream omitted ⇒ upstream==name
    assert.equal(model.schema, 'openai') // derived from endpoint --type
    assert.equal(model.reasoningEffort, undefined) // omitted ⇒ not stored; api.ts wire-defaults medium
    assert.equal(persisted.defaultModel, 'm')
  })

  it('stores an explicit --reasoning; omitting it leaves the field unset', async () => {
    const cfg = modelConfig()
    await runConfigCommand('endpoint add ep --type openai --key sk-RAW', { config: cfg, userId: 'b3rsn' })
    await runConfigCommand('backend add m --endpoint ep --reasoning xhigh', { config: cfg, userId: 'b3rsn' })
    const model = (readUserConfigJson('b3rsn').models as Record<string, Record<string, unknown>>).m
    assert.equal(model.reasoningEffort, 'xhigh')
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

  it('rejects a backend name colliding with an admin model — admin wins, nothing written', async () => {
    const cfg = modelConfig()
    // Drive getConfig()'s on-disk admin base (NOT the passed cfg) to carry a
    // model named "opus"; adminModelNames() reads from here.
    writeFileSync(
      path.join(tmpHome, 'config.json'),
      JSON.stringify({
        defaultModel: 'opus',
        endpoints: { anthropic: { baseUrl: 'https://example', apiKey: 'sk-admin' } },
        models: { opus: { schema: 'anthropic', endpoint: 'anthropic', upstreamModel: 'claude-opus' } },
      }),
    )
    await runConfigCommand('endpoint add ep --type openai --key sk-RAW', { config: cfg, userId: 'b3conf' })
    const out = await runConfigCommand('backend add opus --endpoint ep', { config: cfg, userId: 'b3conf' })
    assert.match(out, /conflicts with an existing system model/)
    // Pre-write rejection: the user's config.json never gains a ghost "opus"
    // entry (which the old, guard-less path left behind before the resolve-time
    // collision logic silently dropped it).
    const persisted = readUserConfigJson('b3conf')
    assert.equal((persisted.models as Record<string, unknown> | undefined)?.opus, undefined)
  })

  it('allows a backend name that collides only with ANOTHER USER (cross-user isolation)', async () => {
    const cfg = modelConfig()
    // No admin "shared" model on disk → only a peer user owns the name.
    await runConfigCommand('endpoint add ep --type openai --key sk-RAW', { config: cfg, userId: 'b3iso1' })
    await runConfigCommand('backend add shared --endpoint ep', { config: cfg, userId: 'b3iso1' })
    await runConfigCommand('endpoint add ep --type openai --key sk-RAW', { config: cfg, userId: 'b3iso2' })
    const out = await runConfigCommand('backend add shared --endpoint ep', { config: cfg, userId: 'b3iso2' })
    assert.match(out, /Added model "shared"/)
    assert.ok((readUserConfigJson('b3iso2').models as Record<string, unknown>).shared)
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
    assert.match(out, /worker to model opus/)
    assert.equal(
      ((readUserConfigJson('b3lane').lane as Record<string, unknown>) ?? {}).worker,
      'opus',
    )
    const resetOut = await runConfigCommand('lane reset worker', { config: cfg, userId: 'b3lane' })
    assert.match(resetOut, /Cleared worker/)
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
    // Textified card: per-use labels (worker / system / image) + the set sub-command.
    assert.match(out, /worker \(sub-agents\)/)
    assert.match(out, /system \(system tasks/)
    assert.match(out, /image \(image understanding\)/)
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
    assert.match(out, /Removed model service/)
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

describe('/config endpoint flushes the provider cache so edits take effect live', () => {
  it('endpoint set evicts the cached provider built with the old wiring', async () => {
    const cfg = modelConfig()
    _resetProviderCacheForTests()
    await runConfigCommand('endpoint add ep --type openai --key sk-RAW --base-url https://old.example/v1', {
      config: cfg,
      userId: 'b5flush',
    })
    await runConfigCommand('backend add m --endpoint ep --upstream up-1', { config: cfg, userId: 'b5flush' })

    // Build + cache the provider with the OLD base-url.
    const p1 = getProviderFor(resolveUserConfig('b5flush', cfg), 'm').provider
    const p2 = getProviderFor(resolveUserConfig('b5flush', cfg), 'm').provider
    assert.equal(p1, p2, 'unchanged wiring → the cached provider instance is reused')

    // The cache key is schema:alias:credentialIdentity and omits base-url, and
    // the secret ref name is unchanged here, so only an explicit flush can make
    // the next lookup rebuild. On the pre-fix code p3 === p1 (stale).
    await runConfigCommand('endpoint set ep --base-url https://new.example/v1', {
      config: cfg,
      userId: 'b5flush',
    })
    const p3 = getProviderFor(resolveUserConfig('b5flush', cfg), 'm').provider
    assert.notEqual(p3, p1, 'endpoint set must flush so the new base-url is used without a restart')
  })

  it('endpoint rm flushes too so a same-alias re-add cannot resurrect a stale provider', async () => {
    const cfg = modelConfig()
    _resetProviderCacheForTests()
    await runConfigCommand('endpoint add ep --type openai --key sk-RAW --base-url https://old.example/v1', {
      config: cfg,
      userId: 'b5flushrm',
    })
    await runConfigCommand('backend add m --endpoint ep --upstream up-1', { config: cfg, userId: 'b5flushrm' })
    const p1 = getProviderFor(resolveUserConfig('b5flushrm', cfg), 'm').provider

    // rm cascade-drops model m; re-add the same alias + model with a new url.
    await runConfigCommand('endpoint rm ep --y', { config: cfg, userId: 'b5flushrm' })
    await runConfigCommand('endpoint add ep --type openai --key sk-RAW --base-url https://new.example/v1', {
      config: cfg,
      userId: 'b5flushrm',
    })
    await runConfigCommand('backend add m --endpoint ep --upstream up-1', { config: cfg, userId: 'b5flushrm' })
    const p2 = getProviderFor(resolveUserConfig('b5flushrm', cfg), 'm').provider
    assert.notEqual(p2, p1, 'rm/add cycle must not serve the pre-removal provider instance')
  })
})

describe('/config workspace set --y', () => {
  it('set <abs> requires --y; --y migrates and notes the deferred restart when no restart hook is wired', async () => {
    const ws = path.join(gpfsRoot, 'team', 'b5ws')
    mkdirSync(ws, { recursive: true })
    const cfg = clusterConfig()
    const preview = await runConfigCommand(`workspace set ${ws}`, { config: cfg, userId: 'b5ws' })
    assert.match(preview, /--y/)
    assert.equal(existsSync(userConfigPath('b5ws')), false, 'no --y must not write')

    const out = await runConfigCommand(`workspace set ${ws} --y`, { config: cfg, userId: 'b5ws' })
    assert.match(out, /Workspace directory set to/)
    // No restartRlaunch hook in this minimal caller → deferred-restart note.
    assert.match(out, /next start/)
    assert.equal(JSON.parse(readFileSync(userConfigPath('b5ws'), 'utf8')).workspace, ws)
  })

  it('workspace set restarts the sandbox when a restart hook is wired', async () => {
    const ws = path.join(gpfsRoot, 'team', 'b5wsrestart')
    mkdirSync(ws, { recursive: true })
    const cfg = clusterConfig()
    let restartCalls = 0
    const out = await runConfigCommand(`workspace set ${ws} --y`, {
      config: cfg,
      userId: 'b5wsrestart',
      restartRlaunch: async () => {
        restartCalls += 1
        return { worker: 'ws-worker-123', report: { unmountable: [] } }
      },
    })
    assert.equal(restartCalls, 1, 'workspace set must restart the sandbox')
    assert.match(out, /Sandbox restarted/)
    assert.equal(JSON.parse(readFileSync(userConfigPath('b5wsrestart'), 'utf8')).workspace, ws)
  })

  it('workspace set surfaces a restart failure without losing the saved workspace', async () => {
    const ws = path.join(gpfsRoot, 'team', 'b5wsfail')
    mkdirSync(ws, { recursive: true })
    const cfg = clusterConfig()
    const out = await runConfigCommand(`workspace set ${ws} --y`, {
      config: cfg,
      userId: 'b5wsfail',
      restartRlaunch: async () => {
        throw new Error('worker spawn timed out')
      },
    })
    assert.match(out, /restart failed/)
    assert.match(out, /worker spawn timed out/)
    // The write must survive a failed restart so it takes effect on next start.
    assert.equal(JSON.parse(readFileSync(userConfigPath('b5wsfail'), 'utf8')).workspace, ws)
  })

  it('workspace reset requires --y and restarts the sandbox to remount the default', async () => {
    const ws = path.join(gpfsRoot, 'team', 'b5wsr')
    mkdirSync(ws, { recursive: true })
    const cfg = clusterConfig()
    await runConfigCommand(`workspace set ${ws} --y`, { config: cfg, userId: 'b5wsr' })
    const preview = await runConfigCommand('workspace reset', { config: cfg, userId: 'b5wsr' })
    assert.match(preview, /--y/)
    assert.equal('workspace' in JSON.parse(readFileSync(userConfigPath('b5wsr'), 'utf8')), true)
    let restartCalls = 0
    const out = await runConfigCommand('workspace reset --y', {
      config: cfg,
      userId: 'b5wsr',
      restartRlaunch: async () => {
        restartCalls += 1
        return { worker: 'ws-worker-456', report: { unmountable: [] } }
      },
    })
    assert.equal(restartCalls, 1, 'reset that actually changed the workspace must restart')
    assert.match(out, /Sandbox restarted/)
    assert.equal('workspace' in JSON.parse(readFileSync(userConfigPath('b5wsr'), 'utf8')), false)
  })

  it('workspace reset that changes nothing does not restart the sandbox', async () => {
    const cfg = clusterConfig()
    let restartCalls = 0
    const out = await runConfigCommand('workspace reset --y', {
      config: cfg,
      userId: 'b5wsnoop',
      restartRlaunch: async () => {
        restartCalls += 1
        return { worker: 'ws-worker-789', report: { unmountable: [] } }
      },
    })
    assert.equal(restartCalls, 0, 'no workspace override → no remount needed')
    assert.match(out, /already the default/)
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

describe('usage fallbacks render the structured card (not the old Usage: dump)', () => {
  it('/config backend check with no name → backend card, not Usage text', async () => {
    const cfg = modelConfig()
    const out = await inSession('zfb', cfg, () =>
      runConfigCommand('backend check', { config: cfg, userId: 'zfb' }),
    )
    assert.doesNotMatch(out, /^Usage:/m)
    assert.match(out, /\/config backend add/) // example line from the card
  })

  it('/config endpoint add with no alias → endpoint card', async () => {
    const cfg = modelConfig()
    const out = await inSession('zfe', cfg, () =>
      runConfigCommand('endpoint add', { config: cfg, userId: 'zfe' }),
    )
    assert.doesNotMatch(out, /^Usage:/m)
    assert.match(out, /\/config endpoint add/)
  })

  it('/config lane bogusverb → lane card', async () => {
    const cfg = modelConfig()
    const out = await runConfigCommand('lane bogusverb', { config: cfg, userId: 'zfl' })
    assert.doesNotMatch(out, /verbs:/)
    assert.match(out, /\/config lane set worker/)
  })
})

describe('/config endpoint add — probe gates the import', () => {
  it('rejects (does not persist) when the probe is unreachable', async () => {
    const cfg = modelConfig()
    __setModelProbeHooksForTests({
      endpointModels: async () => ({ ok: false, detail: 'unreachable' }),
      connectivity: async () => ({ ok: true }),
    })
    const out = await runConfigCommand('endpoint add ep --type openai --key sk-RAW --base-url https://x', {
      config: cfg,
      userId: 'epgate',
    })
    assert.match(out, /NOT added/)
    // No endpoint persisted, AND no orphan secret left behind (the secrets file
    // is never even created because the raw key is stored only post-probe).
    assert.equal(existsSync(userConfigPath('epgate')), false)
    assert.equal(existsSync(userSecretsPath('epgate')), false)
  })

  it('persists and appends the model list + next step on a reachable probe', async () => {
    const cfg = modelConfig()
    __setModelProbeHooksForTests({
      endpointModels: async () => ({ ok: true, summary: '\nConnected. Available models: gpt-5, gpt-5-mini\nNext: run /config backend add' }),
      connectivity: async () => ({ ok: true }),
    })
    const out = await runConfigCommand('endpoint add ep --type openai --key sk-RAW --base-url https://x', {
      config: cfg,
      userId: 'epok',
    })
    assert.match(out, /Added model service/)
    assert.match(out, /Available models: gpt-5/)
    assert.match(out, /Next: run \/config backend add/)
    const ep = (readUserConfigJson('epok').endpoints as Record<string, Record<string, unknown>>).ep
    assert.equal(ep.type, 'openai')
  })

  it('persists the probe-resolved base-url (tolerant /v1 normalization)', async () => {
    const cfg = modelConfig()
    // The probe reports it actually reached the +/v1 form (user typed it without).
    __setModelProbeHooksForTests({
      endpointModels: async () => ({ ok: true, summary: '', resolvedBaseUrl: 'https://x/v1' }),
      connectivity: async () => ({ ok: true }),
    })
    await runConfigCommand('endpoint add ep --type openai --key sk-RAW --base-url https://x', {
      config: cfg,
      userId: 'epresolved',
    })
    const ep = (readUserConfigJson('epresolved').endpoints as Record<string, Record<string, unknown>>).ep
    // Stored base-url is the form the probe verified, NOT the bare value typed.
    assert.equal(ep.baseUrl, 'https://x/v1')
  })
})

describe('/config backend add — connectivity gate + auto-default', () => {
  async function addEndpointOk(user: string, cfg: LightClawConfig): Promise<void> {
    __setModelProbeHooksForTests({
      endpointModels: async () => ({ ok: true, summary: '' }),
      connectivity: async () => ({ ok: true }),
    })
    await runConfigCommand('endpoint add ep --type openai --key sk-RAW --base-url https://x', {
      config: cfg,
      userId: user,
    })
  }

  it('rolls back (model NOT added, default unchanged) when connectivity fails', async () => {
    const cfg = modelConfig()
    await addEndpointOk('bkgate', cfg)
    __setModelProbeHooksForTests({
      endpointModels: async () => ({ ok: true, summary: '' }),
      connectivity: async () => ({ ok: false, detail: 'connect ECONNREFUSED' }),
    })
    const out = await runConfigCommand('backend add m --endpoint ep --upstream up-1', {
      config: cfg,
      userId: 'bkgate',
    })
    assert.match(out, /failed the connectivity check/)
    const persisted = readUserConfigJson('bkgate')
    assert.equal((persisted.models as Record<string, unknown>).m, undefined)
    assert.equal('defaultModel' in persisted, false)
  })

  it('auto-promotes the first model to default (no --default needed)', async () => {
    const cfg = modelConfig()
    await addEndpointOk('bkdef', cfg)
    __setModelProbeHooksForTests({
      endpointModels: async () => ({ ok: true, summary: '' }),
      connectivity: async () => ({ ok: true }),
    })
    const out = await runConfigCommand('backend add m1 --endpoint ep --upstream up-1', {
      config: cfg,
      userId: 'bkdef',
    })
    assert.match(out, /Connectivity check: ok/)
    assert.match(out, /default model/i)
    assert.equal(readUserConfigJson('bkdef').defaultModel, 'm1')
  })

  it('does NOT change default for a second model; hints how to switch', async () => {
    const cfg = modelConfig()
    await addEndpointOk('bk2', cfg)
    __setModelProbeHooksForTests({
      endpointModels: async () => ({ ok: true, summary: '' }),
      connectivity: async () => ({ ok: true }),
    })
    await runConfigCommand('backend add m1 --endpoint ep --upstream up-1', { config: cfg, userId: 'bk2' })
    const out = await runConfigCommand('backend add m2 --endpoint ep --upstream up-2', {
      config: cfg,
      userId: 'bk2',
    })
    assert.match(out, /\/config model set m2/)
    assert.equal(readUserConfigJson('bk2').defaultModel, 'm1')
  })
})

describe('/config endpoint|backend set — re-check on update', () => {
  it('endpoint set rejects the update and keeps prior config when the re-check fails', async () => {
    const cfg = modelConfig()
    __setModelProbeHooksForTests({
      endpointModels: async () => ({ ok: true, summary: '' }),
      connectivity: async () => ({ ok: true }),
    })
    await runConfigCommand('endpoint add ep --type openai --key sk-RAW --base-url https://old', {
      config: cfg,
      userId: 'epset',
    })
    __setModelProbeHooksForTests({
      endpointModels: async () => ({ ok: false, detail: 'bad url' }),
      connectivity: async () => ({ ok: true }),
    })
    const out = await runConfigCommand('endpoint set ep --base-url https://new', {
      config: cfg,
      userId: 'epset',
    })
    assert.match(out, /rolled back|连通性/)
    const ep = (readUserConfigJson('epset').endpoints as Record<string, Record<string, unknown>>).ep
    assert.equal(ep.baseUrl, 'https://old') // unchanged
    assert.equal(out.includes('https://old'), true) // failure card shows ORIGINAL values
  })

  it('backend set rolls back to the prior entry when the re-check fails', async () => {
    const cfg = modelConfig()
    __setModelProbeHooksForTests({
      endpointModels: async () => ({ ok: true, summary: '' }),
      connectivity: async () => ({ ok: true }),
    })
    await runConfigCommand('endpoint add ep --type openai --key sk-RAW --base-url https://x', {
      config: cfg,
      userId: 'bkset',
    })
    await runConfigCommand('backend add m --endpoint ep --upstream up-1', { config: cfg, userId: 'bkset' })
    __setModelProbeHooksForTests({
      endpointModels: async () => ({ ok: true, summary: '' }),
      connectivity: async () => ({ ok: false, detail: 'timeout' }),
    })
    const out = await runConfigCommand('backend set m --upstream up-2', { config: cfg, userId: 'bkset' })
    assert.match(out, /rolled back|连通性/)
    const model = (readUserConfigJson('bkset').models as Record<string, Record<string, unknown>>).m
    assert.equal(model.upstreamModel, 'up-1') // rolled back
  })

  it('backend set succeeds and confirms the re-check', async () => {
    const cfg = modelConfig()
    __setModelProbeHooksForTests({
      endpointModels: async () => ({ ok: true, summary: '' }),
      connectivity: async () => ({ ok: true }),
    })
    await runConfigCommand('endpoint add ep --type openai --key sk-RAW --base-url https://x', {
      config: cfg,
      userId: 'bkset2',
    })
    await runConfigCommand('backend add m --endpoint ep --upstream up-1', { config: cfg, userId: 'bkset2' })
    const out = await runConfigCommand('backend set m --upstream up-2', { config: cfg, userId: 'bkset2' })
    assert.match(out, /Connectivity check: ok/)
    const model = (readUserConfigJson('bkset2').models as Record<string, Record<string, unknown>>).m
    assert.equal(model.upstreamModel, 'up-2')
  })
})

describe('/config endpoint|backend — show config values (not just names)', () => {
  beforeEach(() => {
    __setModelProbeHooksForTests({
      endpointModels: async () => ({ ok: true, summary: '' }),
      connectivity: async () => ({ ok: true }),
    })
  })

  it('endpoint add success card shows type / baseUrl / proxy (no key)', async () => {
    const cfg = modelConfig()
    const out = await runConfigCommand(
      'endpoint add ep --type openai --key sk-SECRET --base-url https://gw.example/v1 --proxy http://127.0.0.1:1080',
      { config: cfg, userId: 'vala' },
    )
    assert.match(out, /type=openai/)
    assert.match(out, /baseUrl=https:\/\/gw\.example\/v1/)
    assert.match(out, /proxy=http:\/\/127\.0\.0\.1:1080/)
    assert.equal(out.includes('sk-SECRET'), false) // key NEVER shown
  })

  it('endpoint list shows per-row config values', async () => {
    const cfg = modelConfig()
    await runConfigCommand('endpoint add ep --type openai --key sk-X --base-url https://x', {
      config: cfg,
      userId: 'vall',
    })
    const out = await runConfigCommand('endpoint', { config: cfg, userId: 'vall' })
    assert.match(out, /ep（type=openai, baseUrl=https:\/\/x, proxy=direct）/)
  })

  it('backend add success + list show endpoint / upstream / schema', async () => {
    const cfg = modelConfig()
    await runConfigCommand('endpoint add ep --type openai --key sk-X --base-url https://x', {
      config: cfg,
      userId: 'valb',
    })
    const add = await runConfigCommand('backend add m --endpoint ep --upstream gpt-5 --reasoning high', {
      config: cfg,
      userId: 'valb',
    })
    assert.match(add, /endpoint=ep/)
    assert.match(add, /upstream=gpt-5/)
    assert.match(add, /reasoning=high/)
    const list = await runConfigCommand('backend', { config: cfg, userId: 'valb' })
    assert.match(list, /m（endpoint=ep, upstream=gpt-5, schema=openai, reasoning=high, maxTokens=\d+ \(default\)）/)
  })
})

describe('/config detail cards show effective defaults (reasoning / maxTokens / proxy)', () => {
  beforeEach(() => {
    __setModelProbeHooksForTests({
      endpointModels: async () => ({ ok: true, summary: '' }),
      connectivity: async () => ({ ok: true }),
    })
  })

  it('backend with no --reasoning / --max-tokens shows the wire defaults marked (default)', async () => {
    const cfg = modelConfig()
    await runConfigCommand('endpoint add ep --type openai --key sk-X --base-url https://x', { config: cfg, userId: 'vd1' })
    const add = await runConfigCommand('backend add m --endpoint ep --upstream gpt-5', { config: cfg, userId: 'vd1' })
    assert.match(add, /reasoning=medium \(default\)/)
    assert.match(add, /maxTokens=\d+ \(default\)/)
  })

  it('explicit --reasoning / --max-tokens are shown WITHOUT the default marker', async () => {
    const cfg = modelConfig()
    await runConfigCommand('endpoint add ep --type openai --key sk-X --base-url https://x', { config: cfg, userId: 'vd2' })
    const add = await runConfigCommand(
      'backend add m --endpoint ep --upstream gpt-5 --reasoning high --max-tokens 1234',
      { config: cfg, userId: 'vd2' },
    )
    assert.match(add, /reasoning=high/)
    assert.doesNotMatch(add, /reasoning=high \(default\)/)
    assert.match(add, /maxTokens=1234/)
    assert.doesNotMatch(add, /maxTokens=1234 \(default\)/)
  })

  it('endpoint without --proxy shows the deployment public proxy as a label, NOT its address', async () => {
    writeFileSync(path.join(tmpHome, 'config.json'), JSON.stringify({ publicProxy: 'http://10.9.9.9:1090' }), 'utf8')
    const cfg = modelConfig()
    const add = await runConfigCommand('endpoint add ep --type openai --key sk-X --base-url https://x', { config: cfg, userId: 'vd3' })
    assert.match(add, /proxy=public proxy/)
    assert.doesNotMatch(add, /10\.9\.9\.9/) // the deployment proxy address is never shown
  })

  it('endpoint WITH an explicit --proxy shows its address (no public-proxy substitution)', async () => {
    writeFileSync(path.join(tmpHome, 'config.json'), JSON.stringify({ publicProxy: 'http://10.9.9.9:1090' }), 'utf8')
    const cfg = modelConfig()
    const add = await runConfigCommand(
      'endpoint add ep --type openai --key sk-X --base-url https://x --proxy http://127.0.0.1:1080',
      { config: cfg, userId: 'vd4' },
    )
    assert.match(add, /proxy=http:\/\/127\.0\.0\.1:1080/)
    assert.doesNotMatch(add, /public proxy/)
  })

  it('endpoint with no proxy and no public proxy shows direct', async () => {
    const cfg = modelConfig()
    const add = await runConfigCommand('endpoint add ep --type openai --key sk-X --base-url https://x', { config: cfg, userId: 'vd5' })
    assert.match(add, /proxy=direct/)
  })

  it('codex --login WITHOUT --proxy resolves the deployment public proxy for the device-login HTTP (regression)', async () => {
    // 2026-06-30 dogfood: `--type codex --login` with no --proxy connected
    // DIRECTLY to auth.openai.com and timed out, because the login path threaded
    // only the (absent) explicit --proxy instead of resolving own → public →
    // direct like every other codex wire call.
    writeFileSync(path.join(tmpHome, 'config.json'), JSON.stringify({ publicProxy: 'http://10.9.9.9:1090' }), 'utf8')
    let captured: string | undefined = 'UNSET'
    const out = await runConfigCommand('endpoint add codex-ep --type codex --login', {
      config: modelConfig(),
      userId: 'vdcdx',
      beginCodexDeviceLogin: async a => {
        captured = a.proxy
        return { ok: true as const }
      },
    })
    assert.equal(captured, 'http://10.9.9.9:1090') // public-proxy fallback applied (was undefined pre-fix)
    assert.doesNotMatch(out, /error|失败|Error/i)
  })

  it('codex --login WITH an explicit --proxy uses it over the public proxy', async () => {
    writeFileSync(path.join(tmpHome, 'config.json'), JSON.stringify({ publicProxy: 'http://10.9.9.9:1090' }), 'utf8')
    let captured: string | undefined = 'UNSET'
    await runConfigCommand('endpoint add codex-ep --type codex --login --proxy http://127.0.0.1:1080', {
      config: modelConfig(),
      userId: 'vdcdx2',
      beginCodexDeviceLogin: async a => {
        captured = a.proxy
        return { ok: true as const }
      },
    })
    assert.equal(captured, 'http://127.0.0.1:1080') // explicit wins
  })
})

describe('/config backend add — probe resolves against admin base, not session snapshot', () => {
  it('does NOT drop the just-added BYO model when ctx.config already holds the user endpoint', async () => {
    const cfg = modelConfig()
    // Fail the connectivity probe iff the just-added model is absent from the
    // resolved registry — the exact symptom of re-resolving an already-resolved
    // session config (the user's own endpoint "collides with itself").
    __setModelProbeHooksForTests({
      endpointModels: async () => ({ ok: true, summary: '' }),
      connectivity: async (resolved, name) =>
        resolved.models[name] ? { ok: true } : { ok: false, detail: `dropped:${name}` },
    })
    await runConfigCommand('endpoint add ep --type openai --key sk-X --base-url https://x', {
      config: cfg,
      userId: 'baseuser',
    })
    // Simulate the channel passing the SESSION-RESOLVED config (already contains
    // the user's own `ep`) — the shape that triggered the dogfood failure.
    const sessionSnapshot = {
      ...cfg,
      endpoints: { ...cfg.endpoints, ep: { apiKey: 'sk-X', baseUrl: 'https://x' } },
    } as unknown as LightClawConfig
    const out = await runConfigCommand('backend add m --endpoint ep --upstream up-1', {
      config: sessionSnapshot,
      userId: 'baseuser',
    })
    assert.match(out, /Connectivity check: ok/)
    assert.ok((readUserConfigJson('baseuser').models as Record<string, unknown>).m)
  })
})

describe('/config backend add — probe defers reasoning effort to the model config', () => {
  it('forces NO model-tuning param of its own — defers reasoning AND maxTokens to config', async () => {
    const cfg = modelConfig()
    // Run the REAL connectivity probe (only stub the endpoint-model listing) and
    // capture the streamChat params it sends. The class of bug: the probe forcing
    // a fixed model-tuning value that diverges from the user's resolved config and
    // false-rejects a working model on a parameter unrelated to connectivity —
    //   (1) reasoningEffort:'minimal' → gpt-5.5 400s;
    //   (2) maxTokens:512 → any Anthropic-thinking model behind a Bedrock gateway
    //       400s ("max_tokens must be greater than thinking.budget_tokens", the
    //       medium-effort budget ≥1024 > 512).
    // The probe must therefore send NEITHER override and inherit the exact wire
    // shape (reasoning + max_tokens) a real turn resolves from config.
    let seenReasoning: unknown = 'UNSET'
    let seenMaxTokens: unknown = 'UNSET'
    __setModelProbeHooksForTests({ endpointModels: async () => ({ ok: true, summary: '' }) })
    __setProbeStreamChatForTests(async function* (params) {
      seenReasoning = (params as { reasoningEffort?: unknown }).reasoningEffort
      seenMaxTokens = (params as { maxTokens?: unknown }).maxTokens
      yield { type: 'stop' } as never
    })
    await runConfigCommand('endpoint add codex-ep --type openai --key sk-X --base-url https://x', {
      config: cfg,
      userId: 'gptuser',
    })
    const out = await runConfigCommand('backend add gpt-5.5 --endpoint codex-ep --upstream gpt-5.5', {
      config: cfg,
      userId: 'gptuser',
    })
    assert.match(out, /Connectivity check: ok/)
    // No reasoning override (defers to the model's config / api.ts medium default).
    assert.equal(seenReasoning, undefined)
    assert.notEqual(seenReasoning, 'minimal')
    // No maxTokens override (defers to entry.maxOutputTokens ?? config.maxOutputTokens).
    // A literal 512 here is the regression that false-rejected Bedrock thinking models.
    assert.equal(seenMaxTokens, undefined)
    assert.notEqual(seenMaxTokens, 512)
    assert.ok((readUserConfigJson('gptuser').models as Record<string, unknown>)['gpt-5.5'])
  })
})

describe('/config backend|endpoint rm — removal cascade', () => {
  // Seed defaultModel + lane onto an already-built BYO config (no slash exists
  // for lane without a live session; defaultModel scalar needs one too).
  function seedDefaultAndLane(
    user: string,
    defaultModel: string,
    lane: Record<string, string>,
  ): void {
    const cfgJson = readUserConfigJson(user)
    cfgJson.defaultModel = defaultModel
    cfgJson.lane = lane
    writeFileSync(userConfigPath(user), JSON.stringify(cfgJson))
  }

  it('backend rm promotes a surviving BYO to default and clears the dangling lane', async () => {
    const cfg = modelConfig()
    const user = 'rmb'
    await runConfigCommand('endpoint add ep --type openai --key sk-X --base-url https://x', {
      config: cfg,
      userId: user,
    })
    await runConfigCommand('backend add modelA --endpoint ep --upstream up-a', { config: cfg, userId: user })
    await runConfigCommand('backend add modelB --endpoint ep --upstream up-b', { config: cfg, userId: user })
    seedDefaultAndLane(user, 'modelA', { worker: 'modelA', system: 'modelB' })

    const out = await runConfigCommand('backend rm modelA', { config: cfg, userId: user })

    const persisted = readUserConfigJson(user)
    const models = persisted.models as Record<string, unknown>
    assert.equal('modelA' in models, false)
    assert.ok('modelB' in models)
    // Default is promoted to the surviving BYO — NOT left empty (the regression
    // the user hit: deleting the default model bricked the user).
    assert.equal(persisted.defaultModel, 'modelB')
    // The worker lane pointed at the deleted model → cleared; the still-valid
    // system lane is preserved (pre-fix both survived and dangled).
    const lane = persisted.lane as Record<string, unknown>
    assert.equal('worker' in lane, false)
    assert.equal(lane.system, 'modelB')
    // Card announces both consequences so the behavior change is perceptible.
    assert.match(out, /Removed model "modelA"/)
    assert.match(out, /switched to "modelB"/)
    assert.match(out, /reset to the default/)
  })

  it('backend rm of the last model clears the default and the card guides reconfigure', async () => {
    const cfg = modelConfig()
    const user = 'rmlast'
    await runConfigCommand('endpoint add ep --type openai --key sk-X --base-url https://x', {
      config: cfg,
      userId: user,
    })
    await runConfigCommand('backend add only --endpoint ep --upstream up', { config: cfg, userId: user })
    seedDefaultAndLane(user, 'only', {})

    const out = await runConfigCommand('backend rm only', { config: cfg, userId: user })

    const persisted = readUserConfigJson(user)
    assert.equal('defaultModel' in persisted, false)
    assert.match(out, /reconfigure/)
  })

  it('endpoint rm cascades, promotes default off the surviving endpoint, resets dangling lane', async () => {
    const cfg = modelConfig()
    const user = 'rme'
    await runConfigCommand('endpoint add ep1 --type openai --key sk-1 --base-url https://1', {
      config: cfg,
      userId: user,
    })
    await runConfigCommand('endpoint add ep2 --type openai --key sk-2 --base-url https://2', {
      config: cfg,
      userId: user,
    })
    await runConfigCommand('backend add modelA --endpoint ep1 --upstream up-a', { config: cfg, userId: user })
    await runConfigCommand('backend add modelB --endpoint ep2 --upstream up-b', { config: cfg, userId: user })
    seedDefaultAndLane(user, 'modelA', { worker: 'modelA' })

    const out = await runConfigCommand('endpoint rm ep1 --y', { config: cfg, userId: user })

    const persisted = readUserConfigJson(user)
    assert.equal('ep1' in (persisted.endpoints as Record<string, unknown>), false)
    assert.ok('ep2' in (persisted.endpoints as Record<string, unknown>))
    const models = persisted.models as Record<string, unknown>
    assert.equal('modelA' in models, false)
    assert.ok('modelB' in models)
    assert.equal(persisted.defaultModel, 'modelB')
    // Only-bucket cleared → the whole lane object is dropped (worker resolved away).
    assert.equal((persisted.lane as Record<string, unknown> | undefined)?.worker, undefined)
    assert.match(out, /switched to "modelB"/)
  })
})
