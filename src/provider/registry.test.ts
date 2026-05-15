import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  _resetProviderCacheForTests,
  getProvider,
  getProviderFor,
} from './index.js'
import {
  _resetCacheForTests,
  readCacheEntry,
  writeCacheEntry,
} from './capability-cache.js'
import { setLightclawHomeOverride } from '../paths.js'
import type { LightClawConfig } from '../config.js'

// Build a minimal LightClawConfig stub. The provider layer only reads
// `models`, `endpoints`, `routing`, and `model`; everything else is left
// as a typed-cast empty object so the test stays focused on the
// registry resolution path.
function buildConfig(overrides?: Partial<LightClawConfig>): LightClawConfig {
  const base: Partial<LightClawConfig> = {
    model: 'opus',
    models: {
      opus: {
        endpoint: 'anthropic-direct',
        schema: 'anthropic',
        upstreamModel: 'claude-opus-4-7',
      },
      'opus-via-gw': {
        endpoint: 'gateway',
        schema: 'anthropic',
        upstreamModel: 'claude-opus-4-7-thinking',
      },
      'gpt-mini': {
        endpoint: 'gateway',
        schema: 'openai',
        upstreamModel: 'gpt-5.4-mini',
      },
    },
    endpoints: {
      'anthropic-direct': { apiKey: 'sk-ant-x' },
      gateway: { apiKey: 'sk-gw-x', baseUrl: 'http://gw.example/' },
    },
    routing: { main: 'opus' },
  }
  return { ...(base as LightClawConfig), ...overrides }
}

describe('provider registry', () => {
  afterEach(() => {
    _resetProviderCacheForTests()
  })

  it('resolves a known display name to its provider + entry', () => {
    const cfg = buildConfig()
    const { provider, entry } = getProviderFor(cfg, 'opus')
    assert.equal(provider.name, 'anthropic')
    assert.equal(entry.upstreamModel, 'claude-opus-4-7')
    assert.equal(entry.endpoint, 'anthropic-direct')
  })

  it('returns the same provider instance for repeated lookups under the same (schema, endpoint)', () => {
    const cfg = buildConfig()
    const a = getProviderFor(cfg, 'opus').provider
    const b = getProviderFor(cfg, 'opus').provider
    assert.strictEqual(a, b)
  })

  it('shares one provider across two display names that point to the same endpoint + schema', () => {
    const cfg = buildConfig()
    const a = getProviderFor(cfg, 'opus-via-gw').provider
    // Add a synthetic alias pointing at the same (schema=anthropic, endpoint=gateway).
    cfg.models['opus-via-gw-alias'] = {
      endpoint: 'gateway',
      schema: 'anthropic',
      upstreamModel: 'claude-opus-4-7-thinking',
    }
    const b = getProviderFor(cfg, 'opus-via-gw-alias').provider
    assert.strictEqual(a, b)
  })

  it('builds distinct provider instances for the same endpoint under different schemas', () => {
    const cfg = buildConfig()
    const ant = getProviderFor(cfg, 'opus-via-gw').provider // schema=anthropic
    const oai = getProviderFor(cfg, 'gpt-mini').provider // schema=openai, same endpoint
    assert.notStrictEqual(ant, oai)
    assert.equal(ant.name, 'anthropic')
    assert.equal(oai.name, 'openai')
  })

  it('throws on unknown display name', () => {
    const cfg = buildConfig()
    assert.throws(
      () => getProviderFor(cfg, 'mystery-model'),
      /Unknown model "mystery-model"/,
    )
  })

  it('throws if model references a missing endpoint', () => {
    const cfg = buildConfig()
    cfg.models['orphan'] = {
      endpoint: 'no-such-endpoint',
      schema: 'anthropic',
      upstreamModel: 'whatever',
    }
    assert.throws(
      () => getProviderFor(cfg, 'orphan'),
      /references endpoint "no-such-endpoint"/,
    )
  })

  it('getProvider() defaults to routing.main', () => {
    const cfg = buildConfig({
      routing: { main: 'opus-via-gw' },
    })
    const provider = getProvider(cfg)
    assert.equal(provider.name, 'anthropic')
    // Confirm it picked the gateway-flavored anthropic instance (not the
    // direct one), by re-resolving and asserting identity.
    const direct = getProviderFor(cfg, 'opus').provider
    const gateway = getProviderFor(cfg, 'opus-via-gw').provider
    assert.strictEqual(provider, gateway)
    assert.notStrictEqual(provider, direct)
  })
})

