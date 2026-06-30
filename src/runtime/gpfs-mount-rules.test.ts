import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { findShallowGpfsRoot, MIN_GPFS_PATH_DEPTH } from './gpfs-mount-rules.js'

const settings = (...hostPrefixes: string[]) => ({
  gpfsMounts: hostPrefixes.map((hostPrefix, i) => ({ hostPrefix, mountPrefix: `gpfs://g${i}` })),
})

describe('findShallowGpfsRoot', () => {
  const cfg = settings('/mnt/shared-storage-user', '/mnt/shared-storage-gpfs2')

  it('flags the gpfs mount root itself (depth 0)', () => {
    assert.equal(findShallowGpfsRoot('/mnt/shared-storage-user', cfg), '/mnt/shared-storage-user')
  })

  it('flags a top-level shared dir (depth 1)', () => {
    assert.equal(findShallowGpfsRoot('/mnt/shared-storage-user/ailab-hs', cfg), '/mnt/shared-storage-user')
  })

  it('allows a per-user dir at MIN_GPFS_PATH_DEPTH (depth 2) or deeper', () => {
    assert.equal(MIN_GPFS_PATH_DEPTH, 2)
    assert.equal(findShallowGpfsRoot('/mnt/shared-storage-user/ailab-hs/zhangsan', cfg), null)
    assert.equal(findShallowGpfsRoot('/mnt/shared-storage-user/ailab-hs/zhangsan/proj', cfg), null)
  })

  it('matches the longest gpfs prefix when several apply', () => {
    // depth measured below the matched (gpfs2) prefix, not the other rule
    assert.equal(findShallowGpfsRoot('/mnt/shared-storage-gpfs2/share', cfg), '/mnt/shared-storage-gpfs2')
    assert.equal(findShallowGpfsRoot('/mnt/shared-storage-gpfs2/share/sub', cfg), null)
  })

  it('returns null for a path under no configured gpfs prefix', () => {
    // "must be under a prefix" is a separate validation's job; the depth guard
    // only refuses paths that ARE under a prefix but too shallow.
    assert.equal(findShallowGpfsRoot('/home/someone/work', cfg), null)
  })
})

describe('findShallowGpfsRoot per-rule minWorkspaceDepth', () => {
  const ruled = (hostPrefix: string, minWorkspaceDepth?: number) => ({
    gpfsMounts: [{ hostPrefix, mountPrefix: 'gpfs://g', ...(minWorkspaceDepth !== undefined ? { minWorkspaceDepth } : {}) }],
  })

  it('depth=1 refuses only the mount root, allows depth-1 dirs', () => {
    const cfg = ruled('/mnt/fs', 1)
    assert.equal(findShallowGpfsRoot('/mnt/fs', cfg), '/mnt/fs')
    assert.equal(findShallowGpfsRoot('/mnt/fs/person', cfg), null)
  })

  it('depth=3 refuses depth-2, allows depth-3', () => {
    const cfg = ruled('/mnt/fs', 3)
    assert.equal(findShallowGpfsRoot('/mnt/fs/org/team', cfg), '/mnt/fs')
    assert.equal(findShallowGpfsRoot('/mnt/fs/org/team/person', cfg), null)
  })

  it('depth=0 disables the guard for that prefix (even the mount root passes)', () => {
    const cfg = ruled('/mnt/fs', 0)
    assert.equal(findShallowGpfsRoot('/mnt/fs', cfg), null)
  })

  it('omitting the field falls back to MIN_GPFS_PATH_DEPTH (2)', () => {
    const cfg = ruled('/mnt/fs')
    assert.equal(findShallowGpfsRoot('/mnt/fs/team', cfg), '/mnt/fs')
    assert.equal(findShallowGpfsRoot('/mnt/fs/team/person', cfg), null)
  })

  it('each rule carries its own depth floor independently', () => {
    const cfg = {
      gpfsMounts: [
        { hostPrefix: '/mnt/a', mountPrefix: 'gpfs://a', minWorkspaceDepth: 1 },
        { hostPrefix: '/mnt/b', mountPrefix: 'gpfs://b', minWorkspaceDepth: 3 },
      ],
    }
    assert.equal(findShallowGpfsRoot('/mnt/a/x', cfg), null) // depth 1 ok under floor 1
    assert.equal(findShallowGpfsRoot('/mnt/b/x/y', cfg), '/mnt/b') // depth 2 under floor 3
  })
})
