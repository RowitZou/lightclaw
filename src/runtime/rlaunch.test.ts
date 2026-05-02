import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { setLightclawHomeOverride } from '../paths.js'
import { workspaceToGpfsMount } from '../identity/paths.js'
import { buildLaunchArgs, parseWorkerName, type RlaunchRuntimeConfig } from './rlaunch.js'
import {
  deleteWorkerRecord,
  lookupWorkerRecord,
  writeWorkerRecord,
} from './rlaunch-state.js'
import { translateRlaunchError } from './rlaunch-errors.js'
import { WorkerReadinessTracker } from './worker-readiness.js'

describe('parseWorkerName', () => {
  it('parses real rlaunch detached output', () => {
    const output = [
      'time="2026-05-01T15:20:09+08:00" level=info msg="Checking image..."',
      'Launching detach mode...',
      'create podgroup queue-name=ailab-hs-hs-gpu group-name=ws-6132b9cf57844a3a-task-t6fw6',
      '当前任务排队策略: 柔性资源优先',
      'ws-6132b9cf57844a3a-worker-c8hlj',
    ].join('\n')
    assert.equal(parseWorkerName(output), 'ws-6132b9cf57844a3a-worker-c8hlj')
  })

  it('ignores logs when no worker name exists', () => {
    assert.equal(parseWorkerName('Launching detach mode...\nfailed'), null)
  })
})

describe('workspaceToGpfsMount', () => {
  const savedWorkspaceRoot = process.env.LIGHTCLAW_WORKSPACE_ROOT

  afterEach(() => {
    if (savedWorkspaceRoot === undefined) {
      delete process.env.LIGHTCLAW_WORKSPACE_ROOT
    } else {
      process.env.LIGHTCLAW_WORKSPACE_ROOT = savedWorkspaceRoot
    }
  })

  it('maps a host gpfs workspace root to an rlaunch mount URL', () => {
    process.env.LIGHTCLAW_WORKSPACE_ROOT = '/mnt/shared-storage-user/ailab-hs/zouyicheng/lightclaw-workspaces'
    assert.deepEqual(workspaceToGpfsMount('alice', {
      gpfsHostPrefix: '/mnt/shared-storage-user',
      gpfsMountPrefix: 'gpfs://gpfs1',
    }), {
      hostPath: '/mnt/shared-storage-user/ailab-hs/zouyicheng/lightclaw-workspaces/alice',
      mount: 'gpfs://gpfs1/ailab-hs/zouyicheng/lightclaw-workspaces/alice:/workspace',
    })
  })

  it('rejects non-gpfs workspace roots', () => {
    process.env.LIGHTCLAW_WORKSPACE_ROOT = '/home/zouyicheng/lightclaw-workspaces'
    assert.throws(() => workspaceToGpfsMount('alice', {
      gpfsHostPrefix: '/mnt/shared-storage-user',
      gpfsMountPrefix: 'gpfs://gpfs1',
    }), /requires LIGHTCLAW_WORKSPACE_ROOT/)
  })
})

describe('Rlaunch worker state', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'lightclaw-rlaunch-test-'))
    setLightclawHomeOverride(home)
  })

  afterEach(() => {
    setLightclawHomeOverride(undefined)
    rmSync(home, { recursive: true, force: true })
  })

  it('writes, reads, and deletes worker records', async () => {
    await writeWorkerRecord('alice', {
      name: 'ws-x-worker-y',
      namespace: 'ailab-hs',
      chargedGroup: 'hs_gpu',
      image: 'registry/image:tag',
      deploymentHash: 'abc12345',
      createdAt: 123,
    })
    assert.equal(lookupWorkerRecord('alice')?.name, 'ws-x-worker-y')
    await deleteWorkerRecord('alice')
    assert.equal(lookupWorkerRecord('alice'), undefined)
  })

  it('preserves all entries under concurrent writes for different users', async () => {
    const users = ['alice', 'bob', 'carol', 'dave', 'eve']
    await Promise.all(users.map(user =>
      writeWorkerRecord(user, {
        name: `ws-${user}`,
        namespace: 'ailab-hs',
        chargedGroup: 'hs_gpu',
        image: 'registry/image:tag',
        deploymentHash: 'abc12345',
        createdAt: 1,
      }),
    ))
    for (const user of users) {
      assert.equal(lookupWorkerRecord(user)?.name, `ws-${user}`,
        `expected user ${user} to survive concurrent writes`)
    }
  })
})

