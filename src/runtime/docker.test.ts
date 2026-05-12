import test, { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildDockerCreateArgs,
  DockerRuntime,
  type DockerRuntimeConfig,
  type DockerRuntimeSecurity,
} from './docker.js'
import { ImageReadinessTracker } from './image-readiness.js'

const DEFAULT_SECURITY: DockerRuntimeSecurity = {
  capDrop: ['ALL'],
  capAdd: ['DAC_OVERRIDE', 'CHOWN', 'SETUID', 'SETGID'],
  noNewPrivileges: true,
  readOnlyRootfs: false,
  pidsLimit: 512,
  ulimits: { nofile: '4096:8192', nproc: '1024:2048' },
  tmpfsOptions: 'rw,nosuid,size=512m',
  storageOptSize: '32g',
  workspaceQuotaMb: 524288,
}

function makeConfig(overrides: Partial<DockerRuntimeConfig> = {}): DockerRuntimeConfig {
  return {
    image: 'ghcr.io/test/lightclaw-sandbox:latest',
    workspaceHostPath: '/host/workspace/u1',
    containerName: 'lightclaw-u1-abc',
    helperContainerPath: '/opt/lightclaw/sandbox-helpers',
    workspaceContainerPath: '/workspace',
    mounts: [],
    tmpfs: ['/tmp'],
    env: {},
    memoryLimit: '4g',
    cpuLimit: 4,
    network: 'bridge',
    autoPull: true,
    security: { ...DEFAULT_SECURITY, ulimits: { ...DEFAULT_SECURITY.ulimits } },
    ...overrides,
  }
}

function indicesOf(args: string[], flag: string): number[] {
  const out: number[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) out.push(i)
  }
  return out
}

function pairsAfter(args: string[], flag: string): string[] {
  return indicesOf(args, flag).map(i => args[i + 1] ?? '')
}

test('buildDockerCreateArgs applies the OpenClaw-style hardening defaults', () => {
  const args = buildDockerCreateArgs(makeConfig())

  assert.deepEqual(pairsAfter(args, '--cap-drop'), ['ALL'])
  assert.deepEqual(
    pairsAfter(args, '--cap-add'),
    ['DAC_OVERRIDE', 'CHOWN', 'SETUID', 'SETGID'],
  )
  assert.deepEqual(pairsAfter(args, '--security-opt'), ['no-new-privileges'])
  assert.equal(args.includes('--read-only'), false, 'readOnlyRootfs is opt-in')
  assert.deepEqual(pairsAfter(args, '--pids-limit'), ['512'])
  assert.deepEqual(pairsAfter(args, '--storage-opt'), ['size=32g'])
  assert.deepEqual(
    pairsAfter(args, '--ulimit').sort(),
    ['nofile=4096:8192', 'nproc=1024:2048'],
  )
  assert.deepEqual(
    pairsAfter(args, '--tmpfs'),
    ['/tmp:rw,nosuid,size=512m'],
  )
})

test('buildDockerCreateArgs omits --storage-opt when storageOptSize is null', () => {
  const args = buildDockerCreateArgs(makeConfig({
    security: { ...DEFAULT_SECURITY, storageOptSize: null, ulimits: {} },
  }))
  assert.deepEqual(pairsAfter(args, '--storage-opt'), [])
})

test('buildDockerCreateArgs respects custom storageOptSize values', () => {
  const args = buildDockerCreateArgs(makeConfig({
    security: { ...DEFAULT_SECURITY, storageOptSize: '128g', ulimits: {} },
  }))
  assert.deepEqual(pairsAfter(args, '--storage-opt'), ['size=128g'])
})

test('buildDockerCreateArgs respects readOnlyRootfs when admin opts in', () => {
  const args = buildDockerCreateArgs(makeConfig({
    security: { ...DEFAULT_SECURITY, readOnlyRootfs: true, ulimits: {} },
  }))
  assert.equal(args.includes('--read-only'), true)
})

test('buildDockerCreateArgs omits --pids-limit when null', () => {
  const args = buildDockerCreateArgs(makeConfig({
    security: { ...DEFAULT_SECURITY, pidsLimit: null, ulimits: {} },
  }))
  assert.deepEqual(pairsAfter(args, '--pids-limit'), [])
})

test('buildDockerCreateArgs emits one --ulimit per ulimits entry', () => {
  const args = buildDockerCreateArgs(makeConfig({
    security: {
      ...DEFAULT_SECURITY,
      ulimits: { nofile: '8192:16384', nproc: '2048:4096', core: '0' },
    },
  }))
  assert.deepEqual(
    pairsAfter(args, '--ulimit').sort(),
    ['core=0', 'nofile=8192:16384', 'nproc=2048:4096'],
  )
})

