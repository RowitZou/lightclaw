import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { utimes } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'

import type { Role } from '../../agents/types.js'
import type { RunSubagentResult } from '../../agents/run-subagent.js'
type SubagentResult = RunSubagentResult
import type { LightClawConfig } from '../../config.js'
import { userSkillsRoot } from '../../identity/paths.js'
import { createSessionContext, runWithSessionContext } from '../../session-context.js'
import { memoryDeleteTool } from '../../tools/memory-delete.js'
import { memoryMoveTool } from '../../tools/memory-move.js'
import { memoryWriteAtTool } from '../../tools/memory-write-at.js'
import { writeMemoryFile } from '../auto-memory.js'
import {
  _triggerExtractSettledForTest,
  setExtractionInProgressForTest,
} from '../extract.js'
import { consolidationLockPath, readSubTaskLastSuccess } from './lock.js'
import { buildDreamPrompt, gatherDreamMemoryTree } from './prompt.js'
import {
  drainPendingDream,
  executeAutoDream,
  getAutoDreamInFlightCountForTest,
  getAutoDreamPendingCountForTest,
  resetAutoDreamStateForTest,
  setRunSubagentForTest,
} from './dream.js'

let tmpRoot: string
let tmpSessionsDir: string
let tmpMemoryDir: string
let savedSessionsDir: string | undefined

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'lightclaw-dream-test-'))
  tmpSessionsDir = path.join(tmpRoot, 'sessions')
  tmpMemoryDir = path.join(tmpRoot, 'memory', 'alice')
  savedSessionsDir = process.env.LIGHTCLAW_SESSIONS_DIR
  process.env.LIGHTCLAW_SESSIONS_DIR = tmpSessionsDir
  resetAutoDreamStateForTest()
  setRunSubagentForTest(null)
})

