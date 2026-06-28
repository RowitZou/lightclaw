import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { LightClawConfig } from '../config.js'
import { setLang } from '../i18n/index.js'
import { setLightclawHomeOverride } from '../paths.js'
import { loadUserRlaunchMounts } from '../runtime/rlaunch-mounts.js'
import type { MountReport } from '../runtime/mount-authz.js'
import { runMountCommand } from './mount.js'

// Usage fallbacks now return null (the /system mount card renders them); these
// runner unit tests only exercise real add/rm/list results, so coerce to string.
const runMount = async (
  args: string,
  ctx: Parameters<typeof runMountCommand>[1],
  deps?: Parameters<typeof runMountCommand>[2],
): Promise<string> => (await runMountCommand(args, ctx, deps)) ?? ''

const emptyReport: MountReport = { unmountable: [] }

// The mode a mount lands at is the cluster's observed ro/rw for the service
// identity, which daemon-side we predict via access(W_OK) on the real dir. A
// dir created normally is writable → 'rw'; a 0o555 dir is read-only → 'ro'.
// Skip the ro assertion when the test runs as root (W_OK always succeeds).
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

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
        return { worker: `worker-${restartCount}`, report: emptyReport }
      },
    }

    assert.match(
      await runMount('list', { config: makeConfig(), userId: 'alice' }, deps),
      /You have no mounted paths yet/,
    )

    // A writable dir is observed read-write.
    const added = await runMount(`add ${dataPath}`, { config: makeConfig(), userId: 'alice' }, deps)
    assert.match(added, /Mounted:/)
    assert.match(added, /mode: rw/)
    assert.match(added, /Applied to the Agent; no restart required/)
    assert.deepEqual(loadUserRlaunchMounts('alice'), [{ path: dataPath, mode: 'rw' }])

    // Re-adding the same path with the same observed mode is a no-op.
    const unchanged = await runMount(`add ${dataPath}`, { config: makeConfig(), userId: 'alice' }, deps)
    assert.match(unchanged, /already exists/)
    assert.equal(restartCount, 1)

    const listed = await runMount('list', { config: makeConfig(), userId: 'alice' }, deps)
    assert.match(
      listed,
      new RegExp(escapeRegExp(`${dataPath} (read-write)`)),
    )

    const removed = await runMount(`remove ${dataPath}`, { config: makeConfig(), userId: 'alice' }, deps)
    assert.match(removed, /Unmounted:/)
    assert.match(removed, /Applied to the Agent; no restart required/)
    assert.deepEqual(loadUserRlaunchMounts('alice'), [])
  })

  it('observes a read-only directory as a read-only mount', async (t) => {
    if (isRoot) {
      t.skip('running as root: access(W_OK) always succeeds, cannot observe ro')
      return
    }
    const roPath = path.join(gpfsRoot, 'readonly-data')
    mkdirSync(roPath, { recursive: true })
    chmodSync(roPath, 0o555)
    const deps = { restartRlaunch: async () => ({ worker: 'worker-1', report: emptyReport }) }

    const added = await runMount(`add ${roPath}`, { config: makeConfig(), userId: 'alice' }, deps)
    assert.match(added, /Mounted:/)
    assert.match(added, /mode: ro/)
    assert.match(added, /Mounted read-only for the Agent/)
    assert.deepEqual(loadUserRlaunchMounts('alice'), [{ path: roPath, mode: 'ro' }])
    // Restore so afterEach rmSync can clean up.
    chmodSync(roPath, 0o755)
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
        return { worker: `worker-${restartCount}`, report: emptyReport }
      },
    }

    // All writable → observed rw.
    const added = await runMount(`add ${dataA} ${dataB}`, { config: makeConfig(), userId: 'alice' }, deps)
    assert.match(added, /Mounted:/)
    assert.match(added, new RegExp(escapeRegExp(`- ${dataA}`)))
    assert.match(added, new RegExp(escapeRegExp(`- ${dataB}`)))
    assert.match(added, /mode: rw/)
    assert.match(added, /Applied to the Agent; no restart required/)
    assert.equal(restartCount, 1)
    assert.deepEqual(loadUserRlaunchMounts('alice'), [
      { path: dataA, mode: 'rw' },
      { path: dataB, mode: 'rw' },
    ])

    // dataC is new (rw); dataA / dataB unchanged → no add/update for them, but
    // dataC is added so a restart fires.
    const addedC = await runMount(`add ${dataC}`, { config: makeConfig(), userId: 'alice' }, deps)
    assert.match(addedC, /Mounted:/)
    assert.match(addedC, /Applied to the Agent; no restart required/)
    assert.equal(restartCount, 2)
    assert.deepEqual(loadUserRlaunchMounts('alice'), [
      { path: dataA, mode: 'rw' },
      { path: dataB, mode: 'rw' },
      { path: dataC, mode: 'rw' },
    ])

    // Re-adding existing paths with the same observed mode is a no-op.
    const unchanged = await runMount(`add ${dataA} ${dataC}`, { config: makeConfig(), userId: 'alice' }, deps)
    assert.match(unchanged, /Mounts already exist/)
    assert.match(unchanged, /No restart needed/)
    assert.equal(restartCount, 2)

    const removed = await runMount(`remove ${dataA} ${dataB}`, { config: makeConfig(), userId: 'alice' }, deps)
    assert.match(removed, /Unmounted:/)
    assert.match(removed, new RegExp(escapeRegExp(`- ${dataA}`)))
    assert.match(removed, new RegExp(escapeRegExp(`- ${dataB}`)))
    assert.match(removed, /Applied to the Agent; no restart required/)
    assert.equal(restartCount, 3)
    assert.deepEqual(loadUserRlaunchMounts('alice'), [{ path: dataC, mode: 'rw' }])
  })

  it('accepts mounts under secondary gpfs mapping rules', async () => {
    const gpfs2Root = path.join(tmpHome, 'gpfs2')
    const publicData = path.join(gpfs2Root, 'gpfs2-shared-public', 'huggingface')
    mkdirSync(publicData, { recursive: true })
    let restartCount = 0
    const deps = {
      restartRlaunch: async () => {
        restartCount += 1
        return { worker: `worker-${restartCount}`, report: emptyReport }
      },
    }

    const added = await runMount(
      `add ${publicData}`,
      { config: makeConfig([{ hostPrefix: gpfs2Root, mountPrefix: 'gpfs://gpfs2' }]), userId: 'alice' },
      deps,
    )
    assert.match(added, /Mounted:/)
    assert.match(added, /Applied to the Agent; no restart required/)
    assert.deepEqual(loadUserRlaunchMounts('alice'), [{ path: publicData, mode: 'rw' }])
  })

  it('auto-detects a daemon-inaccessible path as a read-only worker-only mount', async () => {
    const workerOnlyPath = '/remote-team/not-mounted-on-daemon/dataset'
    const added = await runMount(
      `add ${workerOnlyPath}`,
      { config: makeConfig(), userId: 'alice' },
      { restartRlaunch: async () => ({ worker: 'worker-worker-only', report: emptyReport }) },
    )
    assert.match(added, /Mounted:/)
    assert.match(added, /mode: ro/)
    assert.deepEqual(loadUserRlaunchMounts('alice'), [{
      path: workerOnlyPath,
      mode: 'ro',
      scope: 'worker-only',
    }])
  })

  it('rejects non-rlaunch backends, workspace-overlapping mounts, and bad flags', async () => {
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
      await runMount(`add ${workspaceRoot}`, { config: makeConfig(), userId: 'alice' }),
      /Overlapping runtime mount entries/,
    )
    // Mode is never user-selected now, so any flag is unknown.
    assert.match(
      await runMount(`add ${dataPath} --nope`, { config: makeConfig(), userId: 'alice' }),
      /unknown flag: --nope/,
    )
    assert.match(
      await runMount(`add ${dataPath} --ro`, { config: makeConfig(), userId: 'alice' }),
      /unknown flag: --ro/,
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
