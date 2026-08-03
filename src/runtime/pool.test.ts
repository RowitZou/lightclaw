import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { LightClawConfig } from '../config.js'
import { setLightclawHomeOverride } from '../paths.js'
import { RlaunchRuntime } from './index.js'
import { setUserRlaunchMount } from './rlaunch-mounts.js'
import {
  parseBrainctlProcessList,
  RuntimePool,
  selectRlaunchOrphans,
  type ClusterRlaunchProcess,
} from './pool.js'

const HASH = '637e42dc'

function processItem(input: {
  name: string
  comment?: string
  phase?: string
}): unknown {
  return {
    metadata: {
      name: input.name,
      annotations: input.comment ? { 'workspace.brainpp.cn/comment': input.comment } : {},
    },
    status: { phase: input.phase ?? 'Running' },
  }
}

describe('parseBrainctlProcessList', () => {
  it('keeps only items whose comment is in the lightclaw-runtime namespace', () => {
    const json = JSON.stringify({
      items: [
        processItem({ name: 'ws-a-worker-1', comment: 'lightclaw-runtime-alice-637e42dc' }),
        processItem({ name: 'ws-a-worker-2', comment: 'unrelated-job-1' }),
        processItem({ name: 'ws-a-worker-3', comment: 'lightclaw-runtime-bob-aaaaaaaa' }),
        processItem({ name: 'ws-a-master', comment: undefined }),
      ],
    })
    const parsed = parseBrainctlProcessList(json)
    assert.deepEqual(
      parsed.map(p => p.name).sort(),
      ['ws-a-worker-1', 'ws-a-worker-3'],
    )
  })

  it('returns empty list when items missing or non-array', () => {
    assert.deepEqual(parseBrainctlProcessList('{}'), [])
    assert.deepEqual(parseBrainctlProcessList('{"items":null}'), [])
    assert.deepEqual(parseBrainctlProcessList('{"items":[]}'), [])
  })

  it('captures phase string verbatim for downstream filtering', () => {
    const json = JSON.stringify({
      items: [
        processItem({ name: 'a', comment: 'lightclaw-runtime-x-637e42dc', phase: 'ContainerCreating' }),
        processItem({ name: 'b', comment: 'lightclaw-runtime-x-637e42dc', phase: 'Failed' }),
      ],
    })
    const parsed = parseBrainctlProcessList(json)
    assert.deepEqual(parsed.map(p => p.phase).sort(), ['ContainerCreating', 'Failed'])
  })

  it('drops items with malformed metadata', () => {
    const json = JSON.stringify({
      items: [
        null,
        'string-item',
        { metadata: null },
        processItem({ name: 'good', comment: 'lightclaw-runtime-x-637e42dc' }),
      ],
    })
    const parsed = parseBrainctlProcessList(json)
    assert.deepEqual(parsed.map(p => p.name), ['good'])
  })
})

