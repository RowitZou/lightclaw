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
