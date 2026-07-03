import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, describe, test } from 'node:test'

import {
  ACTIVE_DIST_DIR,
  PREVIOUS_DIST_DIR,
  STAGED_DIST_DIR,
  promoteStagedDist,
} from './staged-dist.js'

describe('promoteStagedDist', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'lightclaw-staged-dist-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function writeBuild(dirName: string, marker: string): void {
    const dir = path.join(root, dirName)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'cli.js'), marker)
  }

  function readMarker(dirName: string): string {
    return readFileSync(path.join(root, dirName, 'cli.js'), 'utf8')
  }

  test('promotes dist.next → dist and parks the old dist as dist.prev', () => {
    writeBuild(ACTIVE_DIST_DIR, 'old-build')
    writeBuild(STAGED_DIST_DIR, 'new-build')

    const result = promoteStagedDist(root)

    assert.deepEqual(result, { promoted: true })
    assert.equal(readMarker(ACTIVE_DIST_DIR), 'new-build')
    assert.equal(readMarker(PREVIOUS_DIST_DIR), 'old-build')
    assert.equal(existsSync(path.join(root, STAGED_DIST_DIR)), false)
  })

  test('no staged build is a no-op that leaves the live dist untouched', () => {
    writeBuild(ACTIVE_DIST_DIR, 'old-build')

    const result = promoteStagedDist(root)

    assert.deepEqual(result, { promoted: false, reason: 'no-staged-build' })
    assert.equal(readMarker(ACTIVE_DIST_DIR), 'old-build')
    assert.equal(existsSync(path.join(root, PREVIOUS_DIST_DIR)), false)
  })

  test('a stale dist.prev from an earlier update is replaced, not merged', () => {
    writeBuild(ACTIVE_DIST_DIR, 'old-build')
    writeBuild(STAGED_DIST_DIR, 'new-build')
    writeBuild(PREVIOUS_DIST_DIR, 'ancient-build')
    // A file that only exists in the stale prev — must not survive the swap
    // (renameSync onto an existing dir would fail; rm-then-rename must fully
    // replace, never merge).
    writeFileSync(path.join(root, PREVIOUS_DIST_DIR, 'stale-chunk.js'), 'stale')

    const result = promoteStagedDist(root)

    assert.deepEqual(result, { promoted: true })
    assert.equal(readMarker(ACTIVE_DIST_DIR), 'new-build')
    assert.equal(readMarker(PREVIOUS_DIST_DIR), 'old-build')
    assert.equal(existsSync(path.join(root, PREVIOUS_DIST_DIR, 'stale-chunk.js')), false)
  })

  test('missing dist (crash between the two renames) still promotes the staged build', () => {
    writeBuild(STAGED_DIST_DIR, 'new-build')

    const result = promoteStagedDist(root)

    assert.deepEqual(result, { promoted: true })
    assert.equal(readMarker(ACTIVE_DIST_DIR), 'new-build')
    assert.equal(existsSync(path.join(root, PREVIOUS_DIST_DIR)), false)
  })
})
