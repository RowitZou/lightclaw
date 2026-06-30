import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { setLightclawHomeOverride } from '../paths.js'
import { userConfigPath, userSecretsPath } from '../identity/paths.js'
import { userCodexAuthPath } from '../auth/codex/user-store.js'
import { identityPreferencesPath } from '../identity/preferences.js'
import type { LightClawConfig, ModelEntry } from '../config.js'
import {
  buildUserRegistry,
  loadUserConfigOverride,
  readUserConfig,
  resolveUserConfig,
  setUserConfigField,
} from './user-override.js'

// resolveUserConfig only reads base.defaultModel / base.models / base.lang /
// base.lane and spreads the rest through. A minimal shaped base is enough to
// drive every branch without standing up a full getConfig().
function makeBase(input: {
  defaultModel: string
  models: Record<string, ModelEntry>
  lang?: 'cn' | 'en'
  lane?: { worker?: string; system?: string; image?: string }
}): LightClawConfig {
  return {
    lang: input.lang ?? 'cn',
    defaultModel: input.defaultModel,
    models: input.models,
    endpoints: { a: { apiKey: 'sk-fake' } as never },
    lane: input.lane ?? {},
  } as unknown as LightClawConfig
}

const MODELS: Record<string, ModelEntry> = {
  m: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'claude-fake' },
  mine: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'claude-mine' },
}

