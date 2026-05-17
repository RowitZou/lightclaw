import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  evictAgedMemories,
  maybeEvictAgedMemories,
  shouldRunEviction,
} from './aging-eviction.js'

function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), 'lightclaw-aging-test-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

function writeMemoryFile(dir: string, name: string, body = 'body', mtimeMs?: number): string {
  const filePath = path.join(dir, name)
  const content = `---\nname: ${name}\ndescription: ${name} desc\ntype: user\n---\n\n${body}\n`
  writeFileSync(filePath, content, 'utf8')
  if (mtimeMs !== undefined) {
    const seconds = mtimeMs / 1000
    utimesSync(filePath, seconds, seconds)
  }
  return filePath
}

const DAY = 86_400_000
const NOW = 1_700_000_000_000

test('evictAgedMemories archives files older than archiveDays and rebuilds index', async () => {
  await withTmpDir(async dir => {
    writeMemoryFile(dir, 'fresh.md', 'fresh', NOW - 5 * DAY)
    writeMemoryFile(dir, 'old1.md', 'old', NOW - 200 * DAY)
    writeMemoryFile(dir, 'old2.md', 'old', NOW - 365 * DAY)

    const result = await evictAgedMemories(dir, { archiveDays: 180 }, NOW)
    assert.equal(result.archivedCount, 2)
    assert.deepEqual(result.archivedFilenames.sort(), ['old1.md', 'old2.md'])

    // Active dir keeps fresh.md only
    const archive = path.join(dir, 'archive')
    assert.ok(statSync(archive).isDirectory())
    assert.ok(statSync(path.join(archive, 'old1.md')).isFile())
    assert.ok(statSync(path.join(archive, 'old2.md')).isFile())
    assert.throws(() => statSync(path.join(dir, 'old1.md')))
    assert.throws(() => statSync(path.join(dir, 'old2.md')))
    assert.ok(statSync(path.join(dir, 'fresh.md')).isFile())

    // MEMORY.md only references fresh
    const index = readFileSync(path.join(dir, 'MEMORY.md'), 'utf8')
    assert.match(index, /fresh\.md/)
    assert.doesNotMatch(index, /old1\.md/)
    assert.doesNotMatch(index, /old2\.md/)
  })
})

test('evictAgedMemories is no-op when nothing is stale, but writes stamp', async () => {
  await withTmpDir(async dir => {
    writeMemoryFile(dir, 'a.md', 'a', NOW - 10 * DAY)

    const result = await evictAgedMemories(dir, { archiveDays: 180 }, NOW)
    assert.equal(result.archivedCount, 0)
    assert.throws(() => statSync(path.join(dir, 'archive', 'a.md')))
    // stamp file written even on no-op so the throttle wrapper reflects "ran"
    assert.ok(statSync(path.join(dir, '.last-eviction')).isFile())
  })
})

test('maybeEvictAgedMemories respects throttle window', async () => {
  await withTmpDir(async dir => {
    writeMemoryFile(dir, 'old.md', 'old', NOW - 365 * DAY)

    // First call: throttle file is missing → run.
    const first = await maybeEvictAgedMemories(dir, {
      archiveDays: 180,
      runIntervalMs: 24 * 60 * 60 * 1000,
    }, NOW)
    assert.notEqual(first, null)
    assert.equal(first!.archivedCount, 1)

    // Recreate the stale file (simulate a fresh extract right after) and
    // call again 1 hour later — should be skipped because <24h since stamp.
    writeMemoryFile(dir, 'old2.md', 'old', NOW - 200 * DAY)
    const skipped = await maybeEvictAgedMemories(dir, {
      archiveDays: 180,
      runIntervalMs: 24 * 60 * 60 * 1000,
    }, NOW + 60 * 60 * 1000)
    assert.equal(skipped, null, 'second call within throttle window must skip')
    // old2.md still in active dir
    assert.ok(statSync(path.join(dir, 'old2.md')).isFile())

    // Same call 25h after first stamp — runs again.
    const ran = await maybeEvictAgedMemories(dir, {
      archiveDays: 180,
      runIntervalMs: 24 * 60 * 60 * 1000,
    }, NOW + 25 * 60 * 60 * 1000)
    assert.notEqual(ran, null)
    assert.equal(ran!.archivedCount, 1)
  })
})

test('shouldRunEviction returns true when stamp is missing or unparseable', async () => {
  await withTmpDir(async dir => {
    assert.equal(await shouldRunEviction(dir, 1000), true)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, '.last-eviction'), 'not-a-number', 'utf8')
    assert.equal(await shouldRunEviction(dir, 1000), true)
  })
})

test('archive name collision picks a numeric suffix', async () => {
  await withTmpDir(async dir => {
    // First eviction archives stale.md
    writeMemoryFile(dir, 'stale.md', 'first', NOW - 365 * DAY)
    await evictAgedMemories(dir, { archiveDays: 180 }, NOW)
    assert.ok(statSync(path.join(dir, 'archive', 'stale.md')).isFile())

    // Same filename appears again, also stale (e.g. user re-extracted under
    // the same name months later, then it aged out again).
    writeMemoryFile(dir, 'stale.md', 'second', NOW - 365 * DAY)
    await evictAgedMemories(dir, { archiveDays: 180 }, NOW + DAY)

    // Original archive entry preserved + suffix added.
    assert.equal(readFileSync(path.join(dir, 'archive', 'stale.md'), 'utf8').includes('first'), true)
    assert.ok(statSync(path.join(dir, 'archive', 'stale.1.md')).isFile())
    assert.equal(
      readFileSync(path.join(dir, 'archive', 'stale.1.md'), 'utf8').includes('second'),
      true,
    )
  })
})

