import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { ImageReadinessTracker } from './image-readiness.js'
import { LocalRuntime } from './local.js'
import { DockerRuntime, type DockerRuntimeConfig, type DockerRuntimeSecurity } from './docker.js'
import { RlaunchRuntime, type RlaunchRuntimeConfig } from './rlaunch.js'
import { WorkerReadinessTracker } from './worker-readiness.js'
import type {
  ControlPlaneKind,
  DataPlaneKind,
  Runtime,
  SecurityProfile,
} from './types.js'

// Cross-backend contract tests. Every Runtime implementation must satisfy the
// same shape invariants on `control` / `data` / `paths` + compatibility shim
// (`runtime.fs === runtime.data`; `runtime.exec` bound function). This file
// is the canary for future plane-interface drift — if a new backend or a
// plane-level refactor breaks a contract, the failure surfaces here in one
// place instead of being scattered across per-backend tests.

const VALID_CONTROL_KINDS = new Set<ControlPlaneKind>([
  'local-spawn',
  'docker-exec',
  'brainctl-exec',
])
const VALID_DATA_KINDS = new Set<DataPlaneKind>([
  'host-direct',
  'bind-mount',
  'shared-cluster-fs',
  'exec-relay',
])
const VALID_SECURITY_PROFILES = new Set<SecurityProfile>([
  'host-trusted',
  'container-isolated',
  'cluster-isolated',
])
const VALID_RELIABILITY = new Set([
  'guaranteed',
  'best-effort',
  'unreliable-large',
])
const VALID_DATA_RELIABILITY = new Set([
  'fs-semantic',
  'protocol-multiplex',
  'depends-on-control-plane',
])

function assertContract(runtime: Runtime, expectedKind: Runtime['kind']): void {
  assert.equal(runtime.kind, expectedKind)

  // ControlPlane shape
  assert.ok(runtime.control, 'runtime.control is required')
  assert.ok(VALID_CONTROL_KINDS.has(runtime.control.kind), `unknown control kind: ${runtime.control.kind}`)
  assert.ok(
    VALID_RELIABILITY.has(runtime.control.stdoutByteReliability),
    `unknown stdoutByteReliability: ${runtime.control.stdoutByteReliability}`,
  )
  assert.equal(typeof runtime.control.exec, 'function')
  assert.equal(typeof runtime.control.start, 'function')
  assert.equal(typeof runtime.control.stop, 'function')
  assert.equal(typeof runtime.control.isRunning, 'function')
  assert.equal(typeof runtime.control.isAvailable, 'function')

  // DataPlane shape
  assert.ok(runtime.data, 'runtime.data is required')
  assert.ok(VALID_DATA_KINDS.has(runtime.data.kind), `unknown data kind: ${runtime.data.kind}`)
  assert.equal(typeof runtime.data.independentFromControl, 'boolean')
  assert.ok(
    VALID_DATA_RELIABILITY.has(runtime.data.reliability),
    `unknown data reliability: ${runtime.data.reliability}`,
  )
  for (const op of ['readFile', 'writeFile', 'stat', 'readdir'] as const) {
    assert.equal(typeof runtime.data[op], 'function', `runtime.data.${op} must be a function`)
  }

  // PathPolicy shape
  assert.ok(runtime.paths, 'runtime.paths is required')
  assert.ok(Array.isArray(runtime.paths.mountTable), 'paths.mountTable must be an array')
  for (const op of ['toHostPath', 'toWorkerPath', 'isShared', 'isAllowed'] as const) {
    assert.equal(typeof runtime.paths[op], 'function', `runtime.paths.${op} must be a function`)
  }

  // Identity / metadata
  assert.equal(typeof runtime.workspaceRoot, 'string')
  assert.ok(
    VALID_SECURITY_PROFILES.has(runtime.securityProfile),
    `unknown securityProfile: ${runtime.securityProfile}`,
  )
  assert.equal(typeof runtime.isolated, 'boolean')

  // Backward-compat shim: runtime.fs is the SAME object reference as runtime.data
  // (callers that mutate `fs` see `data` mutated; required for Phase 33 zero
  // behavior change of `writeFileViaHostMount` injection on rlaunch).
  assert.equal(runtime.fs, runtime.data, 'runtime.fs MUST be the same object reference as runtime.data')
  assert.equal(typeof runtime.exec, 'function', 'runtime.exec MUST be a callable function')
}

