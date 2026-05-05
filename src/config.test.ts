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
})
