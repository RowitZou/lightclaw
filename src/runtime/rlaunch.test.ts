import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { setLightclawHomeOverride } from '../paths.js'
import { workspaceToGpfsMount } from '../identity/paths.js'
import { parseWorkerName } from './rlaunch.js'
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
