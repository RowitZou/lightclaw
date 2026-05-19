import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { LightClawConfig } from '../config.js'
import { setLightclawHomeOverride } from '../paths.js'
import { loadUserRlaunchMounts } from '../runtime/rlaunch-mounts.js'
import { runMountCommand } from './mount.js'

let tmpHome = ''
let gpfsRoot = ''
let workspaceRoot = ''
let oldWorkspaceRoot: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-mount-command-'))
  gpfsRoot = path.join(tmpHome, 'gpfs')
  workspaceRoot = path.join(gpfsRoot, 'workspaces')
  mkdirSync(path.join(workspaceRoot, 'alice'), { recursive: true })
  setLightclawHomeOverride(tmpHome)
  oldWorkspaceRoot = process.env.LIGHTCLAW_WORKSPACE_ROOT
  process.env.LIGHTCLAW_WORKSPACE_ROOT = workspaceRoot
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  if (oldWorkspaceRoot === undefined) {
    delete process.env.LIGHTCLAW_WORKSPACE_ROOT
  } else {
    process.env.LIGHTCLAW_WORKSPACE_ROOT = oldWorkspaceRoot
  }
  rmSync(tmpHome, { recursive: true, force: true })
})

describe('/mount command', () => {
  it('lists, adds, updates, and removes per-user rlaunch mounts', async () => {
    const dataPath = path.join(gpfsRoot, 'datasets')
    mkdirSync(dataPath, { recursive: true })
    let restartCount = 0
    const deps = {
      restartRlaunch: async () => {
        restartCount += 1
        return `worker-${restartCount}`
      },
    }

    assert.match(
      await runMountCommand('list', { config: makeConfig(), userId: 'alice' }, deps),
      /No dynamic rlaunch mounts/,
    )

    const added = await runMountCommand(`add ${dataPath}`, { config: makeConfig(), userId: 'alice' }, deps)
    assert.match(added, /Added rlaunch mount/)
    assert.match(added, /mode: ro/)
    assert.match(added, /worker-1/)
    assert.deepEqual(loadUserRlaunchMounts('alice'), [{ path: dataPath, mode: 'ro' }])

    const unchanged = await runMountCommand(`add ${dataPath} --ro`, { config: makeConfig(), userId: 'alice' }, deps)
    assert.match(unchanged, /already exists/)
    assert.equal(restartCount, 1)

    const updated = await runMountCommand(`add ${dataPath} --rw`, { config: makeConfig(), userId: 'alice' }, deps)
    assert.match(updated, /Updated rlaunch mount/)
    assert.match(updated, /worker-2/)
    assert.deepEqual(loadUserRlaunchMounts('alice'), [{ path: dataPath, mode: 'rw' }])

    const listed = await runMountCommand('list', { config: makeConfig(), userId: 'alice' }, deps)
    assert.match(
      listed,
      new RegExp(escapeRegExp(`${dataPath}  lightclaw=read-write  worker=${dataPath}`)),
    )

    const removed = await runMountCommand(`remove ${dataPath}`, { config: makeConfig(), userId: 'alice' }, deps)
    assert.match(removed, /Removed rlaunch mount/)
    assert.match(removed, /worker-3/)
    assert.deepEqual(loadUserRlaunchMounts('alice'), [])
  })

  it('adds and removes multiple mounts with a single restart', async () => {
    const dataA = path.join(gpfsRoot, 'datasets-a')
    const dataB = path.join(gpfsRoot, 'datasets-b')
    const dataC = path.join(gpfsRoot, 'datasets-c')
    mkdirSync(dataA, { recursive: true })
    mkdirSync(dataB, { recursive: true })
    mkdirSync(dataC, { recursive: true })
    let restartCount = 0
    const deps = {
      restartRlaunch: async () => {
        restartCount += 1
        return `worker-${restartCount}`
      },
    }

    const added = await runMountCommand(`add ${dataA} ${dataB} --rw`, { config: makeConfig(), userId: 'alice' }, deps)
    assert.match(added, /Added rlaunch mounts/)
    assert.match(added, new RegExp(escapeRegExp(`- ${dataA}`)))
    assert.match(added, new RegExp(escapeRegExp(`- ${dataB}`)))
    assert.match(added, /mode: rw/)
    assert.match(added, /worker-1/)
    assert.equal(restartCount, 1)
    assert.deepEqual(loadUserRlaunchMounts('alice'), [
      { path: dataA, mode: 'rw' },
      { path: dataB, mode: 'rw' },
    ])

    const updated = await runMountCommand(`add ${dataA} ${dataC} --ro`, { config: makeConfig(), userId: 'alice' }, deps)
    assert.match(updated, /Added rlaunch mounts/)
    assert.match(updated, /Updated rlaunch mounts/)
    assert.match(updated, /worker-2/)
    assert.equal(restartCount, 2)
    assert.deepEqual(loadUserRlaunchMounts('alice'), [
      { path: dataA, mode: 'ro' },
      { path: dataB, mode: 'rw' },
      { path: dataC, mode: 'ro' },
    ])

    const unchanged = await runMountCommand(`add ${dataA} ${dataC} --ro`, { config: makeConfig(), userId: 'alice' }, deps)
    assert.match(unchanged, /Mounts already exist/)
    assert.match(unchanged, /No restart needed/)
    assert.equal(restartCount, 2)

    const removed = await runMountCommand(`remove ${dataA} ${dataB}`, { config: makeConfig(), userId: 'alice' }, deps)
    assert.match(removed, /Removed rlaunch mounts/)
    assert.match(removed, new RegExp(escapeRegExp(`- ${dataA}`)))
    assert.match(removed, new RegExp(escapeRegExp(`- ${dataB}`)))
    assert.match(removed, /worker-3/)
    assert.equal(restartCount, 3)
    assert.deepEqual(loadUserRlaunchMounts('alice'), [{ path: dataC, mode: 'ro' }])
  })

  it('rejects non-rlaunch backends, outside-prefix paths, and workspace-overlapping mounts', async () => {
    const dataPath = path.join(gpfsRoot, 'datasets')
    mkdirSync(dataPath, { recursive: true })

    assert.match(
      await runMountCommand(`add ${dataPath}`, {
        config: { runtime: { backend: 'docker' } } as unknown as LightClawConfig,
        userId: 'alice',
      }),
      /only available/,
    )
    assert.match(
      await runMountCommand('add /tmp/outside', { config: makeConfig(), userId: 'alice' }),
      /gpfsHostPrefix|not accessible/,
    )
    assert.match(
      await runMountCommand(`add ${workspaceRoot}`, { config: makeConfig(), userId: 'alice' }),
      /Overlapping runtime mount entries/,
    )
    assert.match(
      await runMountCommand(`add ${dataPath} --nope`, { config: makeConfig(), userId: 'alice' }),
      /unknown flag: --nope/,
    )
    assert.match(
      await runMountCommand(`add ${dataPath} --ro --rw`, { config: makeConfig(), userId: 'alice' }),
      /mount mode is ambiguous/,
    )
    assert.match(
      await runMountCommand('remove relative/path another-relative', { config: makeConfig(), userId: 'alice' }),
      /must be absolute/,
    )
  })
})

function makeConfig(): LightClawConfig {
  return {
    runtime: {
      backend: 'rlaunch',
      rlaunch: {
        gpfsHostPrefix: gpfsRoot,
        gpfsMountPrefix: 'gpfs://gpfs1',
      },
    },
  } as unknown as LightClawConfig
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
