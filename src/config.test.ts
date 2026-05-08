import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { getConfig } from './config.js'
import { setLightclawHomeOverride } from './paths.js'

let tmpHome: string

function writeConfig(body: object): void {
  writeFileSync(path.join(tmpHome, 'config.json'), JSON.stringify(body))
}

const ENV_KEYS = [
  'LIGHTCLAW_MODEL',
  'LIGHTCLAW_ROUTING_MAIN',
  'LIGHTCLAW_ROUTING_COMPACT',
  'LIGHTCLAW_ROUTING_EXTRACT',
  'LIGHTCLAW_ROUTING_WEBSEARCH',
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
    assert.equal(cfg.model, 'opus')
    assert.equal(cfg.routing.main, 'opus')
    assert.deepEqual(cfg.endpoints.a, { apiKey: 'sk-a', baseUrl: 'http://a/' })
    assert.equal(cfg.models.opus.upstreamModel, 'claude-opus-4-7')
    assert.equal(cfg.models.opus.schema, 'anthropic')
  })

  it('falls back to the first model name when defaultModel is omitted', () => {
    writeConfig({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: {
        primary: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' },
        secondary: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'y' },
      },
    })
    const cfg = getConfig()
    assert.equal(cfg.model, 'primary')
  })

  it('LIGHTCLAW_MODEL overrides defaultModel', () => {
    writeConfig({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: {
        opus: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' },
        sonnet: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'y' },
      },
      defaultModel: 'opus',
    })
    process.env.LIGHTCLAW_MODEL = 'sonnet'
    const cfg = getConfig()
    assert.equal(cfg.model, 'sonnet')
  })

  it('rejects defaultModel not present in models', () => {
    writeConfig({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: {
        opus: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' },
      },
      defaultModel: 'sonnet',
    })
    assert.throws(() => getConfig(), /Selected model "sonnet" is not in models/)
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

  it('rejects routing targets not present in models', () => {
    writeConfig({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: {
        opus: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' },
      },
      routing: { main: 'opus', extract: 'phantom' },
    })
    assert.throws(
      () => getConfig(),
      /routing\.extract = "phantom" is not in models/,
    )
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
    assert.equal(cfg.routing.main, 'sonnet')
    assert.equal(cfg.routing.extract, 'gpt-5-codex')
    assert.deepEqual(cfg.endpoints.newapi, {
      apiKey: 'sk-a',
      baseUrl: 'http://gw/',
    })
    assert.deepEqual(cfg.endpoints.codex, { auth: 'codex-oauth' })
    assert.equal(cfg.models['gpt-5-codex'].schema, 'openai-auth')
  })

  it('supports heterogeneous routing across schemas', () => {
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
      routing: { main: 'sonnet', extract: 'gpt-mini' },
    })
    const cfg = getConfig()
    assert.equal(cfg.routing.main, 'sonnet')
    assert.equal(cfg.routing.extract, 'gpt-mini')
    assert.equal(cfg.models.sonnet.schema, 'anthropic')
    assert.equal(cfg.models['gpt-mini'].schema, 'openai')
  })

  it('defaults autoDream to dark launch off', () => {
    writeConfig({
      endpoints: { a: { apiKey: 'sk-a' } },
      models: {
        opus: { endpoint: 'a', schema: 'anthropic', upstreamModel: 'x' },
      },
    })
    const cfg = getConfig()
    assert.deepEqual(cfg.autoDream, {
      enabled: false,
      minHours: 24,
      minSessions: 3,
      scanThrottleMs: 600_000,
      maxTurns: 30,
    })
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