describe('Runtime plane contract — LocalRuntime', () => {
  it('satisfies the shared shape contract', () => {
    const hostRoot = mkdtempSync(path.join(tmpdir(), 'lc-contract-local-'))
    try {
      const runtime = new LocalRuntime(hostRoot)
      assertContract(runtime, 'local')
      assert.equal(runtime.control.kind, 'local-spawn')
      assert.equal(runtime.data.kind, 'host-direct')
      assert.equal(runtime.securityProfile, 'host-trusted')
      assert.equal(runtime.control.stdoutByteReliability, 'guaranteed')
      assert.equal(runtime.data.independentFromControl, true)
      assert.equal(runtime.data.reliability, 'fs-semantic')
    } finally {
      rmSync(hostRoot, { recursive: true, force: true })
    }
  })
})

describe('Runtime plane contract — DockerRuntime', () => {
  const defaultSecurity: DockerRuntimeSecurity = {
    capDrop: ['ALL'],
    capAdd: [],
    noNewPrivileges: true,
    readOnlyRootfs: false,
    pidsLimit: 512,
    ulimits: {},
    tmpfsOptions: 'rw,nosuid,size=64m',
    storageOptSize: null,
    workspaceQuotaMb: null,
  }

  function makeConfig(workspaceHostPath: string): DockerRuntimeConfig {
    return {
      image: 'ghcr.io/test/sandbox:latest',
      workspaceHostPath,
      containerName: 'lightclaw-contract-test',
      workspaceContainerPath: '/workspace',
      mounts: [],
      tmpfs: ['/tmp'],
      env: {},
      memoryLimit: '1g',
      cpuLimit: 1,
      network: 'bridge',
      autoPull: false,
      security: defaultSecurity,
    }
  }

  it('satisfies the shared shape contract', () => {
    const hostRoot = mkdtempSync(path.join(tmpdir(), 'lc-contract-docker-'))
    try {
      const tracker = new ImageReadinessTracker()
      const runtime = new DockerRuntime(makeConfig(hostRoot), tracker)
      assertContract(runtime, 'docker')
      assert.equal(runtime.control.kind, 'docker-exec')
      assert.equal(runtime.data.kind, 'bind-mount') // LayeredDataPlane reports the first layer kind
      assert.equal(runtime.securityProfile, 'container-isolated')
      assert.equal(runtime.control.stdoutByteReliability, 'guaranteed')
    } finally {
      rmSync(hostRoot, { recursive: true, force: true })
    }
  })

  it('PathPolicy maps workspace paths and rejects out-of-mount paths', () => {
    const hostRoot = mkdtempSync(path.join(tmpdir(), 'lc-contract-docker-paths-'))
    try {
      const runtime = new DockerRuntime(makeConfig(hostRoot), new ImageReadinessTracker())
      const inMount = runtime.paths.toHostPath('/workspace/foo.txt')
      assert.equal(inMount, path.join(hostRoot, 'foo.txt'))
      assert.equal(runtime.paths.toHostPath('/etc/passwd'), null)
      assert.equal(runtime.paths.isShared('/workspace/foo.txt'), true)
      assert.equal(runtime.paths.isShared('/etc/passwd'), false)
      // Phase 33 isAllowed only gates ro-mount writes; reads and writes on
      // rw mounts both return true, and out-of-mount paths also return true
      // (let backend's toContainerPath natural error reject those).
      assert.equal(runtime.paths.isAllowed('/workspace/foo.txt', 'write'), true)
      assert.equal(runtime.paths.isAllowed('/etc/passwd', 'read'), true)
      // Out-of-mount paths still flow through the layered DataPlane: bind-mount
      // self-filters, exec-relay accepts them and runs the command inside the
      // container. PathPolicy is only the ro-mount write gate.
      assert.equal(runtime.paths.isAllowed('/workspace/../etc/passwd', 'read'), true)
    } finally {
      rmSync(hostRoot, { recursive: true, force: true })
    }
  })
})