describe('selectRlaunchOrphans', () => {
  function fixtures(comments: Array<{
    name: string
    canonical: string
    hash: string
    phase?: string
  }>): ClusterRlaunchProcess[] {
    return comments.map(c => ({
      name: c.name,
      comment: `lightclaw-runtime-${c.canonical}-${c.hash}`,
      phase: c.phase ?? 'Running',
    }))
  }

  it('flags untracked-name orphans for active users on current hash', () => {
    // The screenshot bug: state holds a fresh worker for `zouyicheng`, but
    // an older one with the same comment is still alive on the cluster.
    const orphans = selectRlaunchOrphans({
      processes: fixtures([
        { name: 'worker-vpgbv', canonical: 'zouyicheng', hash: HASH },
        { name: 'worker-jnk5s', canonical: 'zouyicheng', hash: HASH },
      ]),
      deploymentHash: HASH,
      activeUsers: new Set(['zouyicheng']),
      trackedNamesByUser: new Map([['zouyicheng', 'worker-jnk5s']]),
    })
    assert.deepEqual(orphans.map(o => ({ name: o.name, reason: o.reason })), [
      { name: 'worker-vpgbv', reason: 'untracked-name' },
    ])
  })

  it('skips workers whose name matches the tracked record', () => {
    const orphans = selectRlaunchOrphans({
      processes: fixtures([{ name: 'worker-jnk5s', canonical: 'alice', hash: HASH }]),
      deploymentHash: HASH,
      activeUsers: new Set(['alice']),
      trackedNamesByUser: new Map([['alice', 'worker-jnk5s']]),
    })
    assert.deepEqual(orphans, [])
  })

  it('flags inactive-user as orphan even when name not in state', () => {
    const orphans = selectRlaunchOrphans({
      processes: fixtures([{ name: 'worker-zzz', canonical: 'gone-user', hash: HASH }]),
      deploymentHash: HASH,
      activeUsers: new Set(['alice']),
      trackedNamesByUser: new Map(),
    })
    assert.deepEqual(orphans.map(o => o.reason), ['inactive-user'])
  })

  it('skips foreign-hash workers (could be sibling deployment)', () => {
    const orphans = selectRlaunchOrphans({
      processes: fixtures([
        { name: 'worker-foreign', canonical: 'alice', hash: 'aaaaaaaa' },
      ]),
      deploymentHash: HASH,
      activeUsers: new Set(['alice']),
      trackedNamesByUser: new Map(),
    })
    assert.deepEqual(orphans, [])
  })

  it('skips terminal phases (Stopped, Failed, Succeeded)', () => {
    const orphans = selectRlaunchOrphans({
      processes: fixtures([
        { name: 'a', canonical: 'alice', hash: HASH, phase: 'Stopped' },
        { name: 'b', canonical: 'alice', hash: HASH, phase: 'Failed' },
        { name: 'c', canonical: 'alice', hash: HASH, phase: 'Succeeded' },
        { name: 'd', canonical: 'alice', hash: HASH, phase: 'Running' },
      ]),
      deploymentHash: HASH,
      activeUsers: new Set(['alice']),
      trackedNamesByUser: new Map([['alice', 'd']]),
    })
    assert.deepEqual(orphans, [])
  })

  it('treats Pending / ContainerCreating / Starting as live (still consume slots)', () => {
    const orphans = selectRlaunchOrphans({
      processes: fixtures([
        { name: 'p', canonical: 'alice', hash: HASH, phase: 'Pending' },
        { name: 'cc', canonical: 'alice', hash: HASH, phase: 'ContainerCreating' },
        { name: 's', canonical: 'alice', hash: HASH, phase: 'Starting' },
      ]),
      deploymentHash: HASH,
      activeUsers: new Set(['alice']),
      trackedNamesByUser: new Map([['alice', 'tracked-name']]),
    })
    assert.deepEqual(orphans.map(o => o.name).sort(), ['cc', 'p', 's'])
  })

  it('ignores processes whose comment is not parseable', () => {
    // parseBrainctlProcessList already filters comment prefix, but
    // selectRlaunchOrphans guards against malformed comments slipping
    // through (e.g. an admin manually set `lightclaw-runtime-` literally).
    const orphans = selectRlaunchOrphans({
      processes: [
        { name: 'a', comment: 'lightclaw-runtime-', phase: 'Running' },
        { name: 'b', comment: 'lightclaw-runtime-no-hash', phase: 'Running' },
      ],
      deploymentHash: HASH,
      activeUsers: new Set(['alice']),
      trackedNamesByUser: new Map(),
    })
    assert.deepEqual(orphans, [])
  })
})