describe('resolveUserConfig', () => {
  let tmpHome: string

  beforeEach(() => {
    tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-user-override-test-'))
    setLightclawHomeOverride(tmpHome)
  })

  afterEach(() => {
    setLightclawHomeOverride(undefined)
    rmSync(tmpHome, { recursive: true, force: true })
  })

  function writeUserConfigJson(user: string, data: Record<string, unknown>): void {
    const target = userConfigPath(user)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify(data, null, 2))
  }

  it('case 1: admin has defaultModel, user has no config → uses admin default', () => {
    const base = makeBase({ defaultModel: 'm', models: MODELS })
    const resolved = resolveUserConfig('alice', base)
    assert.equal(resolved.defaultModel, 'm')
  })

  it('case 2: admin has no default, user config sets a model in the registry → uses user model', () => {
    const base = makeBase({ defaultModel: '', models: MODELS })
    writeUserConfigJson('alice', { defaultModel: 'mine' })
    const resolved = resolveUserConfig('alice', base)
    assert.equal(resolved.defaultModel, 'mine')
  })

  it('case 3: admin has no default, user has none → resolves to empty string (graceful, no throw)', () => {
    const base = makeBase({ defaultModel: '', models: MODELS })
    let resolved: LightClawConfig | undefined
    assert.doesNotThrow(() => {
      resolved = resolveUserConfig('alice', base)
    })
    assert.equal(resolved!.defaultModel, '')
  })

  it('case 4: user override points at a model not in the registry → falls back to admin default', () => {
    const base = makeBase({ defaultModel: 'm', models: MODELS })
    writeUserConfigJson('alice', { defaultModel: 'bogus-not-in-models' })
    const resolved = resolveUserConfig('alice', base)
    assert.equal(resolved.defaultModel, 'm')
  })

  it('case 4b: bogus user override AND no admin default → empty string, never the bogus value', () => {
    const base = makeBase({ defaultModel: '', models: MODELS })
    writeUserConfigJson('alice', { defaultModel: 'bogus-not-in-models' })
    const resolved = resolveUserConfig('alice', base)
    assert.equal(resolved.defaultModel, '')
  })

  it('case 5: never empties endpoints / models — admin registry preserved (deep-equal)', () => {
    const base = makeBase({ defaultModel: 'm', models: MODELS })
    writeUserConfigJson('alice', { defaultModel: 'mine' })
    const resolved = resolveUserConfig('alice', base)
    assert.deepEqual(resolved.models, base.models)
    assert.deepEqual(resolved.endpoints, base.endpoints)
  })

  it('back-compat: falls through to preferences.json model when config.json has no defaultModel', () => {
    const base = makeBase({ defaultModel: '', models: MODELS })
    const prefsPath = identityPreferencesPath('alice')
    mkdirSync(path.dirname(prefsPath), { recursive: true })
    writeFileSync(prefsPath, JSON.stringify({ model: 'mine' }))
    const resolved = resolveUserConfig('alice', base)
    assert.equal(resolved.defaultModel, 'mine')
  })

  it('config.json defaultModel wins over preferences.json model', () => {
    const base = makeBase({ defaultModel: 'm', models: MODELS })
    writeUserConfigJson('alice', { defaultModel: 'mine' })
    const prefsPath = identityPreferencesPath('alice')
    mkdirSync(path.dirname(prefsPath), { recursive: true })
    writeFileSync(prefsPath, JSON.stringify({ model: 'm' }))
    const resolved = resolveUserConfig('alice', base)
    assert.equal(resolved.defaultModel, 'mine')
  })

  it('lane override: user bucket wins; empty user bucket falls through to admin (new contract)', () => {
    // Codifies the Part A1 lane merge: per-bucket user-over-admin precedence,
    // with an empty user bucket treated as unset (fall through to admin).
    const base = makeBase({
      defaultModel: 'm',
      models: MODELS,
      lane: { worker: 'm', system: 'm', image: 'm' },
    })
    writeUserConfigJson('alice', { lane: { worker: 'mine', system: '' } })
    const resolved = resolveUserConfig('alice', base)
    // user worker wins; empty user system falls through to admin; image untouched.
    assert.deepEqual(resolved.lane, { worker: 'mine', system: 'm', image: 'm' })
    // A user with no lane override inherits admin's lane entirely.
    assert.deepEqual(resolveUserConfig('bob', base).lane, { worker: 'm', system: 'm', image: 'm' })
  })

  it('lane membership guard: drops a bucket naming a model not in the merged registry', () => {
    // The user (or an admin) deleted the backend a lane bucket pointed at. The
    // stale name must be dropped so resolveRoleModel falls back to defaultModel
    // instead of resolving a dangling name → getProviderFor "Unknown model".
    // Pre-fix the raw user value was returned verbatim and dangled.
    const base = makeBase({ defaultModel: 'm', models: MODELS })
    writeUserConfigJson('alice', { lane: { worker: 'ghost-deleted', system: 'm' } })
    const resolved = resolveUserConfig('alice', base)
    assert.equal(resolved.lane.worker, undefined) // dangling → dropped → falls back to default
    assert.equal(resolved.lane.system, 'm') // still in registry → kept
  })

  it('lane membership guard: drops a dangling admin bucket the user did not override', () => {
    // The guard also covers the admin-deletes-a-model case: admin getConfig()
    // strips its own lane, but a per-user resolve must not re-admit a stale base
    // bucket either. (Here base.lane.worker names a model absent from MODELS.)
    const base = makeBase({ defaultModel: 'm', models: MODELS, lane: { worker: 'gone' } })
    const resolved = resolveUserConfig('alice', base)
    assert.equal(resolved.lane.worker, undefined)
  })

  it('lang override: user lang wins, else base lang', () => {
    const base = makeBase({ defaultModel: 'm', models: MODELS, lang: 'cn' })
    writeUserConfigJson('alice', { lang: 'en' })
    assert.equal(resolveUserConfig('alice', base).lang, 'en')
    assert.equal(resolveUserConfig('bob', base).lang, 'cn')
  })

  it('canonical undefined → returns base unchanged', () => {
    const base = makeBase({ defaultModel: 'm', models: MODELS })
    assert.equal(resolveUserConfig(undefined, base), base)
  })

  it('strict schema rejects admin-only fields → loadUserConfigOverride degrades to {}', () => {
    // An admin-only field (e.g. runtime) makes the strict schema fail; the safe
    // parse degrades to {} so resolution falls to the admin default, never
    // honoring an injected admin-scoped key.
    writeUserConfigJson('alice', { defaultModel: 'mine', runtime: { backend: 'cluster' } })
    assert.deepEqual(loadUserConfigOverride('alice'), {})
    const base = makeBase({ defaultModel: 'm', models: MODELS })
    assert.equal(resolveUserConfig('alice', base).defaultModel, 'm')
  })

  it('corrupt config.json degrades to {} (no throw)', () => {
    const target = userConfigPath('alice')
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, '{ not json')
    assert.deepEqual(loadUserConfigOverride('alice'), {})
    const base = makeBase({ defaultModel: 'm', models: MODELS })
    assert.equal(resolveUserConfig('alice', base).defaultModel, 'm')
  })
})