describe('provider.detectStaticDropKinds', () => {
  afterEach(() => {
    _resetProviderCacheForTests()
  })

  it('anthropic reports audio + video drops for both positions', () => {
    const cfg = buildConfig()
    const { provider } = getProviderFor(cfg, 'opus')
    assert.deepEqual((provider.detectStaticDropKinds?.() ?? []).slice().sort(), ['audio', 'video'])
    assert.deepEqual((provider.detectStaticDropKindsInToolResult?.() ?? []).slice().sort(), ['audio', 'video'])
  })

  it('openai reports pdf + audio + video as schema-unsupported', () => {
    const cfg = buildConfig()
    const { provider } = getProviderFor(cfg, 'gpt-mini')
    const dropped = (provider.detectStaticDropKinds?.() ?? []).slice().sort()
    assert.deepEqual(dropped, ['audio', 'pdf', 'video'])
    // Image is NOT in the dropped list — OpenAI image_url parts are how
    // user-role images flow through. Regression guard.
    assert.equal(dropped.includes('image'), false)
    assert.deepEqual(
      (provider.detectStaticDropKindsInToolResult?.() ?? []).slice().sort(),
      ['audio', 'image', 'pdf', 'video'],
    )
  })

  it('openai-auth (codex) reports only audio + video — document goes through input_file', () => {
    const cfg: LightClawConfig = {
      ...buildConfig(),
      models: {
        codex: {
          endpoint: 'codex',
          schema: 'openai-auth',
          upstreamModel: 'gpt-5.5',
        },
      },
      endpoints: {
        codex: { auth: 'codex-oauth' },
      },
      routing: { main: 'codex' },
    }
    const { provider } = getProviderFor(cfg, 'codex')
    const dropped = (provider.detectStaticDropKinds?.() ?? []).slice().sort()
    // PDF/document is intentionally NOT dropped here — the converter emits
    // input_file for application/pdf, verified working against gpt-5.5 on
    // the Codex backend (2026-05-13 dogfood). Regression guard for the
    // converter-gap that produced pdf:false in capabilities-cache.json
    // from 5-09 through 5-13.
    assert.deepEqual(dropped, ['audio', 'video'])
    assert.equal(dropped.includes('pdf'), false)
    assert.deepEqual(
      (provider.detectStaticDropKindsInToolResult?.() ?? []).slice().sort(),
      ['audio', 'video'],
    )
  })
})