test('buildDockerCreateArgs disables hardening flags when admin clears them', () => {
  const args = buildDockerCreateArgs(makeConfig({
    security: {
      capDrop: [],
      capAdd: [],
      noNewPrivileges: false,
      readOnlyRootfs: false,
      pidsLimit: null,
      ulimits: {},
      tmpfsOptions: 'rw,size=2g',
      storageOptSize: null,
      workspaceQuotaMb: null,
    },
  }))
  assert.deepEqual(pairsAfter(args, '--cap-drop'), [])
  assert.deepEqual(pairsAfter(args, '--cap-add'), [])
  assert.equal(args.includes('--security-opt'), false)
  assert.equal(args.includes('--read-only'), false)
  assert.equal(args.includes('--pids-limit'), false)
  assert.equal(args.includes('--storage-opt'), false)
  assert.equal(args.includes('--ulimit'), false)
})

test('buildDockerCreateArgs honors per-entry tmpfs options verbatim', () => {
  const args = buildDockerCreateArgs(makeConfig({
    tmpfs: ['/tmp', '/var/tmp:rw,size=1g,exec'],
  }))
  assert.deepEqual(
    pairsAfter(args, '--tmpfs'),
    ['/tmp:rw,nosuid,size=512m', '/var/tmp:rw,size=1g,exec'],
  )
})

test('buildDockerCreateArgs preserves the workspace bind mount and image positional', () => {
  const args = buildDockerCreateArgs(makeConfig({
    mounts: [
      { host: '/host/ro', container: '/opt/ro', mode: 'ro' },
    ],
    env: { FOO: 'bar' },
  }))
  assert.equal(args[0], 'create')
  // container name + image label still present
  assert.equal(args.includes('lightclaw-u1-abc'), true)
  // workspace bind mount
  assert.deepEqual(
    pairsAfter(args, '-v'),
    ['/host/workspace/u1:/workspace:rw', '/host/ro:/opt/ro:ro'],
  )
  // env var
  assert.deepEqual(pairsAfter(args, '-e'), ['FOO=bar'])
  // image + sleep are last two positionals
  assert.equal(args[args.length - 3], 'ghcr.io/test/lightclaw-sandbox:latest')
  assert.equal(args[args.length - 2], 'sleep')
  assert.equal(args[args.length - 1], 'infinity')
})

describe('DockerRuntime isAvailable retryable mapping', () => {
  // Bug 12 (2026-05-12 dogfood) invariant: every non-ok branch must carry
  // a boolean `retryable`. Image pulls / not-attempted are transient
  // backoffs (next turn or a short wait recovers); image-failed and
  // autopull-disabled need admin intervention.
  let runtime: DockerRuntime
  let tracker: ImageReadinessTracker

  beforeEach(() => {
    tracker = new ImageReadinessTracker()
    runtime = new DockerRuntime(makeConfig(), tracker)
  })

  it('image-pulling is retryable', async () => {
    // ImageReadinessTracker has no public method to enter `pulling` without
    // shelling out to docker, so set the private fields directly for the
    // test snapshot. This stays inside the test surface — production code
    // never reaches in here.
    Object.assign(tracker as unknown as Record<string, unknown>, {
      _state: 'pulling',
      _image: 'ghcr.io/test/lightclaw-sandbox:latest',
      _pullStartedAt: Date.now() - 5000,
    })
    const avail = await runtime.isAvailable()
    assert.equal(avail.ok, false)
    if (avail.ok) return
    assert.equal(avail.reason, 'image-pulling')
    assert.equal(avail.retryable, true)
  })

  it('image-not-attempted (initial state) is retryable', async () => {
    const avail = await runtime.isAvailable()
    assert.equal(avail.ok, false)
    if (avail.ok) return
    assert.equal(avail.reason, 'image-not-attempted')
    assert.equal(avail.retryable, true)
  })

  it('image-failed is NOT retryable', async () => {
    tracker.markFailed('Error response from daemon: manifest unknown')
    const avail = await runtime.isAvailable()
    assert.equal(avail.ok, false)
    if (avail.ok) return
    assert.equal(avail.reason, 'image-failed')
    assert.equal(avail.retryable, false)
  })

  it('autopull-disabled is NOT retryable', async () => {
    // docker.ts:221 keys autopull-disabled off the `AUTOPULL_DISABLED:` prefix
    // in lastError. Operator decision, never recovers on its own.
    tracker.markFailed('AUTOPULL_DISABLED: no local image and autoPull=false')
    const avail = await runtime.isAvailable()
    assert.equal(avail.ok, false)
    if (avail.ok) return
    assert.equal(avail.reason, 'autopull-disabled')
    assert.equal(avail.retryable, false)
  })
})
