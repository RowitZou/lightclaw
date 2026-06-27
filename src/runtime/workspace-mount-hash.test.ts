import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  buildDockerRuntimeConfig,
  buildRlaunchRuntimeConfig,
} from './pool.js'
import type { LightClawConfig } from '../config.js'
import { setUserRlaunchMount } from './rlaunch-mounts.js'

// Regression guard for the "report success but pod/container not actually
// swapped" bug class: when the workspace host path changes (e.g. via
// `/config workspace set <new-dir>`), the per-backend deployment identity MUST
// change too. RlaunchRuntime._startOnce reuses an existing worker when
// `record.deploymentHash === cfg.deploymentHash`; DockerRuntime.start reuses an
// existing container by name (`<prefix><user>-<deploymentHash>`). If the
// workspace mount is not folded into that identity, a workspace switch silently
// reuses a pod/container still bound to the OLD (often empty) mount — the agent
// then sees an empty /workspace while the slash command reported success.

function makeConfig(): LightClawConfig {
  return {
    runtime: {
      backend: 'docker',
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
        tmpfs: ['/tmp'],
        env: {},
        autoPull: true,
        security: {
          capDrop: ['ALL'],
          capAdd: ['DAC_OVERRIDE', 'CHOWN', 'SETUID', 'SETGID'],
          noNewPrivileges: true,
          readOnlyRootfs: false,
          pidsLimit: 512,
          ulimits: { nofile: '4096:8192', nproc: '1024:2048' },
          tmpfsOptions: 'rw,nosuid,size=512m',
        },
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
        gpfsMounts: [{ hostPrefix: '/mnt/shared-storage-user', mountPrefix: 'gpfs://gpfs1' }],
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

describe('workspace mount is folded into deployment identity', () => {
  // RlaunchRuntime derives its workspace host path from workspaceFor(user),
  // which reads LIGHTCLAW_WORKSPACE_ROOT. Vary it (both values under the gpfs
  // host prefix) to simulate a `/config workspace set` switch for the same user.
  let saved: string | undefined
  before(() => {
    saved = process.env.LIGHTCLAW_WORKSPACE_ROOT
  })
  after(() => {
    if (saved === undefined) delete process.env.LIGHTCLAW_WORKSPACE_ROOT
    else process.env.LIGHTCLAW_WORKSPACE_ROOT = saved
  })

  it('rlaunch deploymentHash changes when the workspace host path changes', () => {
    const config = makeConfig()

    process.env.LIGHTCLAW_WORKSPACE_ROOT = '/mnt/shared-storage-user/ailab-hs/old'
    const before = buildRlaunchRuntimeConfig('alice', '/unused', config, 'deadbeef')

    process.env.LIGHTCLAW_WORKSPACE_ROOT = '/mnt/shared-storage-user/ailab-hs/new'
    const after = buildRlaunchRuntimeConfig('alice', '/unused', config, 'deadbeef')

    assert.notEqual(before.workspaceHostPath, after.workspaceHostPath,
      'precondition: the two builds must resolve different workspace host paths')
    assert.notEqual(before.deploymentHash, after.deploymentHash,
      'a workspace switch must change the rlaunch worker identity, else _startOnce reuses the old pod')
  })

  it('docker containerName changes when the workspace host path changes', () => {
    const config = makeConfig()

    const before = buildDockerRuntimeConfig('alice', '/host/ws-old', config, 'deadbeef')
    const after = buildDockerRuntimeConfig('alice', '/host/ws-new', config, 'deadbeef')

    assert.notEqual(before.containerName, after.containerName,
      'a workspace switch must change the docker container identity, else start reuses the old container')
  })

  it('worker-only mounts change only the owning user deployment identity', () => {
    const config = makeConfig()
    const home = mkdtempSync(path.join(tmpdir(), 'lightclaw-worker-only-hash-'))
    const savedHome = process.env.LIGHTCLAW_HOME
    const savedWorkspace = process.env.LIGHTCLAW_WORKSPACE_ROOT
    process.env.LIGHTCLAW_HOME = home
    process.env.LIGHTCLAW_WORKSPACE_ROOT = '/mnt/shared-storage-user/ailab-hs/workspaces'
    try {
      const aliceBefore = buildRlaunchRuntimeConfig('alice', '/unused', config, 'deadbeef')
      const bobBefore = buildRlaunchRuntimeConfig('bob', '/unused', config, 'deadbeef')

      setUserRlaunchMount('alice', '/remote-team/private-dataset', 'ro', 'worker-only')

      const aliceAfter = buildRlaunchRuntimeConfig('alice', '/unused', config, 'deadbeef')
      const bobAfter = buildRlaunchRuntimeConfig('bob', '/unused', config, 'deadbeef')
      assert.notEqual(aliceAfter.deploymentHash, aliceBefore.deploymentHash)
      assert.equal(bobAfter.deploymentHash, bobBefore.deploymentHash)
      assert.equal(aliceAfter.extraMounts?.[0]?.daemonVisible, false)
      assert.equal(bobAfter.extraMounts?.length ?? 0, 0)
    } finally {
      if (savedHome === undefined) delete process.env.LIGHTCLAW_HOME
      else process.env.LIGHTCLAW_HOME = savedHome
      if (savedWorkspace === undefined) delete process.env.LIGHTCLAW_WORKSPACE_ROOT
      else process.env.LIGHTCLAW_WORKSPACE_ROOT = savedWorkspace
      rmSync(home, { recursive: true, force: true })
    }
  })
})