afterEach(() => {
  if (savedSessionsDir === undefined) {
    delete process.env.LIGHTCLAW_SESSIONS_DIR
  } else {
    process.env.LIGHTCLAW_SESSIONS_DIR = savedSessionsDir
  }
  resetAutoDreamStateForTest()
  setRunSubagentForTest(null)
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('autoDream runner', () => {
  it('builds a runtime-context consolidation prompt that defers workflow to the system prompt', () => {
    const prompt = buildDreamPrompt({
      memoryDir: '/memory/alice',
      transcriptDir: '/sessions',
      sessionIds: ['s1', 's2'],
      memoryTree: {
        root: {
          label: 'user-level root',
          relativeDir: '.',
          entries: [memoryEntry('root-note.md', 'Root note')],
        },
        shared: {
          label: 'shared workboard',
          relativeDir: '_shared',
          entries: [memoryEntry('shared-note.md', 'Shared note')],
        },
        roleDirs: [
          {
            label: 'role-private: webSearcher',
            relativeDir: 'webSearcher',
            entries: [memoryEntry('finding.md', 'Web finding')],
          },
        ],
      },
    })
    assert.match(prompt, /Dream: User Memory Consolidation/)
    assert.match(prompt, /## Current Memory Tree/)
    assert.match(prompt, /root-note\.md: Root note/)
    assert.match(prompt, /_shared\/shared-note\.md: Shared note/)
    assert.match(prompt, /webSearcher\/finding\.md: Web finding/)
    assert.match(prompt, /s1/)
    // No competing workflow or duplicate MEMORY.md hard rule — both live in
    // the memoryCurator system prompt (Phase 2 PR2 v3). User message provides
    // runtime context only.
    assert.doesNotMatch(prompt, /## Workflow/)
    assert.doesNotMatch(prompt, /MEMORY\.md.*framework-managed/i)
    assert.doesNotMatch(prompt, /Bash/)
    assert.doesNotMatch(prompt, /grep -n/)
  })

  it('excludes the archive subdirectory from the role-private listing', async () => {
    // aging-eviction creates `<memoryDir>/archive/` at L1 (and `<tier>/archive/`
    // at L2/L3) to hold evicted memory files. autoDream must NOT see archive
    // as a role-private tier, otherwise it would try to consolidate / promote
    // already-archived entries.
    await writeMemoryFile(tmpMemoryDir, memoryEntry('root-only.md', 'Root only'))
    mkdirSync(path.join(tmpMemoryDir, 'archive'), { recursive: true })
    writeFileSync(
      path.join(tmpMemoryDir, 'archive', 'aged-out.md'),
      '---\nname: aged-out.md\ndescription: archived\ntype: project\n---\n\nbody\n',
      'utf8',
    )

    const tree = await gatherDreamMemoryTree(tmpMemoryDir)
    assert.deepEqual(tree.roleDirs, [])
    const prompt = buildDreamPrompt({
      memoryDir: tmpMemoryDir,
      transcriptDir: tmpSessionsDir,
      sessionIds: [],
      memoryTree: tree,
    })
    assert.doesNotMatch(prompt, /archive\//)
    assert.doesNotMatch(prompt, /aged-out\.md/)
  })

  it('does nothing when autoDream is disabled', async () => {
    await executeAutoDream({
      userId: 'alice',
      memoryDir: tmpMemoryDir,
      currentSessionId: 'current',
      config: dreamConfig({ enabled: false }),
    })
    assert.equal(existsSync(tmpMemoryDir), false)
    assert.equal(getAutoDreamInFlightCountForTest(), 0)
  })

  it('does nothing when autoMemory is disabled', async () => {
    await executeAutoDream({
      userId: 'alice',
      memoryDir: tmpMemoryDir,
      currentSessionId: 'current',
      config: dreamConfig({ enabled: true }, { memory: { extractor: { enabled: false } } as LightClawConfig['memory'] }),
    })
    assert.equal(existsSync(tmpMemoryDir), false)
  })
  it('does not count the current session toward the session gate', async () => {
    writeSession('current', 'alice', Date.now())
    writeSession('old-1', 'alice', Date.now() + 1)

    let forkInvoked = false
    setRunSubagentForTest(async () => {
      forkInvoked = true
      return fakeForkResult()
    })

    await executeAutoDream({
      userId: 'alice',
      memoryDir: tmpMemoryDir,
      currentSessionId: 'current',
      config: dreamConfig({ enabled: true, minHours: 0, minSessions: 2 }),
    })

    assert.equal(forkInvoked, false)
    assert.equal(existsSync(consolidationLockPath(tmpMemoryDir)), false)
  })

  it('skips when last consolidation is within minHours', async () => {
    writeSession('s1', 'alice', Date.now())
    writeSession('s2', 'alice', Date.now() + 1)
    writeSession('s3', 'alice', Date.now() + 2)

    // Seed lock with all sub-tasks recently succeeded → minHours bails every
    // sub-task and the outer gate returns without acquiring.
    mkdirSync(tmpMemoryDir, { recursive: true })
    const now = Date.now()
    writeFileSync(
      consolidationLockPath(tmpMemoryDir),
      JSON.stringify({
        subTasks: {
          memoryCurator: now,
          skillCurator: now,
          skillConsolidator: now,
          skillAging: now,
        },
      }) + '\n',
    )

    let forkInvoked = false
    setRunSubagentForTest(async () => {
      forkInvoked = true
      return fakeForkResult()
    })

    await executeAutoDream({
      userId: 'alice',
      memoryDir: tmpMemoryDir,
      currentSessionId: 'current',
      config: dreamConfig({ enabled: true, minHours: 24, minSessions: 1 }),
    })

    assert.equal(forkInvoked, false)
  })

  it('runs despite minHours when a memory-file burst is detected', async () => {
    writeSession('s1', 'alice', Date.now())

    mkdirSync(tmpMemoryDir, { recursive: true })
    // All three sub-tasks last succeeded 2h ago — within the 24h minHours
    // window, and stale enough (older than the 1h lock-holder window) that
    // the lock is re-acquirable once the burst bypass lets execution reach
    // it.
    const lockPath = consolidationLockPath(tmpMemoryDir)
    const twoHoursAgoMs = Date.now() - 2 * 3600 * 1000
    writeFileSync(
      lockPath,
      JSON.stringify({
        subTasks: {
          memoryCurator: twoHoursAgoMs,
          skillCurator: twoHoursAgoMs,
          skillConsolidator: twoHoursAgoMs,
          skillAging: twoHoursAgoMs,
        },
      }) + '\n',
    )
    const twoHoursAgoSec = twoHoursAgoMs / 1000
    await utimes(lockPath, twoHoursAgoSec, twoHoursAgoSec)

    // Four memory files written just now — all newer than lastConsolidatedAt.
    for (let index = 0; index < 4; index += 1) {
      await writeMemoryFile(
        tmpMemoryDir,
        memoryEntry(`burst-note-${index}.md`, `burst note ${index}`),
      )
    }

    let forkInvoked = false
    setRunSubagentForTest(async () => {
      forkInvoked = true
      return fakeForkResult()
    })

    await executeAutoDream({
      userId: 'alice',
      memoryDir: tmpMemoryDir,
      currentSessionId: 'current',
      config: dreamConfig({
        enabled: true,
        minHours: 24,
        minSessions: 1,
        burstFileThreshold: 3,
      }),
    })

    assert.equal(forkInvoked, true)
  })

  it('skips when scan throttle is active', async () => {
    setRunSubagentForTest(async () => fakeForkResult())

    writeSession('s1', 'alice', Date.now())
    await executeAutoDream({
      userId: 'alice',
      memoryDir: tmpMemoryDir,
      currentSessionId: 'current',
      config: dreamConfig({
        enabled: true,
        minHours: 0,
        minSessions: 5,
        scanThrottleMs: 60_000,
      }),
    })

    for (let index = 0; index < 5; index += 1) {
      writeSession(`s${index + 2}`, 'alice', Date.now() + index)
    }

    let forkInvoked = false
    setRunSubagentForTest(async () => {
      forkInvoked = true
      return fakeForkResult()
    })

    await executeAutoDream({
      userId: 'alice',
      memoryDir: tmpMemoryDir,
      currentSessionId: 'current',
      config: dreamConfig({
        enabled: true,
        minHours: 0,
        minSessions: 5,
        scanThrottleMs: 60_000,
      }),
    })

    assert.equal(forkInvoked, false)
  })

  it('skips when an extraction for the same memoryDir is in progress', async () => {
    setExtractionInProgressForTest(tmpMemoryDir, true)
    try {
      writeSession('s1', 'alice', Date.now())
      writeSession('s2', 'alice', Date.now() + 1)
      writeSession('s3', 'alice', Date.now() + 2)

      let forkInvoked = false
      setRunSubagentForTest(async () => {
        forkInvoked = true
        return fakeForkResult()
      })

      await executeAutoDream({
        userId: 'alice',
        memoryDir: tmpMemoryDir,
        currentSessionId: 'current',
        config: dreamConfig({ enabled: true, minHours: 0, minSessions: 2 }),
      })

      assert.equal(forkInvoked, false)
      assert.equal(existsSync(consolidationLockPath(tmpMemoryDir)), false)
      // Bail stashes a pending entry for the retry hook to pick up when
      // extract settles.
      assert.equal(getAutoDreamPendingCountForTest(), 1)
    } finally {
      setExtractionInProgressForTest(tmpMemoryDir, false)
    }
  })

  it('retries pending dream when extract settles for the same memoryDir', async () => {
    setExtractionInProgressForTest(tmpMemoryDir, true)
    writeSession('s1', 'alice', Date.now())
    writeSession('s2', 'alice', Date.now() + 1)
    writeSession('s3', 'alice', Date.now() + 2)

    let forkInvocations = 0
    setRunSubagentForTest(async () => {
      forkInvocations += 1
      return fakeForkResult()
    })

    // First attempt bails on outer gate (extract in-progress), stashes pending.
    await executeAutoDream({
      userId: 'alice',
      memoryDir: tmpMemoryDir,
      currentSessionId: 'current',
      config: dreamConfig({ enabled: true, minHours: 0, minSessions: 2 }),
    })
    assert.equal(forkInvocations, 0)
    assert.equal(getAutoDreamPendingCountForTest(), 1)

    // Simulate extract clearing its key and notifying subscribers. Drop the
    // in-progress flag first so the dream retry's outer gate passes; then
    // emit the settle event so the retry actually fires.
    setExtractionInProgressForTest(tmpMemoryDir, false)
    _triggerExtractSettledForTest(tmpMemoryDir)

    // Retry is fire-and-forget; let the in-flight dream resolve before asserting.
    await drainPendingDream(5_000)
    assert.equal(forkInvocations, 2)
    assert.equal(getAutoDreamPendingCountForTest(), 0)
    assert.equal(getAutoDreamInFlightCountForTest(), 0)
  })

  it('extract-settled retry skips when another role is still extracting', async () => {
    setExtractionInProgressForTest(tmpMemoryDir, true)
    writeSession('s1', 'alice', Date.now())
    writeSession('s2', 'alice', Date.now() + 1)
    writeSession('s3', 'alice', Date.now() + 2)

    let forkInvocations = 0
    setRunSubagentForTest(async () => {
      forkInvocations += 1
      return fakeForkResult()
    })

    // Stash pending.
    await executeAutoDream({
      userId: 'alice',
      memoryDir: tmpMemoryDir,
      currentSessionId: 'current',
      config: dreamConfig({ enabled: true, minHours: 0, minSessions: 2 }),
    })
    assert.equal(getAutoDreamPendingCountForTest(), 1)

    // Emit settle while in-progress flag is STILL set (simulates one of N
    // concurrent extracts finishing while others continue). Retry should
    // bail at outer gate again and keep the pending entry.
    _triggerExtractSettledForTest(tmpMemoryDir)
    await drainPendingDream(1_000)
    assert.equal(forkInvocations, 0)
    assert.equal(getAutoDreamPendingCountForTest(), 1)

    // Cleanup.
    setExtractionInProgressForTest(tmpMemoryDir, false)
  })

  it('does not skip when an extraction for a different memoryDir is in progress', async () => {
    const otherDir = path.join(tmpRoot, 'memory', 'bob')
    setExtractionInProgressForTest(otherDir, true)
    try {
      writeSession('s1', 'alice', Date.now())
      writeSession('s2', 'alice', Date.now() + 1)

      let forkInvoked = false
      setRunSubagentForTest(async () => {
        forkInvoked = true
        return fakeForkResult()
      })

      await executeAutoDream({
        userId: 'alice',
        memoryDir: tmpMemoryDir,
        currentSessionId: 'current',
        config: dreamConfig({ enabled: true, minHours: 0, minSessions: 2 }),
      })

      assert.equal(forkInvoked, true)
    } finally {
      setExtractionInProgressForTest(otherDir, false)
    }
  })

  it('runs the fork and marks every sub-task succeeded when all gates pass', async () => {
    writeSession('s1', 'alice', Date.now())
    writeSession('s2', 'alice', Date.now() + 1)

    let forkInvocations = 0
    setRunSubagentForTest(async () => {
      forkInvocations += 1
      return fakeForkResult()
    })

    await executeAutoDream({
      userId: 'alice',
      memoryDir: tmpMemoryDir,
      currentSessionId: 'current',
      config: dreamConfig({ enabled: true, minHours: 0, minSessions: 2 }),
    })

    // memoryCurator + skillConsolidator both ran (no fork transcripts → no
    // skillCurator pass, but the no-op still marks lastSuccessAt).
    assert.equal(forkInvocations, 2)
    assert.equal(existsSync(consolidationLockPath(tmpMemoryDir)), true)
    assert.ok(await readSubTaskLastSuccess(tmpMemoryDir, 'memoryCurator') > 0)
    assert.ok(await readSubTaskLastSuccess(tmpMemoryDir, 'skillCurator') > 0)
    assert.ok(await readSubTaskLastSuccess(tmpMemoryDir, 'skillConsolidator') > 0)
  })

  it('re-runs only skillConsolidator on the next cycle when it failed and memoryCurator succeeded (Bug 1a regression)', async () => {
    // 2026-05-27 dogfood Bug 1a: skillConsolidator tripped the codex 35s
    // TTFB watchdog on a 100K+ input. Pre-PR1 the lock was a single mtime,
    // so memoryCurator's success advanced it past minHours and
    // skillConsolidator never got a retry — `[auto-dream]
    // skillConsolidator failed` printed once and the sub-task stayed at 0
    // successes for the rest of the daemon's lifetime.
    writeSession('s1', 'alice', Date.now())
    writeSession('s2', 'alice', Date.now() + 1)

    // First cycle: memoryCurator + skillCurator no-op succeed,
    // skillConsolidator returns WorkerFailure (the same envelope shape
    // runSubagent returns on a TTFB abort).
    setRunSubagentForTest(async input => {
      if (input.agentType === 'skillConsolidator') {
        return {
          kind: 'failure',
          envelope: {
            status: 'failed',
            reason: 'other',
            message: 'stream idle > 35000ms (ttfb)',
          },
        }
      }
      return fakeForkResult()
    })
    await executeAutoDream({
      userId: 'alice',
      memoryDir: tmpMemoryDir,
      currentSessionId: 'current',
      config: dreamConfig({
        enabled: true,
        minHours: 6,
        minSessions: 1,
        scanThrottleMs: 0,
      }),
    })
    assert.ok(await readSubTaskLastSuccess(tmpMemoryDir, 'memoryCurator') > 0)
    assert.ok(await readSubTaskLastSuccess(tmpMemoryDir, 'skillCurator') > 0)
    assert.equal(await readSubTaskLastSuccess(tmpMemoryDir, 'skillConsolidator'), 0)

    // Reset the per-process scan throttle so the second cycle's gates run
    // afresh (production behavior: each turn-end hook is a fresh call).
    resetAutoDreamStateForTest()

    // Second cycle (within minHours=6 of first): only skillConsolidator is
    // due. memoryCurator + skillCurator must be skipped; skillConsolidator
    // must be attempted again.
    const calls2: string[] = []
    setRunSubagentForTest(async input => {
      calls2.push(String(input.agentType))
      return fakeForkResult()
    })
    await executeAutoDream({
      userId: 'alice',
      memoryDir: tmpMemoryDir,
      currentSessionId: 'current',
      config: dreamConfig({
        enabled: true,
        minHours: 6,
        minSessions: 1,
        scanThrottleMs: 0,
      }),
    })
    // PRE-PR1: minHours sees a recent lock mtime, outer gate bails →
    // calls2 stays [] → assertion fails.
    // POST-PR1: memoryCurator + skillCurator within minHours and skipped;
    // skillConsolidator never recorded success so it runs.
    assert.deepEqual(calls2, ['skillConsolidator'])
    assert.ok(await readSubTaskLastSuccess(tmpMemoryDir, 'skillConsolidator') > 0)
  })

  it('runs deterministic skillAging under the lock and archives stale user skills', async () => {
    const prevHome = process.env.LIGHTCLAW_HOME
    process.env.LIGHTCLAW_HOME = tmpRoot
    try {
      writeSession('s1', 'alice', Date.now())
      writeSession('s2', 'alice', Date.now() + 1)

      // A stale per-user skill: SKILL.md mtime 100 days old, no last_used_at,
      // so skillAging's default 90d archive window catches it.
      const skillsRoot = userSkillsRoot('alice')
      const staleDir = path.join(skillsRoot, 'stale-skill')
      mkdirSync(staleDir, { recursive: true })
      const staleFile = path.join(staleDir, 'SKILL.md')
      writeFileSync(
        staleFile,
        '---\nname: stale-skill\ndescription: old flow.\nroles:\n  - coder\n---\n\nBody.\n',
        'utf8',
      )
      const oldSec = (Date.now() - 100 * 86_400_000) / 1000
      await utimes(staleFile, oldSec, oldSec)

      setRunSubagentForTest(async () => fakeForkResult())

      await executeAutoDream({
        userId: 'alice',
        memoryDir: tmpMemoryDir,
        currentSessionId: 'current',
        config: dreamConfig({ enabled: true, minHours: 0, minSessions: 2 }),
      })

      // Archived out of the active set, and the skillAging sub-task recorded.
      assert.equal(existsSync(path.join(skillsRoot, 'stale-skill')), false)
      assert.equal(
        existsSync(path.join(skillsRoot, '_archive', 'stale-skill', 'SKILL.md')),
        true,
      )
      assert.ok(await readSubTaskLastSuccess(tmpMemoryDir, 'skillAging') > 0)
    } finally {
      if (prevHome === undefined) {
        delete process.env.LIGHTCLAW_HOME
      } else {
        process.env.LIGHTCLAW_HOME = prevHome
      }
    }
  })

  it('passes a full user memory tree manifest to a single autoDream fork', async () => {
    writeSession('s1', 'alice', Date.now())
    writeSession('s2', 'alice', Date.now() + 1)
    await seedMemoryTree()

    let forkInvocations = 0
    let prompt = ''
    setRunSubagentForTest(async input => {
      forkInvocations += 1
      if (input.agentType === 'memoryCurator') {
        prompt = input.prompt
      }
      return fakeForkResult()
    })

    await executeAutoDream({
      userId: 'alice',
      memoryDir: tmpMemoryDir,
      currentSessionId: 'current',
      config: dreamConfig({ enabled: true, minHours: 0, minSessions: 2 }),
    })

    assert.equal(forkInvocations, 2)
    assert.match(prompt, /root-note\.md: root-note description/)
    assert.match(prompt, /_shared\/shared-note\.md: shared-note description/)
    assert.match(prompt, /webSearcher\/webSearcher-note\.md: webSearcher-note description/)
  })

  it('runs per-role skillCurator for new fork transcripts, then skillConsolidator', async () => {
    writeSession('s1', 'alice', Date.now())
    writeSession('s2', 'alice', Date.now() + 1)
    writeForkTranscript('s1', 'coder', 'abc123')

    const calls: Array<{ agentType: string; prompt: string }> = []
    setRunSubagentForTest(async input => {
      calls.push({ agentType: String(input.agentType), prompt: input.prompt })
      return fakeForkResult()
    })

    await executeAutoDream({
      userId: 'alice',
      memoryDir: tmpMemoryDir,
      currentSessionId: 'current',
      config: dreamConfig({ enabled: true, minHours: 0, minSessions: 2 }),
    })

    assert.deepEqual(calls.map(call => call.agentType), [
      'memoryCurator',
      'skillCurator',
      'skillConsolidator',
    ])
    assert.match(calls[1]?.prompt ?? '', /Target role: `coder`/)
    assert.match(calls[1]?.prompt ?? '', /coder-abc123\.jsonl/)
    assert.match(calls[1]?.prompt ?? '', /## Skills Currently Visible To This Role/)
    assert.match(calls[2]?.prompt ?? '', /# Dream: Skill Consolidation/)
  })

  it('isolates skillCurator failure and still runs skillConsolidator', async () => {
    writeSession('s1', 'alice', Date.now())
    writeSession('s2', 'alice', Date.now() + 1)
    writeForkTranscript('s1', 'coder', 'abc123')

    const calls: string[] = []
    setRunSubagentForTest(async input => {
      calls.push(String(input.agentType))
      if (input.agentType === 'skillCurator') {
        throw new Error('skill curator blew up')
      }
      return fakeForkResult()
    })

    await executeAutoDream({
      userId: 'alice',
      memoryDir: tmpMemoryDir,
      currentSessionId: 'current',
      config: dreamConfig({ enabled: true, minHours: 0, minSessions: 2 }),
    })

    assert.deepEqual(calls, ['memoryCurator', 'skillCurator', 'skillConsolidator'])
  })

  it('lists only existing shared and role-private sections in the memory tree', async () => {
    await writeMemoryFile(tmpMemoryDir, memoryEntry('root-only.md', 'Root only'))

    const tree = await gatherDreamMemoryTree(tmpMemoryDir)
    const prompt = buildDreamPrompt({
      memoryDir: tmpMemoryDir,
      transcriptDir: tmpSessionsDir,
      sessionIds: [],
      memoryTree: tree,
    })

    assert.match(prompt, /root-only\.md: Root only/)
    assert.match(prompt, /shared workboard \(_shared\/\)\n- \[not present\]/)
    assert.match(prompt, /role-private directories\n- \[none\]/)
  })

  it('promotes role-private memories through the autoDream tool family and rebuilds indexes', async () => {
    await writeMemoryFile(path.join(tmpMemoryDir, 'webSearcher'), memoryEntry('finding-x.md', 'Web finding'))

    const moved = await withAutoDreamSession(() =>
      memoryMoveTool.call({
        from: 'webSearcher/finding-x.md',
        to: '_shared/2026-05-16-finding-x-by-webSearcher.md',
      }, undefined as never),
    )
    assert.equal(moved.isError, undefined)
    assert.equal(existsSync(path.join(tmpMemoryDir, 'webSearcher', 'finding-x.md')), false)
    assert.equal(existsSync(path.join(tmpMemoryDir, '_shared', '2026-05-16-finding-x-by-webSearcher.md')), true)
    assert.match(
      readFileSync(path.join(tmpMemoryDir, '_shared', 'MEMORY.md'), 'utf8'),
      /2026-05-16-finding-x-by-webSearcher\.md/,
    )
    assert.doesNotMatch(
      readFileSync(path.join(tmpMemoryDir, 'webSearcher', 'MEMORY.md'), 'utf8'),
      /finding-x\.md/,
    )

    const written = await withAutoDreamSession(() =>
      memoryWriteAtTool.call({
        path: '_shared/merged-finding.md',
        type: 'project',
        description: 'Merged cross-role finding',
        content: 'Why: useful for every role\nHow to apply: read it before research.',
      }, undefined as never),
    )
    assert.equal(written.isError, undefined)
    assert.match(
      readFileSync(path.join(tmpMemoryDir, '_shared', 'MEMORY.md'), 'utf8'),
      /merged-finding\.md/,
    )

    const deleted = await withAutoDreamSession(() =>
      memoryDeleteTool.call({
        path: '_shared/merged-finding.md',
      }, undefined as never),
    )
    assert.equal(deleted.isError, undefined)
    assert.doesNotMatch(
      readFileSync(path.join(tmpMemoryDir, '_shared', 'MEMORY.md'), 'utf8'),
      /merged-finding\.md/,
    )

    const escaped = await withAutoDreamSession(() =>
      memoryWriteAtTool.call({
        path: '/etc/passwd',
        type: 'project',
        description: 'Escape attempt',
        content: 'Why: should fail\nHow to apply: do not write outside memory.',
      }, undefined as never),
    )
    assert.equal(escaped.isError, true)
    assert.match(escaped.output as string, /path resolves outside memoryDir/)
  })

  it('leaves the failed sub-task at its prior watermark when memoryCurator returns WorkerFailure', async () => {
    // PR1.6 regression guard: runSubagent returns failures as
    // {kind:'failure', envelope}. Per-sub-task semantic: a failed
    // sub-task's lastSuccessAt does not advance, so the next eligible
    // cycle can retry it.
    writeSession('s1', 'alice', Date.now())
    writeSession('s2', 'alice', Date.now() + 1)

    const priorMC = Date.now() - 10 * 60 * 60 * 1000
    mkdirSync(tmpMemoryDir, { recursive: true })
    const lockFile = consolidationLockPath(tmpMemoryDir)
    writeFileSync(
      lockFile,
      JSON.stringify({
        subTasks: { memoryCurator: priorMC, skillCurator: priorMC, skillConsolidator: priorMC },
      }) + '\n',
    )

    setRunSubagentForTest(async input => {
      if (input.agentType === 'memoryCurator') {
        return {
          kind: 'failure',
          envelope: {
            status: 'failed',
            reason: 'max-turns-exceeded',
            message: 'subagent hit turn cap',
          },
        }
      }
      return fakeForkResult()
    })

    // minHours: 0 forces every sub-task to be "due" so memoryCurator's
    // failure path actually runs (rather than being throttled out).
    await executeAutoDream({
      userId: 'alice',
      memoryDir: tmpMemoryDir,
      currentSessionId: 'current',
      config: dreamConfig({ enabled: true, minHours: 0, minSessions: 2 }),
    })

    // memoryCurator failed → stays at priorMC.
    const afterMC = await readSubTaskLastSuccess(tmpMemoryDir, 'memoryCurator')
    assert.equal(afterMC, priorMC, 'memoryCurator lastSuccessAt should not advance after failure')
    // skill sub-tasks succeeded → advanced past priorMC.
    assert.ok(await readSubTaskLastSuccess(tmpMemoryDir, 'skillCurator') > priorMC)
    assert.ok(await readSubTaskLastSuccess(tmpMemoryDir, 'skillConsolidator') > priorMC)
  })

  it('preserves prior sub-task watermarks across a stale-pid reclaim', async () => {
    // Verifies that when a previous daemon crashed mid-dream leaving a
    // stale-pid lock, the next start's tryAcquireConsolidationLock reclaim
    // path preserves the prior subTasks history (regression: pre-PR1 the
    // reclaim path unlinked + recreated, erasing the watermark).
    writeSession('s1', 'alice', Date.now())
    writeSession('s2', 'alice', Date.now() + 1)

    const priorTs = Date.now() - 10 * 60 * 60 * 1000
    const lockFile = consolidationLockPath(tmpMemoryDir)
    mkdirSync(tmpMemoryDir, { recursive: true })
    writeFileSync(
      lockFile,
      JSON.stringify({
        pid: 999999999,
        subTasks: {
          memoryCurator: priorTs,
          // skillCurator + skillConsolidator never succeeded → both due.
        },
      }) + '\n',
    )
    const olderSec = priorTs / 1000
    await utimes(lockFile, olderSec, olderSec)

    setRunSubagentForTest(async () => fakeForkResult())

    await executeAutoDream({
      userId: 'alice',
      memoryDir: tmpMemoryDir,
      currentSessionId: 'current',
      // minHours: 0 makes memoryCurator due as well, so this cycle marks
      // all three. priorTs survival is asserted via "memoryCurator
      // advanced past priorTs but didn't reset to 0".
      config: dreamConfig({ enabled: true, minHours: 0, minSessions: 2 }),
    })

    assert.ok(await readSubTaskLastSuccess(tmpMemoryDir, 'memoryCurator') > priorTs)
    assert.ok(await readSubTaskLastSuccess(tmpMemoryDir, 'skillCurator') > priorTs)
    assert.ok(await readSubTaskLastSuccess(tmpMemoryDir, 'skillConsolidator') > priorTs)
  })

  it('does not run a second fork while one is in progress for the same user', async () => {
    writeSession('s1', 'alice', Date.now())
    writeSession('s2', 'alice', Date.now() + 1)

    let forkInvocations = 0
    let signalForkEntered: () => void = () => {}
    const forkEntered = new Promise<void>(resolve => {
      signalForkEntered = resolve
    })
    let releaseFork: () => void = () => {}
    const blockedFork = new Promise<SubagentResult>(resolve => {
      releaseFork = () => resolve(fakeForkResult())
    })
    setRunSubagentForTest(async () => {
      forkInvocations += 1
      signalForkEntered()
      return blockedFork
    })

    const params = {
      userId: 'alice',
      memoryDir: tmpMemoryDir,
      currentSessionId: 'current',
      config: dreamConfig({ enabled: true, minHours: 0, minSessions: 2 }),
    }
    const first = executeAutoDream(params)
    await forkEntered
    await executeAutoDream(params)

    assert.equal(forkInvocations, 1)
    releaseFork()
    await first
  })

  it('drainPendingDream waits for in-flight runs', async () => {
    writeSession('s1', 'alice', Date.now())
    writeSession('s2', 'alice', Date.now() + 1)

    let signalForkEntered: () => void = () => {}
    const forkEntered = new Promise<void>(resolve => {
      signalForkEntered = resolve
    })
    let releaseFork: () => void = () => {}
    const blockedFork = new Promise<SubagentResult>(resolve => {
      releaseFork = () => resolve(fakeForkResult())
    })
    setRunSubagentForTest(async () => {
      signalForkEntered()
      return blockedFork
    })

    const inFlight = executeAutoDream({
      userId: 'alice',
      memoryDir: tmpMemoryDir,
      currentSessionId: 'current',
      config: dreamConfig({ enabled: true, minHours: 0, minSessions: 2 }),
    })
    await forkEntered
    assert.equal(getAutoDreamInFlightCountForTest(), 1)

    setTimeout(releaseFork, 10)
    await drainPendingDream(5_000)
    await inFlight
    assert.equal(getAutoDreamInFlightCountForTest(), 0)
  })

  it('drainPendingDream returns immediately when nothing is in flight', async () => {
    const before = Date.now()
    await drainPendingDream(60_000)
    assert.ok(Date.now() - before < 50)
  })
})

function dreamConfig(
  curator: Partial<NonNullable<LightClawConfig['memory']>['curator']>,
  overrides: Partial<LightClawConfig> = {},
): LightClawConfig {
  return {
    memory: {
      extractor: { enabled: true },
      curator: {
        enabled: false,
        minHours: 24,
        minSessions: 3,
        scanThrottleMs: 600_000,
        burstFileThreshold: 0,
        ...curator,
      },
    },
    paths: { sessions: tmpSessionsDir },
    ...overrides,
  } as LightClawConfig
}

function writeSession(sessionId: string, userId: string, lastActiveAt: number): void {
  const dir = path.join(tmpSessionsDir, sessionId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({
      sessionId,
      userId,
      lastActiveAt,
      createdAt: lastActiveAt,
      model: 'test-model',
      cwd: '/tmp',
      messageCount: 1,
      compactionCount: 0,
      permissionMode: 'default',
    }),
  )
}

function writeForkTranscript(sessionId: string, roleAgentType: string, forkId: string): void {
  const forksDir = path.join(tmpSessionsDir, sessionId, 'forks')
  mkdirSync(forksDir, { recursive: true })
  writeFileSync(
    path.join(forksDir, `${roleAgentType}-${forkId}.jsonl`),
    [
      JSON.stringify({ kind: 'fork-transcript-meta', forkContextEndIndex: 0 }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'repeat the release checklist' } }),
    ].join('\n') + '\n',
    'utf8',
  )
}

function fakeForkResult(): SubagentResult {
  return {
    kind: 'success',
    finalText: '',
    stopReason: 'end_turn',
  }
}

async function seedMemoryTree(): Promise<void> {
  await writeMemoryFile(tmpMemoryDir, memoryEntry('root-note.md', 'root-note description'))
  await writeMemoryFile(path.join(tmpMemoryDir, '_shared'), memoryEntry('shared-note.md', 'shared-note description'))
  await writeMemoryFile(path.join(tmpMemoryDir, 'webSearcher'), memoryEntry('webSearcher-note.md', 'webSearcher-note description'))
}

function memoryEntry(filename: string, description: string) {
  return {
    filename,
    type: 'project' as const,
    description,
    content: `Why: ${description}\nHow to apply: keep this available.`,
    mtimeMs: Date.now(),
  }
}

function withAutoDreamSession<T>(fn: () => Promise<T>): Promise<T> {
  const ctx = createSessionContext({
    cwd: tmpRoot,
    model: 'claude-sonnet-4-6',
    sessionsDir: tmpSessionsDir,
    memoryDir: tmpMemoryDir,
    currentUserId: 'alice',
    currentRole: autoDreamRole(),
    sessionId: 'auto-dream-tool-test',
  })
  return runWithSessionContext(ctx, fn)
}

function autoDreamRole(): Role {
  return {
    agentType: 'memoryCurator',
    kind: 'internal',
    whenToUse: 'internal',
    tools: ['MemoryRead', 'MemoryWriteAt', 'MemoryMove', 'MemoryDelete', 'Read', 'Grep', 'Glob'],
    systemPrompt: 'system',
  }
}
