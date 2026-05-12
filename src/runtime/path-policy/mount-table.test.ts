import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'

import { MountTablePathPolicy } from './mount-table.js'

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
