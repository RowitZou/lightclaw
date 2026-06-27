import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  _resetProviderCacheForTests,
  clearProviderCache,
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
// `models`, `endpoints`, and `defaultModel`; everything else is left
// as a typed-cast empty object so the test stays focused on the
// registry resolution path.
function buildConfig(overrides?: Partial<LightClawConfig>): LightClawConfig {
  const base: Partial<LightClawConfig> = {
    defaultModel: 'opus',
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
  }
  return { ...(base as LightClawConfig), ...overrides }
}

// Every test in this file calls getProviderFor() at least once, and the
// first lookup per (endpoint, upstreamModel) triggers runStaticProbeOnce
// which persists to `<lightclawHome>/auth/capabilities-cache.json`. Without
// a file-level sandbox the fixture endpoint/model entries leak into the
// operator's real home — observed in 2026-05-18 dogfood where 4 fake
// entries (`anthropic-direct|e3b0c442|claude-opus-4-7`, `gateway|...|gpt-5.4-mini`,
// `codex|...|gpt-5.5`, etc.) appeared in `~/.lightclaw/auth/capabilities-cache.json`
// despite the operator never running the daemon.
let tmpHome: string

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-registry-test-'))
  setLightclawHomeOverride(tmpHome)
  // Drop the module-level capability-cache `cached` ref too — without this
  // the next test reads stale entries from the previous home before its
  // first write reseats the path.
  _resetCacheForTests()
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
  _resetProviderCacheForTests()
  _resetCacheForTests()
})

describe('provider registry', () => {

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

  it('clearProviderCache forces a rebuild so a changed publicProxy takes effect', () => {
    // First build with no public proxy: endpoint has no own proxy → direct.
    const cfg = buildConfig()
    const before = getProviderFor(cfg, 'opus').provider
    assert.strictEqual(getProviderFor(cfg, 'opus').provider, before, 'cached between calls')

    // Admin sets a public proxy. Without the flush the old (direct) provider
    // would linger; clearProviderCache drops it so the next lookup rebuilds
    // with the new effective proxy (endpoint has no own proxy → publicProxy).
    cfg.publicProxy = 'http://127.0.0.1:1080'
    clearProviderCache()
    const after = getProviderFor(cfg, 'opus').provider
    assert.notStrictEqual(after, before, 'rebuilt after clearProviderCache')
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

  // g.1: in the graceful no-default-model state an empty model may reach the
  // single provider chokepoint (a path that resolved roleModel /
  // resolveToolModuleModel to ''); it must raise a clear, actionable error —
  // NOT the confusing `Unknown model ""`.
  it('throws a clear "No model is configured" error for an empty model name', () => {
    const cfg = buildConfig()
    assert.throws(
      () => getProviderFor(cfg, ''),
      (err: unknown) =>
        err instanceof Error &&
        /No model is configured/.test(err.message) &&
        !/Unknown model/.test(err.message),
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

  it('getProvider() defaults to defaultModel', () => {
    const cfg = buildConfig({
      defaultModel: 'opus-via-gw',
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
  it('anthropic reports audio + video drops for both positions', () => {
    const cfg = buildConfig()
    const { provider } = getProviderFor(cfg, 'opus')
    assert.deepEqual((provider.detectStaticDropKinds?.() ?? []).slice().sort(), ['audio', 'video'])
    assert.deepEqual((provider.detectStaticDropKindsInToolResult?.() ?? []).slice().sort(), ['audio', 'video'])
  })

  it('openai (Responses, apiKey) reports only audio + video — image + pdf supported in both positions', () => {
    const cfg = buildConfig()
    const { provider } = getProviderFor(cfg, 'gpt-mini')
    const dropped = (provider.detectStaticDropKinds?.() ?? []).slice().sort()
    // Chat Completions was retired (2026-06-27): the `openai` schema now speaks
    // the Responses API, which carries image (input_image) AND pdf (input_file)
    // in user messages AND tool_results. Only audio/video have no slot. This is
    // the capability win that motivated the switch — tool_result images used to
    // be undeliverable on Chat Completions' string-only `role:"tool"` message.
    assert.deepEqual(dropped, ['audio', 'video'])
    assert.equal(dropped.includes('image'), false)
    assert.equal(dropped.includes('pdf'), false)
    assert.deepEqual(
      (provider.detectStaticDropKindsInToolResult?.() ?? []).slice().sort(),
      ['audio', 'video'],
    )
  })

  it('openai-auth (codex) reports only audio + video — document goes through input_file', () => {
    const cfg: LightClawConfig = {
      ...buildConfig(),
      models: {
        codex: {
          endpoint: 'codex',
          schema: 'codex',
          upstreamModel: 'gpt-5.5',
        },
      },
      endpoints: {
        codex: { auth: 'codex-oauth' },
      },
      defaultModel: 'codex',
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
  it('writes disabled entries for every kind and position reported by probes', () => {
    const cfg = buildConfig()
    // First lookup primes the cache.
    getProviderFor(cfg, 'gpt-mini')

    const read = (kind: 'image' | 'pdf' | 'audio' | 'video', position: 'inUserMessage' | 'inToolResult') =>
      readCacheEntry({
        endpoint: 'gateway',
        baseUrl: 'http://gw.example/',
        upstreamModel: 'gpt-5.4-mini',
        kind,
        position,
      })

    // openai now speaks the Responses API: audio / video have no wire slot in
    // either position, so they precharge disabled.
    for (const position of ['inUserMessage', 'inToolResult'] as const) {
      for (const kind of ['audio', 'video'] as const) {
        assert.deepEqual(
          read(kind, position),
          { enabled: false, failures: 0 },
          `expected ${kind}/${position} cache=false after precharge`,
        )
      }
      // image (input_image) and pdf (input_file) ARE carried in BOTH positions
      // — precharge writes enabled:true. The tool_result image case is the
      // capability that Chat Completions could not represent.
      for (const kind of ['image', 'pdf'] as const) {
        assert.deepEqual(
          read(kind, position),
          { enabled: true, failures: 0 },
          `expected ${kind}/${position} cache=true after precharge`,
        )
      }
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
          schema: 'codex',
          upstreamModel: 'gpt-5.5',
        },
      },
      endpoints: { codex: { auth: 'codex-oauth' } },
      defaultModel: 'codex',
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
          schema: 'codex',
          upstreamModel: 'gpt-5.5',
        },
      },
      endpoints: { codex: { auth: 'codex-oauth' } },
      defaultModel: 'codex',
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
