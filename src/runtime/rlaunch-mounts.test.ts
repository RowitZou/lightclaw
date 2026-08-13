import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { setLightclawHomeOverride } from '../paths.js'
import {
  applyObservedWorkerModes,
  buildGpfsMountString,
  findWorkspaceMountConflict,
  loadUserRlaunchMounts,
  normalizeRlaunchMountPath,
  probeDaemonMountAccess,
  refreshUserRlaunchMountAccess,
  removeUserRlaunchMount,
  resolveUserRlaunchRuntimeMounts,
  rlaunchMountFingerprint,
  setUserRlaunchMount,
  type UserRlaunchMount,
} from './rlaunch-mounts.js'

let tmpHome = ''
let gpfsRoot = ''

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-rlaunch-mounts-'))
  gpfsRoot = path.join(tmpHome, 'gpfs')
  mkdirSync(gpfsRoot, { recursive: true })
  setLightclawHomeOverride(tmpHome)
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(tmpHome, { recursive: true, force: true })
})

describe('rlaunch dynamic mounts store', () => {
  it('normalizes, persists, updates, and removes per-user mounts', () => {
    const dataPath = path.join(gpfsRoot, 'data')
    const result = setUserRlaunchMount('alice', dataPath, 'ro')
    assert.equal(result.changed, true)
    assert.equal(result.updated, false)
    assert.deepEqual(loadUserRlaunchMounts('alice'), [{ path: dataPath, mode: 'ro' }])

    const updated = setUserRlaunchMount('alice', dataPath, 'rw')
    assert.equal(updated.changed, true)
    assert.equal(updated.updated, true)
    assert.deepEqual(loadUserRlaunchMounts('alice'), [{ path: dataPath, mode: 'rw' }])

    const removed = removeUserRlaunchMount('alice', dataPath)
    assert.equal(removed.removed, true)
    assert.deepEqual(loadUserRlaunchMounts('alice'), [])
  })

  it('builds gpfs mount strings with worker path equal to host path', () => {
    const hostPath = path.join(gpfsRoot, 'datasets')
    const mount = buildGpfsMountString(hostPath, hostPath, {
      gpfsMounts: [{ hostPrefix: gpfsRoot, mountPrefix: 'gpfs://gpfs1' }],
    })
    assert.equal(mount, `gpfs://gpfs1/datasets:${hostPath}`)
  })

  it('rejects paths outside every gpfsMounts rule', () => {
    assert.throws(
      () => buildGpfsMountString('/tmp/outside', '/tmp/outside', {
        gpfsMounts: [{ hostPrefix: gpfsRoot, mountPrefix: 'gpfs://gpfs1' }],
      }),
      /gpfsMounts/,
    )
  })

  it('maps mounts through the longest matching gpfsMounts rule', () => {
    const gpfs2Root = path.join(tmpHome, 'gpfs2')
    const projectRoot = path.join(gpfs2Root, 'projects')
    const hostPath = path.join(projectRoot, 'dataset')
    const mount = buildGpfsMountString(hostPath, hostPath, {
      gpfsMounts: [
        { hostPrefix: gpfsRoot, mountPrefix: 'gpfs://gpfs1' },
        { hostPrefix: gpfs2Root, mountPrefix: 'gpfs://gpfs2' },
        { hostPrefix: projectRoot, mountPrefix: 'gpfs://gpfs2-projects' },
      ],
    })
    assert.equal(mount, `gpfs://gpfs2-projects/dataset:${hostPath}`)
  })

  it('resolves runtime mounts from the saved mode and produces stable fingerprints', () => {
    const a = path.join(gpfsRoot, 'a')
    const b = path.join(gpfsRoot, 'b')
    // The saved mode is the cluster's observed mode, set at mount-add time.
    // resolveUserRlaunchRuntimeMounts now passes it through verbatim — there is
    // no rw-approval gate anymore.
    setUserRlaunchMount('alice', b, 'rw')
    setUserRlaunchMount('alice', a, 'ro')

    const mounts = resolveUserRlaunchRuntimeMounts('alice', {
      gpfsMounts: [{ hostPrefix: gpfsRoot, mountPrefix: 'gpfs://gpfs1' }],
    })
    assert.deepEqual(mounts.map(mount => mount.workerPath), [a, b])
    assert.deepEqual(mounts.map(mount => mount.mode), ['ro', 'rw'])
    assert.deepEqual(mounts.map(mount => mount.requestedMode), ['ro', 'rw'])
    assert.equal(rlaunchMountFingerprint(mounts), rlaunchMountFingerprint([...mounts].reverse()))
  })

  it('requires absolute mount paths', () => {
    assert.throws(() => normalizeRlaunchMountPath('relative/path'), /must be absolute/)
  })

  it('preserves worker-only scope and marks its runtime mount daemon-invisible', () => {
    const dataPath = path.join(gpfsRoot, 'worker-only-data')
    setUserRlaunchMount('alice', dataPath, 'ro', 'worker-only')
    assert.deepEqual(loadUserRlaunchMounts('alice'), [{
      path: dataPath,
      mode: 'ro',
      scope: 'worker-only',
    }])
    const [mount] = resolveUserRlaunchRuntimeMounts('alice', {
      gpfsMounts: [{ hostPrefix: gpfsRoot, mountPrefix: 'gpfs://gpfs1' }],
    })
    assert.equal(mount?.daemonVisible, false)
  })

  it('lets a worker-only mount use the sole GPFS source without a host-prefix match', () => {
    const mount = setUserRlaunchMount('alice', '/remote-team/dataset', 'ro', 'worker-only')
    assert.equal(mount.changed, true)
    const [runtimeMount] = resolveUserRlaunchRuntimeMounts('alice', {
      gpfsMounts: [{ hostPrefix: gpfsRoot, mountPrefix: 'gpfs://gpfs1' }],
    })
    assert.equal(
      runtimeMount?.gpfsMount,
      'gpfs://gpfs1/remote-team/dataset:/remote-team/dataset',
    )
    assert.equal(runtimeMount?.daemonVisible, false)
  })
})

