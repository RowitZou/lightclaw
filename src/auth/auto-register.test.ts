import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import {
  autoRegisterCodex,
  purgeCodexFromConfig,
} from './codex/auto-register.js'
import { setLightclawHomeOverride } from '../paths.js'

let tmpHome: string

function configFile(): string {
  return path.join(tmpHome, 'config.json')
}

function readConfig(): Record<string, unknown> {
  if (!existsSync(configFile())) return {}
  return JSON.parse(readFileSync(configFile(), 'utf8')) as Record<string, unknown>
}

function writeConfig(body: object): void {
  writeFileSync(configFile(), JSON.stringify(body))
}

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-autoreg-test-'))
  setLightclawHomeOverride(tmpHome)
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
})

describe('auth/codex/auto-register', () => {
  it('creates endpoint + model when config.json is empty', () => {
    const result = autoRegisterCodex()
    assert.equal(result.endpointAdded, true)
    assert.equal(result.modelAdded, true)
    const cfg = readConfig() as {
      endpoints: Record<string, unknown>
      models: Record<string, unknown>
    }
    assert.deepEqual(cfg.endpoints.codex, { auth: 'codex-oauth' })
    assert.deepEqual(cfg.models['gpt-5-codex'], {
      endpoint: 'codex',
      schema: 'openai-auth',
      upstreamModel: 'gpt-5.5',
    })
  })

  it('preserves unrelated user config', () => {
    writeConfig({
      endpoints: { existing: { apiKey: 'sk-x' } },
      models: { existing: { endpoint: 'existing', schema: 'anthropic', upstreamModel: 'claude' } },
      defaultModel: 'existing',
      lang: 'en',
    })
    autoRegisterCodex()
    const cfg = readConfig() as {
      endpoints: Record<string, unknown>
      models: Record<string, unknown>
      defaultModel: string
      lang: string
    }
    assert.equal(cfg.defaultModel, 'existing')
    assert.equal(cfg.lang, 'en')
    assert.deepEqual(cfg.endpoints.existing, { apiKey: 'sk-x' })
    assert.deepEqual(cfg.endpoints.codex, { auth: 'codex-oauth' })
    assert.ok(cfg.models['gpt-5-codex'])
  })

  it('does not overwrite a pre-existing codex endpoint', () => {
    writeConfig({
      endpoints: {
        codex: { auth: 'codex-oauth', baseUrl: 'http://my-mirror/' },
      },
    })
    const result = autoRegisterCodex()
    assert.equal(result.endpointAdded, false)
    assert.equal(result.endpointPreexisting, true)
    const cfg = readConfig() as {
      endpoints: Record<string, { baseUrl?: string }>
    }
    assert.equal(cfg.endpoints.codex.baseUrl, 'http://my-mirror/')
  })

  it('does not overwrite a pre-existing gpt-5-codex model', () => {
    writeConfig({
      endpoints: { codex: { auth: 'codex-oauth' } },
      models: {
        'gpt-5-codex': {
          endpoint: 'codex',
          schema: 'openai-auth',
          upstreamModel: 'gpt-5.4-codex',
        },
      },
    })
    const result = autoRegisterCodex()
    assert.equal(result.modelAdded, false)
    assert.equal(result.modelPreexisting, true)
    const cfg = readConfig() as {
      models: Record<string, { upstreamModel: string }>
    }
    assert.equal(cfg.models['gpt-5-codex'].upstreamModel, 'gpt-5.4-codex')
  })

  it('is idempotent — second run touches nothing', () => {
    autoRegisterCodex()
    const before = readFileSync(configFile(), 'utf8')
    autoRegisterCodex()
    const after = readFileSync(configFile(), 'utf8')
    assert.equal(before, after)
  })

  it('uses the caller-supplied upstreamModel when provided', () => {
    autoRegisterCodex({ upstreamModel: 'gpt-5.4' })
    const cfg = readConfig() as {
      models: Record<string, { upstreamModel: string }>
    }
    assert.equal(cfg.models['gpt-5-codex'].upstreamModel, 'gpt-5.4')
  })

  it('falls back to the default when upstreamModel is empty / whitespace', () => {
    autoRegisterCodex({ upstreamModel: '   ' })
    const cfg = readConfig() as {
      models: Record<string, { upstreamModel: string }>
    }
    assert.equal(cfg.models['gpt-5-codex'].upstreamModel, 'gpt-5.5')
  })

  it('purgeCodexFromConfig drops endpoint + every model pointing at it', () => {
    writeConfig({
      endpoints: {
        codex: { auth: 'codex-oauth' },
        keep: { apiKey: 'sk-keep' },
      },
      models: {
        'gpt-5-codex': { endpoint: 'codex', schema: 'openai-auth', upstreamModel: 'gpt-5' },
        'gpt-5.4-codex': { endpoint: 'codex', schema: 'openai-auth', upstreamModel: 'gpt-5.4' },
        keep: { endpoint: 'keep', schema: 'anthropic', upstreamModel: 'claude' },
      },
    })
    const result = purgeCodexFromConfig()
    assert.equal(result.endpointRemoved, true)
    assert.deepEqual(result.modelsRemoved.sort(), ['gpt-5-codex', 'gpt-5.4-codex'])
    const cfg = readConfig() as {
      endpoints: Record<string, unknown>
      models: Record<string, unknown>
    }
    assert.equal(cfg.endpoints.codex, undefined)
    assert.deepEqual(cfg.endpoints.keep, { apiKey: 'sk-keep' })
    assert.equal(cfg.models['gpt-5-codex'], undefined)
    assert.ok(cfg.models.keep)
  })

  it('purge is a no-op when nothing codex-related exists', () => {
    writeConfig({
      endpoints: { keep: { apiKey: 'sk-keep' } },
      models: { keep: { endpoint: 'keep', schema: 'openai', upstreamModel: 'gpt' } },
    })
    const result = purgeCodexFromConfig()
    assert.equal(result.endpointRemoved, false)
    assert.equal(result.modelsRemoved.length, 0)
  })

  it('refuses to write when config.json is not a JSON object', () => {
    writeFileSync(configFile(), '"a string"')
    assert.throws(() => autoRegisterCodex(), /not a JSON object/)
  })
})