describe('Runtime plane contract — RlaunchRuntime', () => {
  function makeConfig(workspaceHostPath: string): RlaunchRuntimeConfig {
    return {
      canonicalUser: 'alice',
      deploymentHash: 'abc12345',
      image: 'registry/x:tag',
      chargedGroup: 'hs_cpu',
      namespace: 'ailab-hs',
      cpu: 1,
      memoryMb: 1024,
      gpu: 0,
      privateMachine: 'group',
      positiveTags: [],
      workerGcTimeHours: 1,
      imagePullPolicy: 'IfNotPresent',
      maxWaitDuration: '5m',
      predictBeforeStart: false,
      workspaceHostPath,
      workspaceGpfsMount: 'gpfs://gpfs1/ns/u/alice:/workspace',
      workspaceContainerPath: '/workspace',
      env: {},
      daemonUid: 1000,
      daemonGid: 1000,
    }
  }

  it('satisfies the shared shape contract', () => {
    const hostRoot = mkdtempSync(path.join(tmpdir(), 'lc-contract-rlaunch-'))
    try {
      const tracker = new WorkerReadinessTracker('alice')
      const runtime = new RlaunchRuntime(makeConfig(hostRoot), tracker)
      assertContract(runtime, 'rlaunch')
      assert.equal(runtime.control.kind, 'brainctl-exec')
      // First layer is shared-cluster-fs; LayeredDataPlane.kind reflects it.
      assert.equal(runtime.data.kind, 'shared-cluster-fs')
      assert.equal(runtime.securityProfile, 'cluster-isolated')
      // Bug 1 invariant: brainctl-exec MUST advertise unreliable-large stdout.
      assert.equal(runtime.control.stdoutByteReliability, 'unreliable-large')
    } finally {
      rmSync(hostRoot, { recursive: true, force: true })
    }
  })

  it('PathPolicy maps workspace paths and rejects out-of-mount paths', () => {
    const hostRoot = mkdtempSync(path.join(tmpdir(), 'lc-contract-rlaunch-paths-'))
    try {
      const runtime = new RlaunchRuntime(makeConfig(hostRoot), new WorkerReadinessTracker('alice'))
      const inMount = runtime.paths.toHostPath('/workspace/.lightclaw/inbox/x.pdf')
      assert.equal(inMount, path.join(hostRoot, '.lightclaw', 'inbox', 'x.pdf'))
      assert.equal(runtime.paths.toHostPath('/etc/passwd'), null)
      assert.equal(runtime.paths.isShared('/workspace/.lightclaw/inbox/x.pdf'), true)
      assert.equal(runtime.paths.isShared('/etc/passwd'), false)
      assert.equal(runtime.paths.isAllowed('/workspace/x.pdf', 'write'), true)
      assert.equal(runtime.paths.isAllowed('/etc/passwd', 'read'), true)
      // PathPolicy is only the ro-mount write gate; out-of-mount and
      // post-normalize absolute paths flow through to exec-relay inside the
      // container. Sandbox isolation + permission system are the actual safety
      // boundary (CLAUDE.md "Runtime Safety Notes").
      assert.equal(runtime.paths.isAllowed('/workspace/../etc/passwd', 'read'), true)
    } finally {
      rmSync(hostRoot, { recursive: true, force: true })
    }
  })

  it('compatibility shim: runtime.fs.writeFileViaHostMount and readFileViaHostMount remain accessible', () => {
    const hostRoot = mkdtempSync(path.join(tmpdir(), 'lc-contract-rlaunch-shim-'))
    try {
      const runtime = new RlaunchRuntime(makeConfig(hostRoot), new WorkerReadinessTracker('alice'))
      // These are channel-encoder / materialize entry points; they must keep
      // working through the LayeredDataPlane shim even though LayeredDataPlane
      // itself doesn't expose them as native methods.
      assert.equal(typeof runtime.fs.writeFileViaHostMount, 'function')
      assert.equal(typeof runtime.fs.readFileViaHostMount, 'function')
    } finally {
      rmSync(hostRoot, { recursive: true, force: true })
    }
  })
})
