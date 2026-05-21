import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { getConfig } from './config.js'
import { buildWizardConfig, type WizardAnswers } from './config-wizard.js'
import { setLightclawHomeOverride } from './paths.js'

let tmpHome = ''
const ENV_KEYS = [
  'LIGHTCLAW_DEFAULT_MODEL',
  'LIGHTCLAW_RUNTIME_BACKEND',
  'LIGHTCLAW_PERMISSION_MODE',
] as const
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-config-wizard-'))
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

describe('buildWizardConfig', () => {
  it('builds a valid Anthropic docker config with Feishu disabled', () => {
    const config = buildWizardConfig(baseAnswers())
    writeConfig(config)
    const parsed = getConfig()
    assert.equal(parsed.defaultModel, 'sonnet')
    assert.equal(parsed.models.sonnet.schema, 'anthropic')
    assert.deepEqual(parsed.endpoints.anthropic, { apiKey: 'sk-anthropic' })
    assert.equal(parsed.runtime.backend, 'docker')
    assert.deepEqual(config.channels?.feishu, { enabled: false })
  })

  it('keeps an optional Anthropic base URL', () => {
    const config = buildWizardConfig({
      ...baseAnswers(),
      baseUrl: 'https://example.test',
    })
    writeConfig(config)
    const parsed = getConfig()
    assert.equal(parsed.endpoints.anthropic.baseUrl, 'https://example.test')
  })

  it('builds a valid OpenAI-compatible config keyed by model id', () => {
    const config = buildWizardConfig({
      ...baseAnswers(),
      provider: 'openai-compatible',
      apiKey: 'sk-openai',
      baseUrl: 'https://newapi.example.test',
      modelId: 'gpt-custom',
    })
    writeConfig(config)
    const parsed = getConfig()
    assert.equal(parsed.defaultModel, 'gpt-custom')
    assert.equal(parsed.models['gpt-custom'].schema, 'openai')
    assert.equal(parsed.models['gpt-custom'].upstreamModel, 'gpt-custom')
    assert.deepEqual(parsed.endpoints.default, {
      apiKey: 'sk-openai',
      baseUrl: 'https://newapi.example.test',
    })
  })

  it('builds local runtime and Feishu ws config when requested', () => {
    const config = buildWizardConfig({
      ...baseAnswers(),
      runtime: 'local',
      feishu: { appId: 'cli_app', appSecret: 'cli_secret' },
    })
    writeConfig(config)
    const parsed = getConfig()
    assert.equal(parsed.runtime.backend, 'local')
    assert.deepEqual(config.channels?.feishu, {
      enabled: true,
      transport: 'ws',
      appId: 'cli_app',
      appSecret: 'cli_secret',
    })
  })

  it('rejects OpenAI-compatible answers without baseUrl or modelId', () => {
    assert.throws(
      () => buildWizardConfig({ ...baseAnswers(), provider: 'openai-compatible', modelId: 'gpt-x' }),
      /requires baseUrl/,
    )
    assert.throws(
      () => buildWizardConfig({ ...baseAnswers(), provider: 'openai-compatible', baseUrl: 'https://api.test' }),
      /requires modelId/,
    )
  })
})

function baseAnswers(): WizardAnswers {
  return {
    home: tmpHome,
    provider: 'anthropic',
    apiKey: 'sk-anthropic',
    runtime: 'docker',
  }
}

function writeConfig(body: unknown): void {
  writeFileSync(path.join(tmpHome, 'config.json'), JSON.stringify(body), 'utf8')
}