describe('findWorkspaceMountConflict', () => {
  const settings = (root: string) => ({ gpfsMounts: [{ hostPrefix: root, mountPrefix: 'gpfs://gpfs1' }] })
  const mount = (p: string): UserRlaunchMount => ({ path: p, mode: 'ro' })

  it('returns the mount whose path equals the proposed workspace', () => {
    const data = path.join(gpfsRoot, 'data')
    const hit = findWorkspaceMountConflict(data, [mount(data)], settings(gpfsRoot))
    assert.equal(hit?.path, data)
  })

  it('flags a workspace nested inside a mount', () => {
    const data = path.join(gpfsRoot, 'data')
    const sub = path.join(data, 'sub')
    const hit = findWorkspaceMountConflict(sub, [mount(data)], settings(gpfsRoot))
    assert.equal(hit?.path, data)
  })

  it('flags a mount nested inside the workspace', () => {
    const data = path.join(gpfsRoot, 'data')
    const sub = path.join(data, 'sub')
    const hit = findWorkspaceMountConflict(data, [mount(sub)], settings(gpfsRoot))
    assert.equal(hit?.path, sub)
  })

  it('returns null when the workspace is disjoint from every mount', () => {
    const ws = path.join(gpfsRoot, 'workspace')
    const data = path.join(gpfsRoot, 'data')
    assert.equal(findWorkspaceMountConflict(ws, [mount(data)], settings(gpfsRoot)), null)
  })

  it('picks the conflicting mount among several', () => {
    const ws = path.join(gpfsRoot, 'project')
    const other = path.join(gpfsRoot, 'data')
    const inside = path.join(ws, 'nested')
    const hit = findWorkspaceMountConflict(ws, [mount(other), mount(inside)], settings(gpfsRoot))
    assert.equal(hit?.path, inside)
  })
})

describe('applyObservedWorkerModes', () => {
  it('records the worker-observed mode on a worker-only mount', () => {
    // The daemon cannot see this path, so its stored `ro` is a placeholder.
    // The worker's /proc/mounts is the only witness of the real mode.
    setUserRlaunchMount('alice', '/remote-team/datasets', 'ro', 'worker-only')
    const changed = applyObservedWorkerModes('alice', [
      { path: '/remote-team/datasets', mode: 'rw' },
    ])
    assert.deepEqual(changed, [{ path: '/remote-team/datasets', from: 'ro', to: 'rw' }])
    assert.deepEqual(loadUserRlaunchMounts('alice'), [
      { path: '/remote-team/datasets', mode: 'rw', scope: 'worker-only' },
    ])
  })

  it('leaves a daemon-visible (shared) mount alone', () => {
    // Write / Edit on a shared mount go through the daemon-side host fast path,
    // and LayeredDataPlane treats a host EACCES as fatal with no relay
    // fallback — so the daemon's own access verdict, not the worker's, must
    // decide whether that byte path may write.
    const data = path.join(gpfsRoot, 'shared-ro')
    mkdirSync(data, { recursive: true })
    setUserRlaunchMount('alice', data, 'ro')
    assert.deepEqual(applyObservedWorkerModes('alice', [{ path: data, mode: 'rw' }]), [])
    assert.deepEqual(loadUserRlaunchMounts('alice'), [{ path: data, mode: 'ro' }])
  })

  it('is a no-op for an unchanged mode, an unknown path, or an empty report', () => {
    setUserRlaunchMount('alice', '/remote-team/datasets', 'rw', 'worker-only')
    assert.deepEqual(applyObservedWorkerModes('alice', []), [])
    assert.deepEqual(applyObservedWorkerModes('alice', [{ path: '/elsewhere', mode: 'ro' }]), [])
    assert.deepEqual(
      applyObservedWorkerModes('alice', [{ path: '/remote-team/datasets', mode: 'rw' }]),
      [],
    )
    assert.deepEqual(loadUserRlaunchMounts('alice'), [
      { path: '/remote-team/datasets', mode: 'rw', scope: 'worker-only' },
    ])
  })
})

