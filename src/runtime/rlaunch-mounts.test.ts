import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { setLightclawHomeOverride } from '../paths.js'
import {
  buildGpfsMountString,
  loadUserRlaunchMounts,
  normalizeRlaunchMountPath,
  removeUserRlaunchMount,
  resolveUserRlaunchRuntimeMounts,
  rlaunchMountFingerprint,
  setUserRlaunchMount,
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

  it('resolves runtime mounts and produces stable fingerprints', () => {
    const a = path.join(gpfsRoot, 'a')
    const b = path.join(gpfsRoot, 'b')
    setUserRlaunchMount('alice', b, 'rw')
    setUserRlaunchMount('alice', a, 'ro')

    const mounts = resolveUserRlaunchRuntimeMounts('alice', {
      gpfsMounts: [{ hostPrefix: gpfsRoot, mountPrefix: 'gpfs://gpfs1' }],
    })
    assert.deepEqual(mounts.map(mount => mount.workerPath), [a, b])
    assert.equal(rlaunchMountFingerprint(mounts), rlaunchMountFingerprint([...mounts].reverse()))
  })

  it('requires absolute mount paths', () => {
    assert.throws(() => normalizeRlaunchMountPath('relative/path'), /must be absolute/)
  })
})
