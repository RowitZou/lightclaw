import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { setLightclawHomeOverride } from '../paths.js'
import { userConfigPath } from '../identity/paths.js'
import { identityPreferencesPath } from '../identity/preferences.js'
import type { LightClawConfig, ModelEntry } from '../config.js'
import {
  loadUserConfigOverride,
  readUserConfig,
  resolveUserConfig,
  setUserConfigField,
} from './user-override.js'

// resolveUserConfig only reads base.defaultModel / base.models / base.lang and
// spreads the rest through. A minimal shaped base is enough to drive every
// branch without standing up a full getConfig().
function makeBase(input: {
  defaultModel: string
  models: Record<string, ModelEntry>
  lang?: 'cn' | 'en'
}): LightClawConfig {
  return {
    lang: input.lang ?? 'cn',
    defaultModel: input.defaultModel,
    models: input.models,
    endpoints: { a: { apiKey: 'sk-fake' } as never },
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