describe('provider precharge writes capability cache', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'lightclaw-precharge-test-'))
    setLightclawHomeOverride(home)
    _resetProviderCacheForTests()
    // Drop the capability-cache in-memory state too — without this, the
    // `cached` module-level variable from a prior test (potentially under
    // a different lightclaw home) leaks across tests and reads return
    // stale flags. This pair (provider cache + capability cache) needs to
    // reset together for any test that depends on a fresh precharge.
    _resetCacheForTests()
  })

  afterEach(() => {
    setLightclawHomeOverride(undefined)
    rmSync(home, { recursive: true, force: true })
    _resetProviderCacheForTests()
    _resetCacheForTests()
  })

  it('writes disabled entries for every kind and position reported by probes', () => {
    const cfg = buildConfig()
    // First lookup primes the cache.
    getProviderFor(cfg, 'gpt-mini')

    // User-message probe drops pdf / audio / video.
    for (const kind of ['pdf', 'audio', 'video'] as const) {
      assert.deepEqual(
        readCacheEntry({
          endpoint: 'gateway',
          baseUrl: 'http://gw.example/',
          upstreamModel: 'gpt-5.4-mini',
          kind,
          position: 'inUserMessage',
        }),
        { enabled: false, failures: 0 },
        `expected ${kind} cache=false after precharge`,
      )
    }
    assert.deepEqual(
      readCacheEntry({
        endpoint: 'gateway',
        baseUrl: 'http://gw.example/',
        upstreamModel: 'gpt-5.4-mini',
        kind: 'image',
        position: 'inUserMessage',
      }),
      { enabled: true, failures: 0 },
      'image user-message path is enabled because the converter emits image_url parts',
    )
    // Tool-result probe drops every kind for Chat Completions.
    for (const kind of ['image', 'pdf', 'audio', 'video'] as const) {
      assert.deepEqual(
        readCacheEntry({
          endpoint: 'gateway',
          baseUrl: 'http://gw.example/',
          upstreamModel: 'gpt-5.4-mini',
          kind,
          position: 'inToolResult',
        }),
        { enabled: false, failures: 0 },
      )
    }
  })

  it('keeps a prior runtime-disabled entry when the converter now emits', () => {
    writeCacheEntry({
      endpoint: 'codex',
      baseUrl: undefined,
      upstreamModel: 'gpt-5.5',
      kind: 'pdf',
      position: 'inUserMessage',
      entry: { enabled: false, failures: 5 },
    })
    const cfg: LightClawConfig = {
      ...buildConfig(),
      models: {
        codex: {
          endpoint: 'codex',
          schema: 'openai-auth',
          upstreamModel: 'gpt-5.5',
        },
      },
      endpoints: { codex: { auth: 'codex-oauth' } },
      routing: { main: 'codex' },
    }
    getProviderFor(cfg, 'codex')

    assert.deepEqual(
      readCacheEntry({
        endpoint: 'codex',
        baseUrl: undefined,
        upstreamModel: 'gpt-5.5',
        kind: 'pdf',
        position: 'inUserMessage',
      }),
      { enabled: false, failures: 5 },
    )
  })

  it('preserves enabled failures when an openai-auth probe now emits tool_result images', () => {
    writeCacheEntry({
      endpoint: 'codex',
      baseUrl: undefined,
      upstreamModel: 'gpt-5.5',
      kind: 'image',
      position: 'inToolResult',
      entry: { enabled: true, failures: 3 },
    })
    const cfg: LightClawConfig = {
      ...buildConfig(),
      models: {
        codex: {
          endpoint: 'codex',
          schema: 'openai-auth',
          upstreamModel: 'gpt-5.5',
        },
      },
      endpoints: { codex: { auth: 'codex-oauth' } },
      routing: { main: 'codex' },
    }
    getProviderFor(cfg, 'codex')

    assert.deepEqual(
      readCacheEntry({
        endpoint: 'codex',
        baseUrl: undefined,
        upstreamModel: 'gpt-5.5',
        kind: 'image',
        position: 'inToolResult',
      }),
      { enabled: true, failures: 3 },
    )
  })

  it('precharges anthropic image/pdf true and audio/video false', () => {
    const cfg = buildConfig()
    getProviderFor(cfg, 'opus')
    for (const kind of ['image', 'pdf'] as const) {
      for (const position of ['inUserMessage', 'inToolResult'] as const) {
        assert.deepEqual(
          readCacheEntry({
            endpoint: 'anthropic-direct',
            baseUrl: undefined,
            upstreamModel: 'claude-opus-4-7',
            kind,
            position,
          }),
          { enabled: true, failures: 0 },
        )
      }
    }
    for (const kind of ['audio', 'video'] as const) {
      assert.deepEqual(
        readCacheEntry({
          endpoint: 'anthropic-direct',
          baseUrl: undefined,
          upstreamModel: 'claude-opus-4-7',
          kind,
          position: 'inUserMessage',
        }),
        { enabled: false, failures: 0 },
      )
    }
  })
})
