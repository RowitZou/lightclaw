import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { after, before, describe, it } from 'node:test'
import path from 'node:path'

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

describe('findShallowGpfsRoot symlink hardening', () => {
  // Real fs: the guard must judge the RESOLVED path, not the lexical one — a
  // lexically-deep symlink pointing at the mount root / a top-level share is
  // exactly the accidental whole-share reference the guard exists to refuse.
  let prefix: string
  let cfg: { gpfsMounts: { hostPrefix: string; mountPrefix: string }[] }

  before(() => {
    prefix = mkdtempSync(path.join(tmpdir(), 'gpfs-guard-'))
    cfg = { gpfsMounts: [{ hostPrefix: prefix, mountPrefix: 'gpfs://g' }] }
    mkdirSync(path.join(prefix, 'team', 'deep', 'proj'), { recursive: true })
    // depth-2 link that resolves to the mount root (depth 0)
    symlinkSync(prefix, path.join(prefix, 'team', 'link-to-root'))
    // depth-3 link that resolves to a top-level share (depth 1)
    symlinkSync(path.join(prefix, 'team'), path.join(prefix, 'team', 'deep', 'link-to-share'))
    // depth-2 link that resolves to a genuinely deep dir (depth 2)
    mkdirSync(path.join(prefix, 'a'))
    symlinkSync(path.join(prefix, 'team', 'deep'), path.join(prefix, 'a', 'deep-link'))
  })

  after(() => {
    rmSync(prefix, { recursive: true, force: true })
  })

  it('flags a lexically-deep symlink that resolves to the mount root', () => {
    assert.equal(findShallowGpfsRoot(path.join(prefix, 'team', 'link-to-root'), cfg), prefix)
  })

  it('flags a path that resolves to a top-level share through a mid-path symlink', () => {
    assert.equal(findShallowGpfsRoot(path.join(prefix, 'team', 'deep', 'link-to-share'), cfg), prefix)
  })

  it('allows a symlink that resolves to a deep-enough target', () => {
    assert.equal(findShallowGpfsRoot(path.join(prefix, 'a', 'deep-link'), cfg), null)
  })

  it('keeps the lexical verdict for a path that does not exist', () => {
    // Nonexistent paths cannot be resolved; the command layer's existence
    // probes after this guard reject them anyway.
    assert.equal(findShallowGpfsRoot(path.join(prefix, 'team', 'ghost', 'x'), cfg), null)
    assert.equal(findShallowGpfsRoot(path.join(prefix, 'ghost'), cfg), prefix)
  })
})
