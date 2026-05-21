import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import {
  clampPermissionModeToCeiling,
  isHomeConfigPath,
  readExternalConfigFile,
  resolveStartupHome,
  syncExternalConfig,
} from './config-bootstrap.js'
import { setLightclawHomeOverride } from './paths.js'

let tmpRoot = ''
const ENV_KEYS = [
  'LIGHTCLAW_HOME',
  'LIGHTCLAW_PERMISSION_MODE',
  'LIGHTCLAW_PERMISSION_CEILING',
] as const
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'lightclaw-config-bootstrap-'))
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = savedEnv[key]
    }
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

describe('clampPermissionModeToCeiling', () => {
  it('rewrites home config when permissionMode exceeds permissionCeiling', () => {
    const home = path.join(tmpRoot, 'home')
    setLightclawHomeOverride(home)
    syncExternalConfig({ permissionMode: 'yolo', permissionCeiling: 'auto' }, home)
    const writes = captureStderr(() => {
      assert.equal(clampPermissionModeToCeiling(), true)
    })
    assert.equal((readJson(path.join(home, 'config.json')) as Record<string, unknown>).permissionMode, 'acceptEdits')
    assert.match(writes.join(''), /clamped home config to auto/)
  })

  it('does not rewrite when mode is within ceiling or fields are absent', () => {
    const home = path.join(tmpRoot, 'home')
    setLightclawHomeOverride(home)
    syncExternalConfig({ permissionMode: 'ask', permissionCeiling: 'auto' }, home)
    assert.equal(clampPermissionModeToCeiling(), false)
    assert.equal((readJson(path.join(home, 'config.json')) as Record<string, unknown>).permissionMode, 'ask')

    const otherHome = path.join(tmpRoot, 'other-home')
    setLightclawHomeOverride(otherHome)
    syncExternalConfig({}, otherHome)
    assert.equal(clampPermissionModeToCeiling(), false)
  })

  it('reconciles the config file only and ignores env overrides', () => {
    const home = path.join(tmpRoot, 'home')
    setLightclawHomeOverride(home)
    // File is self-consistent (ask <= yolo). An env override above the file
    // ceiling must NOT trigger a rewrite: getConfig() applies env on top of
    // the file anyway, so clamping the file from env would churn config.json
    // every boot for no effect.
    syncExternalConfig({ permissionMode: 'ask', permissionCeiling: 'yolo' }, home)
    process.env.LIGHTCLAW_PERMISSION_MODE = 'bypassPermissions'
    process.env.LIGHTCLAW_PERMISSION_CEILING = 'default'
    assert.equal(clampPermissionModeToCeiling(), false)
    assert.equal((readJson(path.join(home, 'config.json')) as Record<string, unknown>).permissionMode, 'ask')
  })
})

function readJson(file: string): unknown {
  assert.equal(existsSync(file), true)
  return JSON.parse(readFileSync(file, 'utf8')) as unknown
}

function captureStderr(fn: () => void): string[] {
  const original = process.stderr.write
  const writes: string[] = []
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    fn()
  } finally {
    process.stderr.write = original
  }
  return writes
}
