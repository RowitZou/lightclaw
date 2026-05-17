import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { getConfig } from './config.js'
import { setLightclawHomeOverride } from './paths.js'

let tmpHome: string

function withDefaultModelForTest(body: object): object {
  if (
    'defaultModel' in body ||
    !('models' in body) ||
    body.models === null ||
    typeof body.models !== 'object' ||
    Array.isArray(body.models)
  ) {
    return body
  }
  const [firstModel] = Object.keys(body.models)
  return firstModel === undefined ? body : { ...body, defaultModel: firstModel }
}

function writeConfig(body: object): void {
  writeFileSync(path.join(tmpHome, 'config.json'), JSON.stringify(withDefaultModelForTest(body)))
}

function writeConfigRaw(body: object): void {
  writeFileSync(path.join(tmpHome, 'config.json'), JSON.stringify(body))
}

const ENV_KEYS = [
  'LIGHTCLAW_DEFAULT_MODEL',
  'LIGHTCLAW_DEFERRED_LOADING',
  'LIGHTCLAW_DEFERRED_LOADING_THRESHOLD',
] as const

const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-config-test-'))
  setLightclawHomeOverride(tmpHome)
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = savedEnv[key]
    }
  }
})

describe('config: endpoints + models registry', () => {
  it('throws when no models are configured', () => {
    writeConfig({})
    assert.throws(() => getConfig(), /No models configured/)
  })

  it('parses a minimal endpoints + models registry', () => {
    writeConfig({
      endpoints: {
        a: { apiKey: 'sk-a', baseUrl: 'http://a/' },
      },
      models: {
        opus: {
          endpoint: 'a',
          schema: 'anthropic',
          upstreamModel: 'claude-opus-4-7',
        },
      },
      defaultModel: 'opus',
    })
    const cfg = getConfig()
    assert.equal(cfg.defaultModel, 'opus')
    assert.deepEqual(cfg.endpoints.a, { apiKey: 'sk-a', baseUrl: 'http://a/' })
    assert.equal(cfg.models.opus.upstreamModel, 'claude-opus-4-7')
    assert.equal(cfg.models.opus.schema, 'anthropic')
  })

  it('parses model-level reasoningEffort', () => {
    writeConfig({
      endpoints: {
        codex: { auth: 'codex-oauth' },
      },
      models: {
        'gpt-5.5': {
          endpoint: 'codex',
          schema: 'openai-auth',
          upstreamModel: 'gpt-5.5',
          reasoningEffort: 'high',
        },
      },
      defaultModel: 'gpt-5.5',
    })
    const cfg = getConfig()
    assert.equal(cfg.models['gpt-5.5'].reasoningEffort, 'high')
  })

  it('rejects invalid model-level reasoningEffort', () => {
    writeConfig({
      endpoints: { codex: { auth: 'codex-oauth' } },
      models: {
        bad: {
          endpoint: 'codex',
          schema: 'openai-auth',
          upstreamModel: 'gpt-5.5',
          reasoningEffort: 'extreme',
        },
      },
    })
    assert.throws(() => getConfig(), /reasoningEffort must be one of/)
  })

  it('throws when defaultModel is not configured', () => {
    writeConfigRaw({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: {
        primary: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' },
      },
    })
    assert.throws(() => getConfig(), /`defaultModel` is required/)
  })

  it('LIGHTCLAW_DEFAULT_MODEL overrides file defaultModel', () => {
    writeConfig({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: {
        opus: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' },
        sonnet: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'y' },
      },
      defaultModel: 'opus',
    })
    process.env.LIGHTCLAW_DEFAULT_MODEL = 'sonnet'
    const cfg = getConfig()
    assert.equal(cfg.defaultModel, 'sonnet')
  })

  it('rejects defaultModel not present in models', () => {
    writeConfig({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: {
        opus: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' },
      },
      defaultModel: 'sonnet',
    })
    assert.throws(() => getConfig(), /defaultModel = "sonnet" is not in models/)
  })

  it('rejects models referencing an unknown endpoint', () => {
    writeConfig({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: {
        bad: { endpoint: 'missing', schema: 'anthropic', upstreamModel: 'x' },
      },
    })
    assert.throws(
      () => getConfig(),
      /endpoint = "missing" is not defined in endpoints/,
    )
  })

  it('rejects models with missing required fields', () => {
    writeConfig({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: { incomplete: { endpoint: 'a', schema: 'anthropic' } },
    })
    assert.throws(() => getConfig(), /upstreamModel is required/)
  })

  it('rejects models with an invalid schema', () => {
    writeConfig({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: {
        weird: {
          endpoint: 'a',
          schema: 'gemini',
          upstreamModel: 'gemini-2.0',
        },
      },
    })
    assert.throws(
      () => getConfig(),
      /schema must be one of: "anthropic", "openai", "openai-auth"/,
    )
  })

  it('rejects endpoints without an apiKey', () => {
    writeConfig({
      endpoints: { a: { baseUrl: 'http://a/' } },
      models: {
        opus: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' },
      },
    })
    assert.throws(() => getConfig(), /endpoints\["a"\]\.apiKey is required/)
  })

  it('silently ignores legacy file routing targets', () => {
    writeConfig({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: {
        opus: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' },
      },
      defaultModel: 'opus',
      routing: { main: 'opus', extract: 'phantom' },
    })
    const cfg = getConfig()
    assert.equal(cfg.defaultModel, 'opus')
  })

  it('parses worker and internal role config', () => {
    writeConfig({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: {
        sonnet: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' },
        haiku: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'y' },
      },
      defaultModel: 'sonnet',
      roles: {
        webSearcher: {
          model: 'haiku',
          maxTurns: 30,
          budget: { maxTokens: 1000, maxCost: 0.5 },
        },
        internal: {
          model: 'haiku',
        },
      },
    })
    const cfg = getConfig()
    assert.deepEqual(cfg.roles?.webSearcher, {
      model: 'haiku',
      maxTurns: 30,
      budget: { maxTokens: 1000, maxCost: 0.5 },
    })
    assert.deepEqual(cfg.roles?.internal, { model: 'haiku' })
  })

  it('rejects roles.main because main is bound to defaultModel', () => {
    writeConfig({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: {
        sonnet: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' },
      },
      defaultModel: 'sonnet',
      roles: {
        main: { model: 'sonnet' },
      },
    })
    assert.throws(() => getConfig(), /main is bound to `defaultModel`/)
  })

  it('rejects per-internal-role config in favor of roles.internal', () => {
    writeConfig({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: {
        sonnet: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' },
      },
      defaultModel: 'sonnet',
      roles: {
        memoryExtractor: { model: 'sonnet' },
      },
    })
    assert.throws(() => getConfig(), /kind='internal'.*roles\.internal/)
  })

  it('rejects invalid role model and maxTurns values', () => {
    writeConfig({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: {
        sonnet: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' },
      },
      defaultModel: 'sonnet',
      roles: {
        webSearcher: { model: 'missing' },
      },
    })
    assert.throws(() => getConfig(), /roles\.webSearcher\.model = "missing" is not in models/)

    writeConfig({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: {
        sonnet: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' },
      },
      defaultModel: 'sonnet',
      roles: {
        webSearcher: { maxTurns: -1 },
      },
    })
    assert.throws(() => getConfig(), /roles\.webSearcher\.maxTurns must be a positive integer/)
  })

  it('parses tool module model pins', () => {
    writeConfig({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: {
        sonnet: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' },
        haiku: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'y' },
      },
      defaultModel: 'sonnet',
      tools: {
        webSearch: { braveApiKey: 'brave', model: 'haiku' },
        imageRead: { model: 'haiku' },
        compact: { model: 'haiku' },
      },
    })
    const cfg = getConfig()
    assert.deepEqual(cfg.tools.webSearch, { braveApiKey: 'brave', model: 'haiku' })
    assert.deepEqual(cfg.tools.imageRead, { model: 'haiku' })
    assert.deepEqual(cfg.tools.compact, { model: 'haiku' })
  })

  it('rejects tool module models not present in models', () => {
    writeConfig({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: {
        sonnet: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' },
      },
      defaultModel: 'sonnet',
      tools: {
        imageRead: { model: 'missing' },
      },
    })
    assert.throws(() => getConfig(), /tools\.imageRead\.model = "missing" is not in models/)
  })

  it('parses an OAuth endpoint without apiKey', () => {
    writeConfig({
      endpoints: {
        codex: { auth: 'codex-oauth' },
      },
      models: {
        'gpt-5-codex': {
          endpoint: 'codex',
          schema: 'openai-auth',
          upstreamModel: 'gpt-5',
        },
      },
      defaultModel: 'gpt-5-codex',
    })
    const cfg = getConfig()
    assert.deepEqual(cfg.endpoints.codex, { auth: 'codex-oauth' })
    assert.equal(cfg.models['gpt-5-codex'].schema, 'openai-auth')
  })

  it('rejects endpoints with both apiKey and auth', () => {
    writeConfig({
      endpoints: {
        bad: { apiKey: 'sk-x', auth: 'codex-oauth' },
      },
      models: {
        m: { endpoint: 'bad', schema: 'openai-auth', upstreamModel: 'gpt-5' },
      },
    })
    assert.throws(
      () => getConfig(),
      /apiKey and auth are mutually exclusive/,
    )
  })

  it('rejects unknown auth values', () => {
    writeConfig({
      endpoints: {
        weird: { auth: 'mystery-oauth' as 'codex-oauth' },
      },
      models: {
        m: { endpoint: 'weird', schema: 'openai-auth', upstreamModel: 'gpt-5' },
      },
    })
    assert.throws(
      () => getConfig(),
      /auth = "mystery-oauth" is not recognized/,
    )
  })

  it('rejects openai-auth schema on apiKey endpoint', () => {
    writeConfig({
      endpoints: { keyed: { apiKey: 'sk-x' } },
      models: {
        bad: {
          endpoint: 'keyed',
          schema: 'openai-auth',
          upstreamModel: 'gpt-5',
        },
      },
    })
    assert.throws(
      () => getConfig(),
      /schema = "openai-auth" requires endpoint "keyed" to have an auth field/,
    )
  })

  it('rejects apiKey-bearing schemas on OAuth endpoint', () => {
    writeConfig({
      endpoints: { codex: { auth: 'codex-oauth' } },
      models: {
        bad: {
          endpoint: 'codex',
          schema: 'openai',
          upstreamModel: 'gpt-5-mini',
        },
      },
    })
    assert.throws(
      () => getConfig(),
      /schema = "openai" cannot use endpoint "codex"/,
    )
  })

  it('round-trips a registry mixing apiKey and OAuth endpoints', () => {
    writeConfig({
      endpoints: {
        newapi: { apiKey: 'sk-a', baseUrl: 'http://gw/' },
        codex: { auth: 'codex-oauth' },
      },
      models: {
        sonnet: {
          endpoint: 'newapi',
          schema: 'anthropic',
          upstreamModel: 'claude-sonnet-4-6',
        },
        'gpt-5-codex': {
          endpoint: 'codex',
          schema: 'openai-auth',
          upstreamModel: 'gpt-5',
        },
      },
      defaultModel: 'sonnet',
      routing: { main: 'sonnet', extract: 'gpt-5-codex' },
    })
    const cfg = getConfig()
    assert.equal(cfg.defaultModel, 'sonnet')
    assert.deepEqual(cfg.endpoints.newapi, {
      apiKey: 'sk-a',
      baseUrl: 'http://gw/',
    })
    assert.deepEqual(cfg.endpoints.codex, { auth: 'codex-oauth' })
    assert.equal(cfg.models['gpt-5-codex'].schema, 'openai-auth')
  })

  it('supports heterogeneous module models across schemas', () => {
    writeConfig({
      endpoints: {
        anth: { apiKey: 'sk-ant' },
        oai: { apiKey: 'sk-oai' },
      },
      models: {
        sonnet: {
          endpoint: 'anth',
          schema: 'anthropic',
          upstreamModel: 'claude-sonnet-4-6',
        },
        'gpt-mini': {
          endpoint: 'oai',
          schema: 'openai',
          upstreamModel: 'gpt-5-mini',
        },
      },
      defaultModel: 'sonnet',
      tools: { compact: { model: 'gpt-mini' } },
    })
    const cfg = getConfig()
    assert.equal(cfg.defaultModel, 'sonnet')
    assert.equal(cfg.tools.compact.model, 'gpt-mini')
    assert.equal(cfg.models.sonnet.schema, 'anthropic')
    assert.equal(cfg.models['gpt-mini'].schema, 'openai')
  })

  it('defaults autoDream on with per-user thresholds', () => {
    writeConfig({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: {
        opus: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' },
      },
    })
    const cfg = getConfig()
    assert.deepEqual(cfg.autoDream, {
      enabled: true,
      minHours: 24,
      minSessions: 3,
      scanThrottleMs: 600_000,
      maxTurns: 30,
    })
  })

  it('respects autoDream.enabled=false override', () => {
    writeConfig({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: {
        opus: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' },
      },
      autoDream: { enabled: false },
    })
    const cfg = getConfig()
    assert.equal(cfg.autoDream.enabled, false)
  })

  it('parses autoDream overrides', () => {
    writeConfig({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: {
        opus: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' },
      },
      autoDream: {
        enabled: true,
        minHours: 0.5,
        minSessions: 2,
        scanThrottleMs: 30_000,
        maxTurns: 12,
      },
    })
    const cfg = getConfig()
    assert.deepEqual(cfg.autoDream, {
      enabled: true,
      minHours: 0.5,
      minSessions: 2,
      scanThrottleMs: 30_000,
      maxTurns: 12,
    })
  })

  it('defaults backgroundTask governance config', () => {
    writeConfig({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: {
        opus: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' },
      },
    })
    const cfg = getConfig()
    assert.deepEqual(cfg.backgroundTask, {
      maxConcurrentRunsPerUser: 3,
      startupCatchupIntervalMs: 60_000,
      fireRetryMaxAttempts: 3,
      recurringAutoDisableThreshold: 3,
    })
  })

  it('defaults memoryNudge on with a 20-turn cadence', () => {
    writeConfig({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: {
        opus: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' },
      },
    })
    const cfg = getConfig()
    assert.deepEqual(cfg.memoryNudge, {
      enabled: true,
      everyTurns: 20,
    })
  })

  it('parses memoryNudge overrides', () => {
    writeConfig({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: {
        opus: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' },
      },
      memoryNudge: { enabled: false, everyTurns: 8 },
    })
    const cfg = getConfig()
    assert.deepEqual(cfg.memoryNudge, {
      enabled: false,
      everyTurns: 8,
    })
  })

  it('defaults deferred tool loading to always with TTL 20 + cap 30', () => {
    writeConfig({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: { opus: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' } },
    })
    const cfg = getConfig()
    // Phase 31 flipped the default to 'always' to keep the inline catalog
    // tight (only alwaysLoad-tagged tools inline) regardless of total tool
    // count. The threshold field still exists for operators who switch
    // back to 'auto'.
    assert.equal(cfg.tools.deferredLoading, 'always')
    assert.equal(cfg.tools.deferredLoadingThreshold, 30)
    assert.equal(cfg.tools.discoveredToolsMaxSize, 30)
    assert.equal(cfg.tools.discoveredToolsTtlTurns, 20)
  })

  it('parses deferred tool loading overrides from config', () => {
    writeConfig({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: { opus: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' } },
      tools: {
        deferredLoading: 'always',
        deferredLoadingThreshold: 7,
      },
    })
    const cfg = getConfig()
    assert.equal(cfg.tools.deferredLoading, 'always')
    assert.equal(cfg.tools.deferredLoadingThreshold, 7)
  })

  it('parses backgroundTask overrides', () => {
    writeConfig({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: {
        opus: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' },
      },
      backgroundTask: {
        maxConcurrentRunsPerUser: 2,
        startupCatchupIntervalMs: 5000,
        fireRetryMaxAttempts: 5,
        recurringAutoDisableThreshold: 4,
      },
    })
    const cfg = getConfig()
    assert.deepEqual(cfg.backgroundTask, {
      maxConcurrentRunsPerUser: 2,
      startupCatchupIntervalMs: 5000,
      fireRetryMaxAttempts: 5,
      recurringAutoDisableThreshold: 4,
    })
  })
})

