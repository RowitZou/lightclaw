import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { LightClawConfig } from '../config.js'
import { setLang } from '../i18n/index.js'
import { setLightclawHomeOverride } from '../paths.js'
import { loadUserRlaunchMounts } from '../runtime/rlaunch-mounts.js'
import { runMountCommand } from './mount.js'

// Usage fallbacks now return null (the /system mount card renders them); these
// runner unit tests only exercise real add/rm/list results, so coerce to string.
const runMount = async (
  args: string,
  ctx: Parameters<typeof runMountCommand>[1],
  deps?: Parameters<typeof runMountCommand>[2],
): Promise<string> => (await runMountCommand(args, ctx, deps)) ?? ''

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
      await runMount('list', { config: makeConfig(), userId: 'alice' }, deps),
      /You have no mounted paths yet/,
    )

    const added = await runMount(`add ${dataPath}`, { config: makeConfig(), userId: 'alice' }, deps)
    assert.match(added, /Mounted:/)
    assert.match(added, /mode: ro/)
    assert.match(added, /Sandbox restarted/)
    assert.deepEqual(loadUserRlaunchMounts('alice'), [{ path: dataPath, mode: 'ro' }])

    const unchanged = await runMount(`add ${dataPath} --ro`, { config: makeConfig(), userId: 'alice' }, deps)
    assert.match(unchanged, /already exists/)
    assert.equal(restartCount, 1)

    const updated = await runMount(`add ${dataPath} --rw`, { config: makeConfig(), userId: 'alice' }, deps)
    assert.match(updated, /Updated mount:/)
    assert.match(updated, /Sandbox restarted/)
    assert.deepEqual(loadUserRlaunchMounts('alice'), [{ path: dataPath, mode: 'rw' }])

    const listed = await runMount('list', { config: makeConfig(), userId: 'alice' }, deps)
    assert.match(
      listed,
      new RegExp(escapeRegExp(`${dataPath} (read-write)`)),
    )

    const removed = await runMount(`remove ${dataPath}`, { config: makeConfig(), userId: 'alice' }, deps)
    assert.match(removed, /Unmounted:/)
    assert.match(removed, /Sandbox restarted/)
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

    const added = await runMount(`add ${dataA} ${dataB} --rw`, { config: makeConfig(), userId: 'alice' }, deps)
    assert.match(added, /Mounted:/)
    assert.match(added, new RegExp(escapeRegExp(`- ${dataA}`)))
    assert.match(added, new RegExp(escapeRegExp(`- ${dataB}`)))
    assert.match(added, /mode: rw/)
    assert.match(added, /Sandbox restarted/)
    assert.equal(restartCount, 1)
    assert.deepEqual(loadUserRlaunchMounts('alice'), [
      { path: dataA, mode: 'rw' },
      { path: dataB, mode: 'rw' },
    ])

    const updated = await runMount(`add ${dataA} ${dataC} --ro`, { config: makeConfig(), userId: 'alice' }, deps)
    assert.match(updated, /Mounted:/)
    assert.match(updated, /Updated mounts:/)
    assert.match(updated, /Sandbox restarted/)
    assert.equal(restartCount, 2)
    assert.deepEqual(loadUserRlaunchMounts('alice'), [
      { path: dataA, mode: 'ro' },
      { path: dataB, mode: 'rw' },
      { path: dataC, mode: 'ro' },
    ])

    const unchanged = await runMount(`add ${dataA} ${dataC} --ro`, { config: makeConfig(), userId: 'alice' }, deps)
    assert.match(unchanged, /Mounts already exist/)
    assert.match(unchanged, /No restart needed/)
    assert.equal(restartCount, 2)

    const removed = await runMount(`remove ${dataA} ${dataB}`, { config: makeConfig(), userId: 'alice' }, deps)
    assert.match(removed, /Unmounted:/)
    assert.match(removed, new RegExp(escapeRegExp(`- ${dataA}`)))
    assert.match(removed, new RegExp(escapeRegExp(`- ${dataB}`)))
    assert.match(removed, /Sandbox restarted/)
    assert.equal(restartCount, 3)
    assert.deepEqual(loadUserRlaunchMounts('alice'), [{ path: dataC, mode: 'ro' }])
  })

  it('accepts mounts under secondary gpfs mapping rules', async () => {
    const gpfs2Root = path.join(tmpHome, 'gpfs2')
    const publicData = path.join(gpfs2Root, 'gpfs2-shared-public', 'huggingface')
    mkdirSync(publicData, { recursive: true })
    let restartCount = 0
    const deps = {
      restartRlaunch: async () => {
        restartCount += 1
        return `worker-${restartCount}`
      },
    }

    const added = await runMount(
      `add ${publicData}`,
      { config: makeConfig([{ hostPrefix: gpfs2Root, mountPrefix: 'gpfs://gpfs2' }]), userId: 'alice' },
      deps,
    )
    assert.match(added, /Mounted:/)
    assert.match(added, /Sandbox restarted/)
    assert.deepEqual(loadUserRlaunchMounts('alice'), [{ path: publicData, mode: 'ro' }])
  })

  it('rejects non-rlaunch backends, outside-prefix paths, and workspace-overlapping mounts', async () => {
    const dataPath = path.join(gpfsRoot, 'datasets')
    mkdirSync(dataPath, { recursive: true })

    assert.match(
      await runMount(`add ${dataPath}`, {
        config: { runtime: { backend: 'docker' } } as unknown as LightClawConfig,
        userId: 'alice',
      }),
      /only available/,
    )
    assert.match(
      await runMount('add /tmp/outside', { config: makeConfig(), userId: 'alice' }),
      /gpfsMounts|not accessible/,
    )
    assert.match(
      await runMount(`add ${workspaceRoot}`, { config: makeConfig(), userId: 'alice' }),
      /Overlapping runtime mount entries/,
    )
    assert.match(
      await runMount(`add ${dataPath} --nope`, { config: makeConfig(), userId: 'alice' }),
      /unknown flag: --nope/,
    )
    assert.match(
      await runMount(`add ${dataPath} --ro --rw`, { config: makeConfig(), userId: 'alice' }),
      /mount mode is ambiguous/,
    )
    assert.match(
      await runMount('remove relative/path another-relative', { config: makeConfig(), userId: 'alice' }),
      /must be absolute/,
    )
  })
})

function makeConfig(
  extraGpfsMounts: Array<{ hostPrefix: string; mountPrefix: string }> = [],
): LightClawConfig {
  return {
    runtime: {
      driver: 'brainpp',
      backend: 'cluster',
      clusterSettings: {
        gpfsMounts: [
          { hostPrefix: gpfsRoot, mountPrefix: 'gpfs://gpfs1' },
          ...extraGpfsMounts,
        ],
      },
    },
  } as unknown as LightClawConfig
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