describe('resolveUserConfig BYO registry union (PR5 checkpoint 1)', () => {
  let tmpHome: string

  beforeEach(() => {
    tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-byo-test-'))
    setLightclawHomeOverride(tmpHome)
  })

  afterEach(() => {
    setLightclawHomeOverride(undefined)
    rmSync(tmpHome, { recursive: true, force: true })
  })

  function writeUserConfigJson(user: string, data: Record<string, unknown>): void {
    const target = userConfigPath(user)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify(data, null, 2))
  }

  function writeSecret(user: string, name: string, value: string): void {
    const target = userSecretsPath(user)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(
      target,
      JSON.stringify({
        version: 1,
        secrets: { [name]: { value, enabled: true, updatedAt: new Date().toISOString() } },
      }),
    )
  }

  // (a) Zero BYO entries must still expose EVERY admin model + admin default.
  // This is the P0: if union were a REPLACE (`models: userModels`), `m` and
  // `mine` would vanish and defaultModel would resolve to '' (or crash a
  // downstream caller). Asserting the admin models are present alongside any
  // byo is exactly what a replace implementation cannot satisfy.
  it('(a) user with NO byo registry still sees every admin model and admin default', () => {
    const base = makeBase({ defaultModel: 'm', models: MODELS })
    const resolved = resolveUserConfig('alice', base)
    assert.equal(resolved.defaultModel, 'm')
    // Admin models survive untouched.
    assert.ok(resolved.models.m, 'admin model "m" must survive a zero-byo resolve')
    assert.ok(resolved.models.mine, 'admin model "mine" must survive a zero-byo resolve')
    assert.deepEqual(Object.keys(resolved.models).sort(), ['m', 'mine'])
  })

  it('(b) user with one byo apiKey model sees admin models PLUS their byo model', () => {
    const base = makeBase({ defaultModel: 'm', models: MODELS })
    writeSecret('alice', 'MY_KEY', 'sk-alice-secret')
    writeUserConfigJson('alice', {
      endpoints: { myep: { apiKeyRef: 'MY_KEY', baseUrl: 'https://api.example.com/v1' } },
      models: { 'my-gpt': { endpoint: 'myep', schema: 'openai', upstreamModel: 'gpt-4.1' } },
      defaultModel: 'my-gpt',
    })
    const resolved = resolveUserConfig('alice', base)
    // Admin models still present (union, not replace).
    assert.ok(resolved.models.m, 'admin model "m" must remain after union')
    assert.ok(resolved.models.mine, 'admin model "mine" must remain after union')
    // Byo model added.
    const byo = resolved.models['my-gpt']
    assert.ok(byo, 'byo model "my-gpt" must be unioned in')
    assert.equal(byo.schema, 'openai')
    assert.equal(byo.upstreamModel, 'gpt-4.1')
    assert.equal(byo.visibility, 'user')
    // Byo endpoint resolved with the secret value + credentialIdentity, and the
    // raw key NEVER appears in any config.json on disk.
    const ep = resolved.endpoints.myep as { apiKey?: string; credentialIdentity?: string }
    assert.equal(ep.apiKey, 'sk-alice-secret')
    assert.equal(ep.credentialIdentity, 'user:alice:secret:MY_KEY')
    const onDisk = readFileSync(userConfigPath('alice'), 'utf8')
    assert.ok(!onDisk.includes('sk-alice-secret'), 'raw key must never be written to config.json')
    // defaultModel resolves to the byo model.
    assert.equal(resolved.defaultModel, 'my-gpt')
  })

  it('(c) byo endpoint alias colliding with an admin alias → admin-only registry (rejection, no throw)', () => {
    // admin base has endpoint alias "a" (from makeBase). User defines "a" too.
    const base = makeBase({ defaultModel: 'm', models: MODELS })
    writeSecret('alice', 'MY_KEY', 'sk-alice-secret')
    writeUserConfigJson('alice', {
      endpoints: { a: { apiKeyRef: 'MY_KEY' } },
      models: { 'my-gpt': { endpoint: 'a', schema: 'openai', upstreamModel: 'gpt-4.1' } },
    })
    let resolved: LightClawConfig | undefined
    assert.doesNotThrow(() => {
      resolved = resolveUserConfig('alice', base)
    })
    // Fell back to admin-only: byo model NOT added, admin endpoint "a" intact.
    assert.equal(resolved!.models['my-gpt'], undefined)
    assert.deepEqual(resolved!.models, base.models)
    assert.deepEqual(resolved!.endpoints, base.endpoints)
  })

  it('(c2) partial collision: drop ONLY the colliding endpoint + its model, keep the rest', () => {
    // admin base has endpoint alias "a". User defines "a" (collides) AND "myep"
    // (clean), each with a model. Only the colliding pair is dropped.
    const base = makeBase({ defaultModel: 'm', models: MODELS })
    // writeSecret overwrites the whole file, so both endpoints share one secret.
    writeSecret('alice', 'K1', 'sk-1')
    writeUserConfigJson('alice', {
      endpoints: { a: { apiKeyRef: 'K1' }, myep: { apiKeyRef: 'K1' } },
      models: {
        'shadow-gpt': { endpoint: 'a', schema: 'openai', upstreamModel: 'gpt-4.1' },
        'my-gpt': { endpoint: 'myep', schema: 'openai', upstreamModel: 'gpt-4.1' },
      },
    })
    const resolved = resolveUserConfig('alice', base)
    // Colliding endpoint "a" + its model "shadow-gpt" dropped; admin "a" intact.
    assert.deepEqual(resolved.endpoints.a, base.endpoints.a)
    assert.equal(resolved.models['shadow-gpt'], undefined)
    // Clean user endpoint + model survive (the whole registry was NOT nuked).
    assert.ok(resolved.endpoints.myep)
    assert.ok(resolved.models['my-gpt'])
    assert.equal(resolved.models['my-gpt'].endpoint, 'myep')
  })

  it('(c3) idempotent: re-resolving an already-resolved config does NOT spuriously warn or drop the user BYO', () => {
    // myep / my-gpt do NOT collide with admin (base has only endpoint "a").
    const base = makeBase({ defaultModel: 'm', models: MODELS })
    writeSecret('alice', 'MY_KEY', 'sk-alice-secret')
    writeUserConfigJson('alice', {
      endpoints: { myep: { apiKeyRef: 'MY_KEY', baseUrl: 'https://api.example.com/v1' } },
      models: { 'my-gpt': { endpoint: 'myep', schema: 'openai', upstreamModel: 'gpt-4.1' } },
      defaultModel: 'my-gpt',
    })
    const first = resolveUserConfig('alice', base)
    assert.ok(first.models['my-gpt'], 'sanity: first resolve unions in the BYO model')

    // Feed the resolved config back through resolveUserConfig — a double-resolve,
    // as happens when a resolved config flows through a second resolution point
    // (e.g. run-subagent resolves, then runDispatchedAgent resolves again). The
    // user's own myep / my-gpt now sit in `base`; they must NOT be flagged as
    // admin collisions and must NOT emit the "collide with admin" warning.
    const warnings: string[] = []
    const origWrite = process.stderr.write
    process.stderr.write = ((chunk: unknown) => {
      warnings.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    let second: LightClawConfig
    try {
      second = resolveUserConfig('alice', first)
    } finally {
      process.stderr.write = origWrite
    }

    assert.equal(
      warnings.some(w => w.includes('collide with admin')),
      false,
      `double-resolve must not warn about self-collisions; got: ${warnings.join('')}`,
    )
    // Output is identical to a single resolve (idempotent).
    assert.deepEqual(second.models, first.models)
    assert.deepEqual(second.endpoints, first.endpoints)
    assert.ok(second.models['my-gpt'], 'BYO model survives the double-resolve')
  })

  it('(d) byo defaultModel unknown: falls back to admin default; with no admin default → empty string', () => {
    // With an admin default.
    const baseWithDefault = makeBase({ defaultModel: 'm', models: MODELS })
    writeUserConfigJson('alice', { defaultModel: 'ghost-model' })
    assert.equal(resolveUserConfig('alice', baseWithDefault).defaultModel, 'm')

    // With NO admin default → empty string, never the ghost.
    const baseNoDefault = makeBase({ defaultModel: '', models: MODELS })
    writeUserConfigJson('bob', { defaultModel: 'ghost-model' })
    assert.equal(resolveUserConfig('bob', baseNoDefault).defaultModel, '')
  })

  it('byo endpoint with a missing secret → graceful admin-only fallback, no throw', () => {
    const base = makeBase({ defaultModel: 'm', models: MODELS })
    // No secret written for MISSING_KEY.
    writeUserConfigJson('alice', {
      endpoints: { myep: { apiKeyRef: 'MISSING_KEY' } },
      models: { 'my-gpt': { endpoint: 'myep', schema: 'openai', upstreamModel: 'gpt-4.1' } },
    })
    let resolved: LightClawConfig | undefined
    assert.doesNotThrow(() => {
      resolved = resolveUserConfig('alice', base)
    })
    assert.equal(resolved!.models['my-gpt'], undefined)
    assert.deepEqual(resolved!.models, base.models)
  })
})

describe('resolveUserConfig BYO codex registry (PR5 checkpoint 2)', () => {
  let tmpHome: string

  beforeEach(() => {
    tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-byo-codex-test-'))
    setLightclawHomeOverride(tmpHome)
  })

  afterEach(() => {
    setLightclawHomeOverride(undefined)
    rmSync(tmpHome, { recursive: true, force: true })
  })

  function writeUserConfigJson(user: string, data: Record<string, unknown>): void {
    const target = userConfigPath(user)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify(data, null, 2))
  }

  // Write a fake per-user codex auth file directly (mimics the on-disk shape
  // importUserCodexAuth would produce) so the test never needs a real
  // `codex login` file or a network refresh. expires_at far in the future so
  // getUserCodexCredentials never tries to refresh.
  function writeFakeUserCodex(user: string, name = 'default'): void {
    const file = userCodexAuthPath(user, name)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(
      file,
      JSON.stringify({
        tokens: {
          access_token: 'fake-access-token',
          refresh_token: 'fake-refresh-token',
          expires_at: Date.now() + 86_400_000,
        },
        account_id: 'acct-fake',
        imported_at: new Date().toISOString(),
        source: 'codex-cli-import',
      }),
    )
  }

  it('(a) byo codex endpoint+model unions in with schema codex, visibility user, credentialOwner/authRef/credentialIdentity', () => {
    const base = makeBase({ defaultModel: 'm', models: MODELS })
    writeFakeUserCodex('alice', 'personal')
    writeUserConfigJson('alice', {
      endpoints: { 'my-codex': { authRef: 'codex:personal' } },
      models: { 'gpt-codex': { endpoint: 'my-codex', schema: 'codex', upstreamModel: 'gpt-5.5' } },
      defaultModel: 'gpt-codex',
    })
    const resolved = resolveUserConfig('alice', base)
    // Admin models survive (union).
    assert.ok(resolved.models.m && resolved.models.mine)
    const model = resolved.models['gpt-codex']
    assert.ok(model, 'byo codex model must be unioned in')
    assert.equal(model.schema, 'codex')
    assert.equal(model.upstreamModel, 'gpt-5.5')
    assert.equal(model.visibility, 'user')
    const ep = resolved.endpoints['my-codex'] as {
      auth?: string
      authRef?: string
      credentialOwner?: string
      credentialIdentity?: string
    }
    assert.equal(ep.auth, 'codex-oauth')
    assert.equal(ep.authRef, 'codex:personal')
    assert.equal(ep.credentialOwner, 'alice')
    assert.equal(ep.credentialIdentity, 'user:alice:auth:codex:personal')
    assert.equal(resolved.defaultModel, 'gpt-codex')
  })

  it('(b) openai-auth model referencing an apiKey endpoint (schema mismatch) → admin-only fallback, no throw', () => {
    const base = makeBase({ defaultModel: 'm', models: MODELS })
    writeSecret('alice', 'MY_KEY', 'sk-alice-secret')
    writeUserConfigJson('alice', {
      endpoints: { myep: { apiKeyRef: 'MY_KEY' } },
      models: { 'bad-codex': { endpoint: 'myep', schema: 'codex', upstreamModel: 'gpt-5.5' } },
    })
    let resolved: LightClawConfig | undefined
    assert.doesNotThrow(() => {
      resolved = resolveUserConfig('alice', base)
    })
    assert.equal(resolved!.models['bad-codex'], undefined)
    assert.deepEqual(resolved!.models, base.models)
  })

  it('(c) authRef endpoint whose codex auth is NOT imported → admin-only fallback, no throw', () => {
    const base = makeBase({ defaultModel: 'm', models: MODELS })
    // No fake codex auth written for "missing".
    writeUserConfigJson('alice', {
      endpoints: { 'my-codex': { authRef: 'codex:missing' } },
      models: { 'gpt-codex': { endpoint: 'my-codex', schema: 'codex', upstreamModel: 'gpt-5.5' } },
    })
    let resolved: LightClawConfig | undefined
    assert.doesNotThrow(() => {
      resolved = resolveUserConfig('alice', base)
    })
    assert.equal(resolved!.models['gpt-codex'], undefined)
    assert.deepEqual(resolved!.models, base.models)
    // The build error surfaces the import hint.
    const built = buildUserRegistry('alice', loadUserConfigOverride('alice'))
    assert.equal(built.ok, false)
    assert.match((built as { error: string }).error, /not imported; run \/config endpoint add .* --type codex --login/)
  })

  it('(d) config.json carries authRef but NOT any token value', () => {
    writeFakeUserCodex('alice', 'personal')
    writeUserConfigJson('alice', {
      endpoints: { 'my-codex': { authRef: 'codex:personal' } },
      models: { 'gpt-codex': { endpoint: 'my-codex', schema: 'codex', upstreamModel: 'gpt-5.5' } },
    })
    const onDisk = readFileSync(userConfigPath('alice'), 'utf8')
    assert.ok(onDisk.includes('codex:personal'), 'authRef must be present in config.json')
    assert.ok(!onDisk.includes('fake-access-token'), 'token must NEVER be written to config.json')
    assert.ok(!onDisk.includes('fake-refresh-token'), 'refresh token must NEVER be written to config.json')
  })

  it('(e) invariant #2: user BYO codex model survives in the union merge', () => {
    // The user's BYO codex model is name-distinct from any admin model, so the
    // union merge keeps it selectable. There is no startup credential-degrade
    // that could sweep or substitute it — a model that fails to authenticate
    // surfaces at call time, it is never silently disabled.
    const base = makeBase({
      defaultModel: 'm',
      models: {
        ...MODELS,
        'admin-codex': { endpoint: 'a', schema: 'codex', upstreamModel: 'gpt-admin' },
      },
    })
    writeFakeUserCodex('alice', 'personal')
    writeUserConfigJson('alice', {
      endpoints: { 'my-codex': { authRef: 'codex:personal' } },
      models: { 'gpt-codex': { endpoint: 'my-codex', schema: 'codex', upstreamModel: 'gpt-5.5' } },
      defaultModel: 'gpt-codex',
    })
    const resolved = resolveUserConfig('alice', base)
    // The user's BYO codex model is present and selectable.
    assert.ok(resolved.models['gpt-codex'], 'user BYO codex model must survive')
    assert.equal(resolved.models['gpt-codex'].schema, 'codex')
    // The admin codex model also survives the union (admin base ∪ user BYO).
    assert.ok(resolved.models['admin-codex'], 'admin codex model present in union')
    assert.equal(resolved.defaultModel, 'gpt-codex')
  })

  function writeSecret(user: string, name: string, value: string): void {
    const target = userSecretsPath(user)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(
      target,
      JSON.stringify({
        version: 1,
        secrets: { [name]: { value, enabled: true, updatedAt: new Date().toISOString() } },
      }),
    )
  }
})