describe('probeDaemonMountAccess', () => {
  it('reports worker-only with NO mode for a path the daemon cannot stat', async () => {
    // `mode: null` = "the daemon has no opinion". Asserting `ro` here would
    // clobber the worker's own observation on every daemon restart.
    assert.deepEqual(
      await probeDaemonMountAccess('/no/such/path/xyz'),
      { kind: 'ok', scope: 'worker-only', mode: null },
    )
  })

  it('reports shared rw for a daemon-writable directory', async () => {
    const d = path.join(gpfsRoot, 'probe-rw')
    mkdirSync(d, { recursive: true })
    assert.deepEqual(await probeDaemonMountAccess(d), { kind: 'ok', scope: 'shared', mode: 'rw' })
  })

  it('resolves inconclusive instead of hanging when the filesystem stalls', async () => {
    // Regression (review §3.8c): the old sync statSync probe blocked the whole
    // event loop for as long as a hung gpfs kept the syscall pending.
    const never = new Promise<never>(() => {})
    const result = await probeDaemonMountAccess('/hung/gpfs/path', {
      timeoutMs: 20,
      fs: { stat: () => never, access: () => never },
    })
    assert.equal(result.kind, 'inconclusive')
  })
})

describe('refreshUserRlaunchMountAccess', () => {
  const ok = (scope: 'shared' | 'worker-only', mode: 'ro' | 'rw' | null) =>
    ({ kind: 'ok', scope, mode }) as const

  it('keeps a worker-observed rw on a still-invisible worker-only mount', async () => {
    // Regression: the daemon probe used to assert `ro` for anything it could
    // not stat, so every restart read a worker-only rw mount as a downgrade,
    // persisted `ro` after the confirmation window, and the next worker
    // provisioning observed `rw` again — a fingerprint ping-pong that rebuilt
    // the pod and mislabeled the mount read-only in between.
    setUserRlaunchMount('alice', '/remote-team/datasets', 'rw', 'worker-only')
    const result = await refreshUserRlaunchMountAccess('alice', { confirmDelayMs: 5 })
    assert.equal(result.changed, 0)
    assert.equal(result.downgradeConfirmation, null)
    assert.deepEqual(loadUserRlaunchMounts('alice'), [
      { path: '/remote-team/datasets', mode: 'rw', scope: 'worker-only' },
    ])
  })

  it('flips a worker-only mount to shared/rw once the daemon can see and write it', async () => {
    const data = path.join(gpfsRoot, 'now-visible')
    mkdirSync(data, { recursive: true })
    setUserRlaunchMount('alice', data, 'ro', 'worker-only')
    const result = await refreshUserRlaunchMountAccess('alice')
    assert.equal(result.changed, 1)
    // upgrades apply on the FIRST pass — no confirmation round needed
    assert.equal(result.downgradeConfirmation, null)
    // scope dropped (no longer worker-only), mode upgraded to rw
    assert.deepEqual(loadUserRlaunchMounts('alice'), [{ path: data, mode: 'rw' }])
  })

  it('does not persist a downgrade from a transient probe failure', async () => {
    // Regression (review §3.8a): daemon restart racing gpfs mounting used to
    // rewrite every shared/rw mount to worker-only/ro on ONE failed stat,
    // flipping the fingerprint (full pod rebuild) and revoking Write/Edit.
    const data = path.join(gpfsRoot, 'gpfs-late') // intentionally never created
    setUserRlaunchMount('alice', data, 'rw')
    let calls = 0
    const result = await refreshUserRlaunchMountAccess('alice', {
      confirmDelayMs: 5,
      // first probe: gpfs not mounted yet; re-probes: it came up
      probe: async () => (calls++ === 0 ? ok('worker-only', null) : ok('shared', 'rw')),
    })
    assert.equal(result.changed, 0)
    assert.ok(result.downgradeConfirmation, 'downgrade must enter confirmation, not persist')
    assert.deepEqual(await result.downgradeConfirmation, { changed: 0 })
    assert.deepEqual(loadUserRlaunchMounts('alice'), [{ path: data, mode: 'rw' }])
  })

  it('persists a downgrade only after every confirmation probe agrees', async () => {
    const data = path.join(gpfsRoot, 'really-gone')
    setUserRlaunchMount('alice', data, 'rw')
    let calls = 0
    const result = await refreshUserRlaunchMountAccess('alice', {
      confirmDelayMs: 5,
      probe: async () => {
        calls += 1
        return ok('worker-only', null)
      },
    })
    assert.equal(result.changed, 0)
    // first pass persists nothing yet
    assert.deepEqual(loadUserRlaunchMounts('alice'), [{ path: data, mode: 'rw' }])
    assert.deepEqual(await result.downgradeConfirmation, { changed: 1 })
    assert.equal(calls, 3) // DOWNGRADE_CONFIRM_PROBES total observations
    assert.deepEqual(loadUserRlaunchMounts('alice'), [
      { path: data, mode: 'ro', scope: 'worker-only' },
    ])
  })

  it('treats an inconclusive probe as no-information and keeps the store', async () => {
    const data = path.join(gpfsRoot, 'hung') // never created: real probe would downgrade
    setUserRlaunchMount('alice', data, 'rw')
    const result = await refreshUserRlaunchMountAccess('alice', {
      probe: async () => ({ kind: 'inconclusive', detail: 'probe timed out after 20ms' }),
    })
    assert.equal(result.changed, 0)
    assert.equal(result.downgradeConfirmation, null)
    assert.deepEqual(loadUserRlaunchMounts('alice'), [{ path: data, mode: 'rw' }])
  })

  it('downgrades a shared rw mount to ro when the daemon durably loses write', { skip: process.getuid?.() === 0 }, async () => {
    const data = path.join(gpfsRoot, 'lost-write')
    mkdirSync(data, { recursive: true })
    setUserRlaunchMount('alice', data, 'rw')
    chmodSync(data, 0o500)
    try {
      const result = await refreshUserRlaunchMountAccess('alice', { confirmDelayMs: 5 })
      assert.equal(result.changed, 0)
      assert.deepEqual(await result.downgradeConfirmation, { changed: 1 })
      assert.deepEqual(loadUserRlaunchMounts('alice'), [{ path: data, mode: 'ro' }])
    } finally {
      chmodSync(data, 0o700)
    }
  })

  it('leaves a mount alone when /mount rewrote it during the confirmation window', async () => {
    const data = path.join(gpfsRoot, 'raced') // never created → probe reads worker-only
    setUserRlaunchMount('alice', data, 'rw')
    let confirmation: Promise<{ changed: number }> | null = null
    const result = await refreshUserRlaunchMountAccess('alice', {
      confirmDelayMs: 5,
      probe: async () => ok('worker-only', null),
    })
    confirmation = result.downgradeConfirmation
    assert.ok(confirmation)
    // user re-adds the mount as ro while confirmation is pending — their
    // explicit write wins over the stale first-pass observation
    setUserRlaunchMount('alice', data, 'ro')
    assert.deepEqual(await confirmation, { changed: 0 })
    assert.deepEqual(loadUserRlaunchMounts('alice'), [{ path: data, mode: 'ro' }])
  })

  it('is a no-op when nothing changed', async () => {
    const data = path.join(gpfsRoot, 'stable')
    mkdirSync(data, { recursive: true })
    setUserRlaunchMount('alice', data, 'rw')
    const result = await refreshUserRlaunchMountAccess('alice')
    assert.equal(result.changed, 0)
    assert.equal(result.downgradeConfirmation, null)
    assert.deepEqual(loadUserRlaunchMounts('alice'), [{ path: data, mode: 'rw' }])
  })

  it('keeps a still-invisible path worker-only without churn', async () => {
    setUserRlaunchMount('alice', '/remote-team/dataset', 'ro', 'worker-only')
    const result = await refreshUserRlaunchMountAccess('alice')
    assert.equal(result.changed, 0)
    assert.equal(result.downgradeConfirmation, null)
    assert.deepEqual(loadUserRlaunchMounts('alice'), [
      { path: '/remote-team/dataset', mode: 'ro', scope: 'worker-only' },
    ])
  })
})