describe('config: runtime.docker.security', () => {
  it('uses the OpenClaw-style hardening defaults when section is omitted', () => {
    writeConfig({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: {
        opus: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' },
      },
    })
    const cfg = getConfig()
    assert.deepEqual(cfg.runtime.docker.security, {
      capDrop: ['ALL'],
      capAdd: ['DAC_OVERRIDE', 'CHOWN', 'SETUID', 'SETGID'],
      noNewPrivileges: true,
      readOnlyRootfs: false,
      pidsLimit: 512,
      ulimits: { nofile: '4096:8192', nproc: '1024:2048' },
      tmpfsOptions: 'rw,nosuid,size=512m',
      storageOptSize: '32g',
      workspaceQuotaMb: 524288,
    })
  })

  it('applies admin overrides + null pidsLimit + readOnlyRootfs opt-in', () => {
    writeConfig({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: {
        opus: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' },
      },
      runtime: {
        docker: {
          security: {
            capAdd: ['DAC_OVERRIDE', 'CHOWN'],
            readOnlyRootfs: true,
            pidsLimit: null,
            ulimits: { nofile: '8192:16384' },
            tmpfsOptions: 'rw,size=1g',
            storageOptSize: '64g',
            workspaceQuotaMb: 10485760,
          },
        },
      },
    })
    const cfg = getConfig()
    assert.deepEqual(cfg.runtime.docker.security, {
      capDrop: ['ALL'],
      capAdd: ['DAC_OVERRIDE', 'CHOWN'],
      noNewPrivileges: true,
      readOnlyRootfs: true,
      pidsLimit: null,
      ulimits: { nofile: '8192:16384' },
      tmpfsOptions: 'rw,size=1g',
      storageOptSize: '64g',
      workspaceQuotaMb: 10485760,
    })
  })

  it('disables disk quotas when admin sets them to null / 0', () => {
    writeConfig({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: {
        opus: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' },
      },
      runtime: {
        docker: {
          security: {
            storageOptSize: null,
            workspaceQuotaMb: 0,
          },
        },
      },
    })
    const cfg = getConfig()
    assert.equal(cfg.runtime.docker.security.storageOptSize, null)
    assert.equal(cfg.runtime.docker.security.workspaceQuotaMb, null)
  })

  it('rejects invalid security values', () => {
    writeConfig({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: {
        opus: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' },
      },
      runtime: {
        docker: {
          security: { pidsLimit: -1 },
        },
      },
    })
    assert.throws(() => getConfig(), /pidsLimit must be a positive number or null/)
  })

  it('rejects malformed storageOptSize', () => {
    writeConfig({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: {
        opus: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' },
      },
      runtime: {
        docker: {
          security: { storageOptSize: '32 gigs' },
        },
      },
    })
    assert.throws(() => getConfig(), /storageOptSize must look like a docker size/)
  })

  it('rejects negative workspaceQuotaMb', () => {
    writeConfig({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: {
        opus: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' },
      },
      runtime: {
        docker: {
          security: { workspaceQuotaMb: -1 },
        },
      },
    })
    assert.throws(() => getConfig(), /workspaceQuotaMb must be a non-negative number/)
  })
})
