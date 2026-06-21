import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { LightClawConfig } from '../config.js'
import { setLang } from '../i18n/index.js'
import { userConfigPath } from '../identity/paths.js'
import { setLightclawHomeOverride } from '../paths.js'
import { runConfigCommand, validateWorkspacePath } from './config.js'

let tmpHome = ''
let gpfsRoot = ''

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-config-command-'))
  gpfsRoot = path.join(tmpHome, 'gpfs')
  mkdirSync(gpfsRoot, { recursive: true })
  setLightclawHomeOverride(tmpHome)
  setLang('en')
})

afterEach(() => {
  setLang('cn')
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
})

describe('validateWorkspacePath', () => {
  it('passes for a real directory on a non-cluster (local) backend', async () => {
    const dir = path.join(tmpHome, 'local-ws')
    mkdirSync(dir, { recursive: true })
    assert.equal(await validateWorkspacePath(dir, localConfig()), null)
  })

  it('rejects a non-existent path', async () => {
    const result = await validateWorkspacePath(path.join(tmpHome, 'does-not-exist'), localConfig())
    assert.ok(result)
    assert.match(result!, /cannot access/)
  })

  it('rejects a path outside the gpfs prefix on a cluster backend', async () => {
    const outside = path.join(tmpHome, 'not-gpfs')
    mkdirSync(outside, { recursive: true })
    const result = await validateWorkspacePath(outside, clusterConfig())
    assert.ok(result)
    assert.match(result!, /gpfs host prefix/)
  })

  it('passes for a directory under the gpfs prefix on a cluster backend', async () => {
    const inside = path.join(gpfsRoot, 'collab')
    mkdirSync(inside, { recursive: true })
    assert.equal(await validateWorkspacePath(inside, clusterConfig()), null)
  })
})

describe('/config set-workspace', () => {
  it('writes .workspace into users/<u>/config.json and echoes entry count', async () => {
    const ws = path.join(gpfsRoot, 'shared')
    mkdirSync(path.join(ws, 'a'), { recursive: true })
    mkdirSync(path.join(ws, 'b'), { recursive: true })

    const out = await runConfigCommand(`set-workspace ${ws}`, { config: clusterConfig(), userId: 'alice' })
    assert.match(out, /Workspace directory set to/)
    assert.match(out, /contains 2 entries/)
    assert.match(out, /restart/)

    const persisted = JSON.parse(readFileSync(userConfigPath('alice'), 'utf8'))
    assert.equal(persisted.workspace, ws)
  })

  it('reports an empty workspace directory', async () => {
    const ws = path.join(gpfsRoot, 'empty')
    mkdirSync(ws, { recursive: true })
    const out = await runConfigCommand(`set-workspace ${ws}`, { config: clusterConfig(), userId: 'bob' })
    assert.match(out, /is currently empty/)
    assert.equal(JSON.parse(readFileSync(userConfigPath('bob'), 'utf8')).workspace, ws)
  })

  it('rejects an invalid path with a reason and does NOT write the file', async () => {
    const out = await runConfigCommand(
      `set-workspace ${path.join(tmpHome, 'no-such-dir')}`,
      { config: clusterConfig(), userId: 'carol' },
    )
    assert.match(out, /gpfs host prefix|cannot access/)
    assert.equal(existsSync(userConfigPath('carol')), false)
  })

  it('rejects a relative path', async () => {
    const out = await runConfigCommand('set-workspace ./relative', { config: localConfig(), userId: 'dave' })
    assert.match(out, /must be an absolute path/)
    assert.equal(existsSync(userConfigPath('dave')), false)
  })

  it('preserves unrelated keys when writing .workspace', async () => {
    const ws = path.join(gpfsRoot, 'keep')
    mkdirSync(ws, { recursive: true })
    // Pre-seed config.json with an unrelated key the writer must round-trip.
    mkdirSync(path.dirname(userConfigPath('erin')), { recursive: true })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(userConfigPath('erin'), JSON.stringify({ keepMe: 42 }), 'utf8')

    await runConfigCommand(`set-workspace ${ws}`, { config: clusterConfig(), userId: 'erin' })
    const persisted = JSON.parse(readFileSync(userConfigPath('erin'), 'utf8'))
    assert.equal(persisted.keepMe, 42)
    assert.equal(persisted.workspace, ws)
  })

  it('removes the .workspace key on reset', async () => {
    const ws = path.join(gpfsRoot, 'reset-me')
    mkdirSync(ws, { recursive: true })
    await runConfigCommand(`set-workspace ${ws}`, { config: clusterConfig(), userId: 'frank' })
    assert.ok('workspace' in JSON.parse(readFileSync(userConfigPath('frank'), 'utf8')))

    const out = await runConfigCommand('set-workspace reset', { config: clusterConfig(), userId: 'frank' })
    assert.match(out, /restored to the default/)
    assert.equal('workspace' in JSON.parse(readFileSync(userConfigPath('frank'), 'utf8')), false)
  })

  it('requires an identity', async () => {
    const out = await runConfigCommand('set-workspace /tmp/x', { config: localConfig() })
    assert.match(out, /No active LightClaw identity/)
  })

  it('prints usage for no args / unknown subcommand', async () => {
    assert.match(await runConfigCommand('', { config: localConfig(), userId: 'alice' }), /set-workspace/)
    assert.match(await runConfigCommand('bogus', { config: localConfig(), userId: 'alice' }), /set-workspace/)
  })
})

function localConfig(): LightClawConfig {
  return { runtime: { backend: 'local' } } as unknown as LightClawConfig
}

function clusterConfig(): LightClawConfig {
  return {
    runtime: {
      driver: 'brainpp',
      backend: 'cluster',
      clusterSettings: {
        gpfsMounts: [{ hostPrefix: gpfsRoot, mountPrefix: 'gpfs://gpfs1' }],
      },
    },
  } as unknown as LightClawConfig
}
