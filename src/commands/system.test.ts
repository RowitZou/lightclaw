import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { LightClawConfig } from '../config.js'
import { setLang } from '../i18n/index.js'
import { setLightclawHomeOverride } from '../paths.js'
import { loadUserSecrets } from '../secrets/store.js'
import { loadUserRlaunchMounts } from '../runtime/rlaunch-mounts.js'
import { createBuiltinReplRegistry } from './builtin.js'
import { runSystemCommand } from './system.js'

let tmpHome = ''
let gpfsRoot = ''
let workspaceRoot = ''
let oldWorkspaceRoot: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-system-command-'))
  gpfsRoot = path.join(tmpHome, 'gpfs')
  workspaceRoot = path.join(gpfsRoot, 'workspaces')
  mkdirSync(path.join(workspaceRoot, 'alice'), { recursive: true })
  setLightclawHomeOverride(tmpHome)
  oldWorkspaceRoot = process.env.LIGHTCLAW_WORKSPACE_ROOT
  process.env.LIGHTCLAW_WORKSPACE_ROOT = workspaceRoot
  setLang('en')
})

afterEach(() => {
  setLang('cn')
  setLightclawHomeOverride(undefined)
  if (oldWorkspaceRoot === undefined) {
    delete process.env.LIGHTCLAW_WORKSPACE_ROOT
  } else {
    process.env.LIGHTCLAW_WORKSPACE_ROOT = oldWorkspaceRoot
  }
  rmSync(tmpHome, { recursive: true, force: true })
})

// Minimal cluster config so the mount runner reaches its list / remove paths
// (mirrors mount.test.ts:makeConfig). `key` delegation does not read config.
function makeConfig(): LightClawConfig {
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

describe('/system command', () => {
  it('routes `key set` to the real secret runner and persists the value', async () => {
    const value = 'ghp_real_value_$with"chars and spaces'
    const out = await runSystemCommand(`key set GH_TOKEN ${value}`, {
      config: makeConfig(),
      userId: 'alice',
    })
    assert.match(out, /Secret GH_TOKEN saved/)
    // Persisted via the real secret store, proving /system reached the runner.
    assert.equal(loadUserSecrets('alice').GH_TOKEN.value, value)
  })

  it('routes `key` (bare) to the secret list path and `key rm` to removal', async () => {
    await runSystemCommand('key set API val', { config: makeConfig(), userId: 'alice' })
    assert.match(
      await runSystemCommand('key', { config: makeConfig(), userId: 'alice' }),
      /API enabled=no/,
    )
    assert.match(
      await runSystemCommand('key rm API', { config: makeConfig(), userId: 'alice' }),
      /removed/,
    )
    assert.equal('API' in loadUserSecrets('alice'), false)
  })

  it('routes `mount` to the mount runner (bare → usage, list → empty-list)', async () => {
    // Bare reaches the mount runner — its no-arg branch prints the /mount
    // usage (proves delegation, mirrors how bare /mount behaves today).
    assert.match(
      await runSystemCommand('mount', { config: makeConfig(), userId: 'alice' }),
      /\/mount list/,
    )
    // `mount list` hits the actual list path.
    assert.match(
      await runSystemCommand('mount list', { config: makeConfig(), userId: 'alice' }),
      /No dynamic rlaunch mounts/,
    )
  })

  it('routes `mount rm <path>` to the mount remove path', async () => {
    const dataPath = path.join(gpfsRoot, 'datasets')
    mkdirSync(dataPath, { recursive: true })
    const deps = { restartRlaunch: async () => 'worker-1' }
    await runSystemCommand(`mount add ${dataPath}`, { config: makeConfig(), userId: 'alice' }, deps)
    assert.deepEqual(loadUserRlaunchMounts('alice'), [{ path: dataPath, mode: 'ro' }])

    const removed = await runSystemCommand(
      `mount rm ${dataPath}`,
      { config: makeConfig(), userId: 'alice' },
      deps,
    )
    assert.match(removed, /Removed rlaunch mount/)
    assert.deepEqual(loadUserRlaunchMounts('alice'), [])
  })

  it('prints the hub overview for bare and unknown nouns without side effects', async () => {
    const bare = await runSystemCommand('', { config: makeConfig(), userId: 'alice' })
    assert.match(bare, /Usage: \/system <noun>/)
    assert.match(bare, /key/)
    assert.match(bare, /mount/)
    assert.match(bare, /data/)

    const unknown = await runSystemCommand('bogus verb', { config: makeConfig(), userId: 'alice' })
    assert.match(unknown, /Usage: \/system <noun>/)
  })

  it('prints data usage and a coming-soon notice without destructive action', async () => {
    assert.match(
      await runSystemCommand('data', { config: makeConfig(), userId: 'alice' }),
      /Usage: \/system data import/,
    )
    assert.match(
      await runSystemCommand('data import /some/path', { config: makeConfig(), userId: 'alice' }),
      /not yet available/,
    )
    assert.match(
      await runSystemCommand('data export /some/dest', { config: makeConfig(), userId: 'alice' }),
      /not yet available/,
    )
  })

  it('registers /system as channel-only (hidden from the terminal console)', () => {
    const channelRegistry = createBuiltinReplRegistry({ includeChannelOnly: true })
    const terminalRegistry = createBuiltinReplRegistry({ includeChannelOnly: false })

    const command = channelRegistry.find('/system')
    assert.ok(command)
    assert.equal(command.channelOnly, true)
    assert.match(command.agentUsage ?? '', /\/system key set <NAME>/)
    assert.equal(terminalRegistry.find('/system'), undefined)
  })
})