test('archive subdir is not re-scanned by scanMemoryFiles', async () => {
  // Belt-and-suspenders: scanMemoryFiles already filters to top-level
  // .md files via entry.isFile(), but make sure an archived file's
  // re-archive does not produce double-eviction. (Move stale stuff out,
  // re-run — second run sees nothing new in the active dir.)
  await withTmpDir(async dir => {
    writeMemoryFile(dir, 'old.md', 'old', NOW - 365 * DAY)
    const first = await evictAgedMemories(dir, { archiveDays: 180 }, NOW)
    assert.equal(first.archivedCount, 1)

    const second = await evictAgedMemories(dir, { archiveDays: 180 }, NOW + 30 * DAY)
    assert.equal(second.archivedCount, 0)
  })
})

test('evictAgedMemories archives stale L2 shared and L3 role-private files independently', async () => {
  await withTmpDir(async dir => {
    const sharedDir = path.join(dir, '_shared')
    const webDir = path.join(dir, 'webSearcher')
    mkdirSync(sharedDir, { recursive: true })
    mkdirSync(webDir, { recursive: true })

    // L1: one stale, one fresh
    writeMemoryFile(dir, 'l1-stale.md', 'l1 old', NOW - 365 * DAY)
    writeMemoryFile(dir, 'l1-fresh.md', 'l1 fresh', NOW - 5 * DAY)
    // L2 (_shared): stale only
    writeMemoryFile(sharedDir, 'shared-stale.md', 'shared old', NOW - 365 * DAY)
    // L3 (webSearcher/): stale + fresh
    writeMemoryFile(webDir, 'webSearcher-stale.md', 'webSearcher old', NOW - 200 * DAY)
    writeMemoryFile(webDir, 'webSearcher-fresh.md', 'webSearcher fresh', NOW - 10 * DAY)

    const result = await evictAgedMemories(dir, { archiveDays: 180 }, NOW)

    assert.equal(result.archivedCount, 3)
    assert.deepEqual(result.archivedFilenames.sort(), [
      '_shared/shared-stale.md',
      'l1-stale.md',
      'webSearcher/webSearcher-stale.md',
    ])

    // L1 archive holds the L1 stale
    assert.ok(statSync(path.join(dir, 'archive', 'l1-stale.md')).isFile())
    assert.throws(() => statSync(path.join(dir, 'l1-stale.md')))
    assert.ok(statSync(path.join(dir, 'l1-fresh.md')).isFile())

    // L2 per-tier archive co-located inside _shared/
    assert.ok(statSync(path.join(sharedDir, 'archive', 'shared-stale.md')).isFile())
    assert.throws(() => statSync(path.join(sharedDir, 'shared-stale.md')))

    // L3 per-tier archive co-located inside webSearcher/
    assert.ok(statSync(path.join(webDir, 'archive', 'webSearcher-stale.md')).isFile())
    assert.throws(() => statSync(path.join(webDir, 'webSearcher-stale.md')))
    assert.ok(statSync(path.join(webDir, 'webSearcher-fresh.md')).isFile())

    // Each tier's MEMORY.md is rebuilt independently — fresh entries kept,
    // stale entries dropped.
    const l1Index = readFileSync(path.join(dir, 'MEMORY.md'), 'utf8')
    assert.match(l1Index, /l1-fresh\.md/)
    assert.doesNotMatch(l1Index, /l1-stale\.md/)

    const sharedIndex = readFileSync(path.join(sharedDir, 'MEMORY.md'), 'utf8')
    assert.equal(sharedIndex.trim(), '')

    const webIndex = readFileSync(path.join(webDir, 'MEMORY.md'), 'utf8')
    assert.match(webIndex, /webSearcher-fresh\.md/)
    assert.doesNotMatch(webIndex, /webSearcher-stale\.md/)

    // L1's archive subdir is NOT itself enumerated as a tier — files inside
    // it must not be re-archived on a subsequent run.
    const second = await evictAgedMemories(dir, { archiveDays: 180 }, NOW + 30 * DAY)
    assert.equal(second.archivedCount, 0)
  })
})

test('evictAgedMemories writes the root stamp even when only sub-tiers had stale files', async () => {
  await withTmpDir(async dir => {
    const sharedDir = path.join(dir, '_shared')
    mkdirSync(sharedDir, { recursive: true })
    writeMemoryFile(sharedDir, 'shared-only.md', 'old', NOW - 365 * DAY)

    const result = await evictAgedMemories(dir, { archiveDays: 180 }, NOW)
    assert.equal(result.archivedCount, 1)

    // Root stamp present so the next throttle check honors this run, even
    // though L1 root had nothing stale to archive.
    assert.ok(statSync(path.join(dir, '.last-eviction')).isFile())
  })
})
