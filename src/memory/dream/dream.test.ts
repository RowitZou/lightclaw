import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { utimes } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'

import type { Role } from '../../agents/types.js'
import type { RunSubagentResult } from '../../agents/run-subagent.js'
type SubagentResult = RunSubagentResult
import type { LightClawConfig } from '../../config.js'
import { createSessionContext, runWithSessionContext } from '../../session-context.js'
import { memoryDeleteTool } from '../../tools/memory-delete.js'
import { memoryMoveTool } from '../../tools/memory-move.js'
import { memoryWriteAtTool } from '../../tools/memory-write-at.js'
import { writeMemoryFile } from '../auto-memory.js'
import { setExtractionInProgressForTest } from '../extract.js'
import { consolidationLockPath, tryAcquireConsolidationLock } from './lock.js'
import { buildDreamPrompt, gatherDreamMemoryTree } from './prompt.js'
import {
  drainPendingDream,
  executeAutoDream,
  getAutoDreamInFlightCountForTest,
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
      config: dreamConfig({ enabled: true }, { autoMemory: false }),
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

    mkdirSync(tmpMemoryDir, { recursive: true })
    writeFileSync(consolidationLockPath(tmpMemoryDir), `${process.pid}\n`)

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
    } finally {
      setExtractionInProgressForTest(tmpMemoryDir, false)
    }
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

  it('runs the fork and marks consolidation succeeded when all gates pass', async () => {
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

    assert.equal(forkInvocations, 1)
    assert.equal(existsSync(consolidationLockPath(tmpMemoryDir)), true)
    assert.equal(
      readFileSync(consolidationLockPath(tmpMemoryDir), 'utf8').trim(),
      String(process.pid),
    )
  })

  it('passes a full user memory tree manifest to a single autoDream fork', async () => {
    writeSession('s1', 'alice', Date.now())
    writeSession('s2', 'alice', Date.now() + 1)
    await seedMemoryTree()

    let forkInvocations = 0
    let prompt = ''
    setRunSubagentForTest(async input => {
      forkInvocations += 1
      prompt = input.prompt
      return fakeForkResult()
    })

    await executeAutoDream({
      userId: 'alice',
      memoryDir: tmpMemoryDir,
      currentSessionId: 'current',
      config: dreamConfig({ enabled: true, minHours: 0, minSessions: 2 }),
    })

    assert.equal(forkInvocations, 1)
    assert.match(prompt, /root-note\.md: root-note description/)
    assert.match(prompt, /_shared\/shared-note\.md: shared-note description/)
    assert.match(prompt, /webSearcher\/webSearcher-note\.md: webSearcher-note description/)
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

  it('rolls back the lock when the fork throws', async () => {
    writeSession('s1', 'alice', Date.now())
    writeSession('s2', 'alice', Date.now() + 1)

    await tryAcquireConsolidationLock(tmpMemoryDir)
    const olderTimestampSec = (Date.now() - 10 * 60 * 60 * 1000) / 1000
    await utimes(
      consolidationLockPath(tmpMemoryDir),
      olderTimestampSec,
      olderTimestampSec,
    )
    const priorMtime = statSync(consolidationLockPath(tmpMemoryDir)).mtimeMs

    setRunSubagentForTest(async () => {
      throw new Error('fork blew up')
    })

    await assert.rejects(
      executeAutoDream({
        userId: 'alice',
        memoryDir: tmpMemoryDir,
        currentSessionId: 'current',
        config: dreamConfig({ enabled: true, minHours: 0, minSessions: 2 }),
      }),
      /fork blew up/,
    )

    const afterRollback = statSync(consolidationLockPath(tmpMemoryDir)).mtimeMs
    assert.ok(
      Math.abs(afterRollback - priorMtime) < 5,
      `expected rollback mtime ~${priorMtime}, got ${afterRollback}`,
    )
    assert.equal(readFileSync(consolidationLockPath(tmpMemoryDir), 'utf8'), '')
  })

  it('rolls back the lock when the fork returns a WorkerFailure envelope', async () => {
    // PR1.6 regression guard: runSubagent now returns failures as
    // {kind:'failure', envelope} instead of throwing. autoDream must treat
    // the structured failure equivalently to a thrown error — roll back the
    // lock so the 24h throttle window isn't burned on an unsuccessful run.
    writeSession('s1', 'alice', Date.now())
    writeSession('s2', 'alice', Date.now() + 1)

    await tryAcquireConsolidationLock(tmpMemoryDir)
    const olderTimestampSec = (Date.now() - 10 * 60 * 60 * 1000) / 1000
    await utimes(
      consolidationLockPath(tmpMemoryDir),
      olderTimestampSec,
      olderTimestampSec,
    )
    const priorMtime = statSync(consolidationLockPath(tmpMemoryDir)).mtimeMs

    setRunSubagentForTest(async () => ({
      kind: 'failure',
      envelope: {
        status: 'failed',
        reason: 'max-turns-exceeded',
        message: 'subagent hit turn cap',
      },
    }))

    // executeAutoDream must NOT throw on structured failure — but must
    // restore the prior lock mtime instead of marking consolidation
    // succeeded.
    await executeAutoDream({
      userId: 'alice',
      memoryDir: tmpMemoryDir,
      currentSessionId: 'current',
      config: dreamConfig({ enabled: true, minHours: 0, minSessions: 2 }),
    })

    const afterRollback = statSync(consolidationLockPath(tmpMemoryDir)).mtimeMs
    assert.ok(
      Math.abs(afterRollback - priorMtime) < 5,
      `expected rollback mtime ~${priorMtime}, got ${afterRollback}`,
    )
    assert.equal(readFileSync(consolidationLockPath(tmpMemoryDir), 'utf8'), '')
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
  autoDream: Partial<LightClawConfig['autoDream']>,
  overrides: Partial<LightClawConfig> = {},
): LightClawConfig {
  return {
    autoMemory: true,
    autoDream: {
      enabled: false,
      minHours: 24,
      minSessions: 3,
      scanThrottleMs: 600_000,
      maxTurns: 30,
      ...autoDream,
    },
    sessionsDir: tmpSessionsDir,
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