describe('WorkerReadinessTracker', () => {
  it('tracks scheduling, ready, failed, and quota denied states', () => {
    const tracker = new WorkerReadinessTracker('alice')
    assert.equal(tracker.snapshot().state, 'not-attempted')
    tracker.startSchedule('image:tag')
    assert.equal(tracker.snapshot().state, 'scheduling')
    assert.equal(tracker.snapshot().image, 'image:tag')
    tracker.markReady()
    assert.equal(tracker.snapshot().state, 'ready')
    tracker.markFailed('boom')
    assert.equal(tracker.snapshot().state, 'failed')
    assert.equal(tracker.snapshot().lastError, 'boom')
    tracker.markQuotaDenied('quota')
    assert.equal(tracker.snapshot().state, 'quota-denied')
  })
})

describe('buildLaunchArgs', () => {
  const baseCfg: RlaunchRuntimeConfig = {
    canonicalUser: 'alice',
    deploymentHash: 'abc12345',
    image: 'registry/x:tag',
    chargedGroup: 'hs_cpu',
    namespace: 'ailab-hs',
    cpu: 8,
    memoryMb: 16000,
    gpu: 0,
    privateMachine: 'group',
    positiveTags: [],
    workerGcTimeHours: 24,
    imagePullPolicy: 'IfNotPresent',
    maxWaitDuration: '5m',
    predictBeforeStart: true,
    workspaceHostPath: '/mnt/host/alice',
    workspaceGpfsMount: 'gpfs://gpfs1/ns/u/alice:/workspace',
    workspaceContainerPath: '/workspace',
    helperContainerPath: '/opt/lightclaw/sandbox-helpers',
    env: {},
  }

  it('emits --set-env=KEY=VAL for every env entry on detached spawn', () => {
    const args = buildLaunchArgs(
      { ...baseCfg, env: { http_proxy: 'http://10.0.0.1:18080', no_proxy: 'localhost' } },
      { detach: true, predictOnly: false },
    )
    const setEnvFlags = args.filter(arg => arg.startsWith('--set-env=')).sort()
    assert.deepEqual(setEnvFlags, [
      '--set-env=http_proxy=http://10.0.0.1:18080',
      '--set-env=no_proxy=localhost',
    ])
    assert.equal(
      args.includes('-e'),
      false,
      'must not use -e; rlaunch silently drops it on detached spawn',
    )
    assert.equal(args[0], '-d', 'detach prepends -d')
  })

  it('emits env on predict-only and stops at -- bash', () => {
    const args = buildLaunchArgs(
      { ...baseCfg, env: { http_proxy: 'http://h:1' } },
      { detach: false, predictOnly: true },
    )
    const tail = args.slice(-3)
    assert.deepEqual(tail, ['--predict-only=true', '--', 'bash'])
    assert.ok(
      args.some(arg => arg.startsWith('--set-env=')),
      'predict still inherits env so failures fail-fast',
    )
  })

  it('omits --set-env when env is empty', () => {
    const args = buildLaunchArgs(baseCfg, { detach: true, predictOnly: false })
    assert.equal(args.some(arg => arg.startsWith('--set-env=')), false)
  })
})

describe('translateRlaunchError', () => {
  it('recognizes quota errors', () => {
    const translated = translateRlaunchError('insufficient group quota: GPU: 20/5')
    assert.match(translated.admin, /quota denied/i)
    assert.match(translated.suggestion, /配额/)
  })

  it('recognizes image pull failures', () => {
    const translated = translateRlaunchError('ImagePullBackOff')
    assert.match(translated.admin, /image pull failed/i)
    assert.match(translated.suggestion, /registry/)
  })

  it('falls back for unknown errors', () => {
    const translated = translateRlaunchError('something odd')
    assert.match(translated.admin, /RlaunchRuntime failed/)
  })
})
