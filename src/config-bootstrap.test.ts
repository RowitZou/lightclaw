import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import {
  isHomeConfigPath,
  readExternalConfigFile,
  resolveStartupHome,
  syncExternalConfig,
} from './config-bootstrap.js'
import { setLightclawHomeOverride } from './paths.js'

let tmpRoot = ''
const savedHome = process.env.LIGHTCLAW_HOME

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'lightclaw-config-bootstrap-'))
  delete process.env.LIGHTCLAW_HOME
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  if (savedHome === undefined) {
    delete process.env.LIGHTCLAW_HOME
  } else {
    process.env.LIGHTCLAW_HOME = savedHome
  }
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('readExternalConfigFile', () => {
  it('reads a JSON object and rejects missing or non-object files', () => {
    const file = path.join(tmpRoot, 'external.json')
    writeFileSync(file, JSON.stringify({ defaultModel: 'sonnet' }))
    assert.deepEqual(readExternalConfigFile(file), { defaultModel: 'sonnet' })
    assert.throws(() => readExternalConfigFile(path.join(tmpRoot, 'missing.json')), /External config not found/)
    writeFileSync(file, JSON.stringify([]))
    assert.throws(() => readExternalConfigFile(file), /not a JSON object/)
  })
})

describe('resolveStartupHome', () => {
  it('uses flag, env, external home, then default in order', () => {
    process.env.LIGHTCLAW_HOME = path.join(tmpRoot, 'env-home')
    assert.equal(
      resolveStartupHome({ homeFlag: path.join(tmpRoot, 'flag-home'), externalHome: path.join(tmpRoot, 'ext-home') }),
      path.join(tmpRoot, 'flag-home'),
    )
    assert.equal(
      resolveStartupHome({ externalHome: path.join(tmpRoot, 'ext-home') }),
      path.join(tmpRoot, 'env-home'),
    )
    delete process.env.LIGHTCLAW_HOME
    assert.equal(
      resolveStartupHome({ externalHome: path.join(tmpRoot, 'ext-home') }),
      path.join(tmpRoot, 'ext-home'),
    )
    assert.match(resolveStartupHome({}), /\/\.lightclaw$/)
  })
})

describe('syncExternalConfig', () => {
  it('creates home config and source snapshot on first sync', () => {
    const home = path.join(tmpRoot, 'home')
    const external = { defaultModel: 'sonnet', endpoints: { anthropic: { apiKey: 'sk' } } }
    syncExternalConfig(external, home)
    assert.deepEqual(readJson(path.join(home, 'config.json')), external)
    assert.deepEqual(readJson(path.join(home, '.config-source.json')), external)
    assert.equal(statSync(path.join(home, 'config.json')).mode & 0o777, 0o600)
  })

  it('propagates external edits and deletions while preserving injected config', () => {
    const home = path.join(tmpRoot, 'home')
    const first = {
      defaultModel: 'sonnet',
      endpoints: { anthropic: { apiKey: 'old' } },
      lang: 'cn',
    }
    syncExternalConfig(first, home)
    writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({
        ...(readJson(path.join(home, 'config.json')) as Record<string, unknown>),
        endpoints: {
          anthropic: { apiKey: 'old' },
          codex: { auth: 'codex-oauth' },
        },
      }),
    )

    const second = {
      defaultModel: 'opus',
      endpoints: { anthropic: { apiKey: 'new' } },
    }
    syncExternalConfig(second, home)
    assert.deepEqual(readJson(path.join(home, 'config.json')), {
      defaultModel: 'opus',
      endpoints: {
        anthropic: { apiKey: 'new' },
        codex: { auth: 'codex-oauth' },
      },
    })
    assert.deepEqual(readJson(path.join(home, '.config-source.json')), second)
  })
})

describe('isHomeConfigPath', () => {
  it('detects when --config points at the resolved home config', () => {
    const home = path.join(tmpRoot, 'home')
    setLightclawHomeOverride(home)
    assert.equal(isHomeConfigPath(path.join(home, 'config.json')), true)
    assert.equal(isHomeConfigPath(path.join(tmpRoot, 'external.json')), false)
  })
})

function readJson(file: string): unknown {
  assert.equal(existsSync(file), true)
  return JSON.parse(readFileSync(file, 'utf8')) as unknown
}