describe('RuntimePool.refreshRlaunchRuntimeForUser', () => {
  let tmpHome = ''
  let gpfsRoot = ''
  let savedWorkspaceRoot: string | undefined

  before(() => {
    savedWorkspaceRoot = process.env.LIGHTCLAW_WORKSPACE_ROOT
  })
  after(() => {
    if (savedWorkspaceRoot === undefined) {
      delete process.env.LIGHTCLAW_WORKSPACE_ROOT
    } else {
      process.env.LIGHTCLAW_WORKSPACE_ROOT = savedWorkspaceRoot
    }
  })

  beforeEach(() => {
    tmpHome = mkdtempSync(path.join(tmpdir(), 'lightclaw-pool-refresh-'))
    gpfsRoot = path.join(tmpHome, 'gpfs')
    mkdirSync(gpfsRoot, { recursive: true })
    setLightclawHomeOverride(tmpHome)
    // buildRlaunchRuntimeConfig resolves the workspace gpfs mount from
    // workspaceFor(), which reads LIGHTCLAW_WORKSPACE_ROOT — point it under
    // the gpfs host prefix declared in clusterConfig().
    process.env.LIGHTCLAW_WORKSPACE_ROOT = path.join(gpfsRoot, 'workspaces')
  })
  afterEach(() => {
    setLightclawHomeOverride(undefined)
    rmSync(tmpHome, { recursive: true, force: true })
  })

  function clusterConfig(): LightClawConfig {
    return {
      runtime: {
        backend: 'cluster',
        driver: 'brainpp',
        maxConcurrentIoBytesMb: 3072,
        maxRelayBytesMb: 4,
        network: {
          mode: 'isolated',
          proxy: '',
          noProxy: [],
          port: 18080,
          bindHost: '0.0.0.0',
          acl: [],
        },
        dockerSettings: {
          idleTimeoutMs: 1_800_000,
          memoryLimit: '4g',
          cpuLimit: 4,
          network: 'bridge',
          mounts: [],
          tmpfs: [],
          env: {},
          autoPull: true,
        },
        clusterSettings: {
          image: 'registry/x:tag',
          chargedGroup: 'hs_cpu',
          namespace: 'ailab-hs',
          cpu: 8,
          memoryMb: 16000,
          gpu: 0,
          privateMachine: 'group',
          positiveTags: [],
          gpfsMounts: [{ hostPrefix: gpfsRoot, mountPrefix: 'gpfs://gpfs1' }],
          imagePullPolicy: 'IfNotPresent',
          maxWaitDuration: '5m',
          workerGcTimeHours: 24,
          predictBeforeStart: true,
          healthCheckIntervalMs: 300_000,
          preheatOnStartup: true,
          preheatOnApproval: true,
          env: {},
        },
      },
    } as unknown as LightClawConfig
  }

  it('swaps a cached runtime built from a pre-downgrade mount store', () => {
    const dataPath = path.join(gpfsRoot, 'data')
    mkdirSync(dataPath, { recursive: true })
    // Pre-cluster-update view: the daemon can see the mount (shared/rw).
    setUserRlaunchMount('alice', dataPath, 'rw')

    const config = clusterConfig()
    const pool = new RuntimePool()
    const workspace = path.join(gpfsRoot, 'workspaces', 'alice')
    const stale = pool.acquire('alice', config, workspace)
    assert.ok(stale instanceof RlaunchRuntime)
    const staleEntry = stale.paths.mountTable.find(m => m.host === dataPath)
    assert.equal(staleEntry?.mode, 'rw')
    assert.notEqual(staleEntry?.daemonVisible, false)

    // Cluster update: the daemon lost the path; the startup re-probe confirms
    // the downgrade and rewrites the store. acquire() still serves the stale
    // instance (cache hit checks only the backend kind).
    setUserRlaunchMount('alice', dataPath, 'ro', 'worker-only')
    assert.equal(pool.acquire('alice', config, workspace), stale)

    assert.equal(pool.refreshRlaunchRuntimeForUser('alice', config), true)
    const fresh = pool.acquire('alice', config, workspace)
    assert.ok(fresh instanceof RlaunchRuntime)
    assert.notEqual(fresh, stale)
    const freshEntry = fresh.paths.mountTable.find(m => m.host === dataPath)
    assert.equal(freshEntry?.mode, 'ro')
    assert.equal(freshEntry?.daemonVisible, false)

    // The stale instance is retired and forwards to the successor, so a
    // concurrent ALS reference enforces the corrected mount semantics.
    assert.equal(stale.paths, fresh.paths)

    // Unchanged identity is a no-op — a healthy worker is never churned.
    assert.equal(pool.refreshRlaunchRuntimeForUser('alice', config), false)
    assert.equal(pool.acquire('alice', config, workspace), fresh)
  })

  it('no-ops when nothing is cached or the backend is not cluster', () => {
    const config = clusterConfig()
    const pool = new RuntimePool()
    assert.equal(pool.refreshRlaunchRuntimeForUser('alice', config), false)

    const local = { ...config, runtime: { ...config.runtime, backend: 'local' } } as LightClawConfig
    assert.equal(pool.refreshRlaunchRuntimeForUser('alice', local), false)
  })
})