describe('setUserConfigField (the /model per-user writer)', () => {
  let tmpHome: string

  beforeEach(() => {
    tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-user-override-write-test-'))
    setLightclawHomeOverride(tmpHome)
  })

  afterEach(() => {
    setLightclawHomeOverride(undefined)
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('case 6a: writes users/<u>/config.json and does NOT mutate the global config object', () => {
    const base = makeBase({ defaultModel: 'm', models: MODELS })
    setUserConfigField('alice', 'defaultModel', 'mine')

    // On disk.
    const onDisk = JSON.parse(readFileSync(userConfigPath('alice'), 'utf8'))
    assert.equal(onDisk.defaultModel, 'mine')

    // Global base untouched.
    assert.equal(base.defaultModel, 'm')

    // Resolution for alice now reflects her choice.
    assert.equal(resolveUserConfig('alice', base).defaultModel, 'mine')
  })

  it('case 6b: two users\' choices do not bleed across each other (per-user isolation)', () => {
    const base = makeBase({ defaultModel: 'm', models: MODELS })
    setUserConfigField('alice', 'defaultModel', 'mine')
    setUserConfigField('bob', 'defaultModel', 'm')

    assert.equal(resolveUserConfig('alice', base).defaultModel, 'mine')
    assert.equal(resolveUserConfig('bob', base).defaultModel, 'm')
    // A third user with no config still gets the admin default.
    assert.equal(resolveUserConfig('carol', base).defaultModel, 'm')
  })

  it('preserves unrelated keys (workspace round-trips alongside defaultModel)', () => {
    // PR3's workspace key must survive a /model write.
    setUserConfigField('alice', 'workspace', '/data/alice-ws')
    setUserConfigField('alice', 'defaultModel', 'mine')
    const merged = readUserConfig('alice')
    assert.equal(merged.workspace, '/data/alice-ws')
    assert.equal(merged.defaultModel, 'mine')
  })

  it('value undefined deletes the key, preserving others', () => {
    setUserConfigField('alice', 'workspace', '/data/alice-ws')
    setUserConfigField('alice', 'defaultModel', 'mine')
    setUserConfigField('alice', 'defaultModel', undefined)
    const merged = readUserConfig('alice')
    assert.equal(merged.defaultModel, undefined)
    assert.equal(merged.workspace, '/data/alice-ws')
  })
})
