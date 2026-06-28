import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { setLightclawHomeOverride } from '../paths.js'
import {
  buildGpfsMountString,
  findWorkspaceMountConflict,
  loadUserRlaunchMounts,
  normalizeRlaunchMountPath,
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
