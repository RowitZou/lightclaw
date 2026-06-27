import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import path from 'node:path'

import { assertMountsAccessible, MountTablePathPolicy } from './mount-table.js'

test('MountTablePathPolicy maps worker paths to host paths and back', () => {
  const policy = new MountTablePathPolicy([
    { host: '/host/workspace/alice', worker: '/workspace', mode: 'rw' },
  ])

  assert.equal(
    policy.toHostPath('/workspace/nested/file.txt'),
    path.join('/host/workspace/alice', 'nested', 'file.txt'),
  )
  assert.equal(
    policy.toWorkerPath('/host/workspace/alice/nested/file.txt'),
    '/workspace/nested/file.txt',
  )
})

test('MountTablePathPolicy rejects writes to read-only mounts only', () => {
  const policy = new MountTablePathPolicy([
    { host: '/host/workspace/alice', worker: '/workspace', mode: 'rw' },
    { host: '/host/ro', worker: '/opt/ro', mode: 'ro' },
  ])

  // Phase 33 isAllowed only guards ro-mount writes. Traversal escapes the
  // mount and is left to each backend's toContainerPath to reject — that
  // path preserves the legacy "Path is not within ... workspace" error text.
  assert.equal(policy.isAllowed('/opt/ro/file.txt', 'write'), false)
  assert.equal(policy.isAllowed('/opt/ro/file.txt', 'read'), true)
  assert.equal(policy.isAllowed('/opt/ro/file.txt', 'stat'), true)
  assert.equal(policy.isAllowed('/workspace/file.txt', 'write'), true)
  // Traversal is intentionally NOT pre-empted at the policy layer; it falls
  // through to the layer's toContainerPath natural error.
  assert.equal(policy.isAllowed('/workspace/../etc/passwd', 'read'), true)
  assert.equal(policy.isAllowed('/workspace/../etc/passwd', 'write'), true)
})

test('MountTablePathPolicy leaves out-of-mount paths for exec-relay', () => {
  const policy = new MountTablePathPolicy([
    { host: '/host/workspace/alice', worker: '/workspace', mode: 'rw' },
  ])

  assert.equal(policy.toHostPath('/etc/passwd'), null)
  assert.equal(policy.isShared('/etc/passwd'), false)
  assert.equal(policy.isAllowed('/etc/passwd', 'read'), true)
  assert.equal(policy.isAllowed('/etc/passwd', 'write'), true)
})

test('MountTablePathPolicy rejects overlapping mount entries', () => {
  assert.throws(
    () => new MountTablePathPolicy([
      { host: '/host/workspace', worker: '/workspace', mode: 'rw' },
      { host: '/host/workspace/nested', worker: '/nested', mode: 'rw' },
    ]),
    /Overlapping runtime mount entries/,
  )
})

test('assertMountsAccessible passes for reachable rw mount', async () => {
  const hostRoot = mkdtempSync(path.join(tmpdir(), 'lc-mount-probe-ok-'))
  try {
    const policy = new MountTablePathPolicy([
      { host: hostRoot, worker: '/workspace', mode: 'rw' },
    ])
    await assertMountsAccessible(policy, 'docker')
  } finally {
    rmSync(hostRoot, { recursive: true, force: true })
  }
})

test('assertMountsAccessible passes for reachable ro mount with only R_OK', async () => {
  const hostRoot = mkdtempSync(path.join(tmpdir(), 'lc-mount-probe-ro-'))
  try {
    // Restrict to read+execute so W_OK fails — probe should still pass because
    // the mount is declared ro and we only require R_OK in that case.
    chmodSync(hostRoot, 0o555)
    const policy = new MountTablePathPolicy([
      { host: hostRoot, worker: '/opt/ro', mode: 'ro' },
    ])
    await assertMountsAccessible(policy, 'docker')
  } finally {
    // Restore writable mode so rmSync can clean up.
    chmodSync(hostRoot, 0o700)
    rmSync(hostRoot, { recursive: true, force: true })
  }
})

test('assertMountsAccessible throws on missing mount entry with admin-friendly message', async () => {
  const missingPath = path.join(tmpdir(), `lc-mount-probe-missing-${Date.now()}`)
  const policy = new MountTablePathPolicy([
    { host: missingPath, worker: '/workspace', mode: 'rw' },
  ])
  await assert.rejects(
    () => assertMountsAccessible(policy, 'docker'),
    (err: unknown) => {
      if (!(err instanceof Error)) return false
      assert.match(err.message, /\[docker\] runtime mount \/workspace/)
      assert.match(err.message, /ENOENT/)
      assert.match(err.message, /mode=rw/)
      assert.match(err.message, /runtime\.docker\.mounts/)
      return true
    },
  )
})

test('assertMountsAccessible throws on rw mount that lacks W_OK', async () => {
  // Skip when running as root (W_OK always succeeds) — covered on CI runners
  // with unprivileged uid; locally root invocations exit early without
  // weakening the test elsewhere.
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return
  }
  const hostRoot = mkdtempSync(path.join(tmpdir(), 'lc-mount-probe-ro-as-rw-'))
  try {
    chmodSync(hostRoot, 0o555)
    const policy = new MountTablePathPolicy([
      { host: hostRoot, worker: '/workspace', mode: 'rw' },
    ])
    await assert.rejects(
      () => assertMountsAccessible(policy, 'rlaunch'),
      (err: unknown) => {
        if (!(err instanceof Error)) return false
        assert.match(err.message, /\[rlaunch\] runtime mount/)
        assert.match(err.message, /mode=rw/)
        assert.match(err.message, /EACCES|EPERM/)
        return true
      },
    )
  } finally {
    chmodSync(hostRoot, 0o700)
    rmSync(hostRoot, { recursive: true, force: true })
  }
})

test('assertMountsAccessible is a no-op for empty mount table (LocalRuntime case)', async () => {
  const policy = new MountTablePathPolicy([])
  await assertMountsAccessible(policy, 'local')
})

test('daemon-invisible mounts do not resolve to host paths and skip startup probes', async () => {
  const policy = new MountTablePathPolicy([{
    host: '/definitely/not/mounted/on/daemon',
    worker: '/datasets/private',
    mode: 'ro',
    daemonVisible: false,
  } as import('../types.js').MountEntry])

  assert.equal(policy.toHostPath('/datasets/private/file.txt'), null)
  assert.equal(policy.isShared('/datasets/private/file.txt'), false)
  await assertMountsAccessible(policy, 'rlaunch')
})
