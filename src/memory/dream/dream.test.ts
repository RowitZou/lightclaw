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

import {
  saveCacheSafeParams,
  type CacheSafeParams,
} from '../../agents/cache-safe-params.js'
type SubagentResult = { finalText: string; stopReason: string | null }
import type { LightClawConfig } from '../../config.js'
import { setExtractionInProgressForTest } from '../extract.js'
import { consolidationLockPath, tryAcquireConsolidationLock } from './lock.js'
import { buildDreamPrompt } from './prompt.js'
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
  saveCacheSafeParams('alice', null)
  resetAutoDreamStateForTest()
  setRunSubagentForTest(null)
})

afterEach(() => {
  if (savedSessionsDir === undefined) {
    delete process.env.LIGHTCLAW_SESSIONS_DIR
  } else {
    process.env.LIGHTCLAW_SESSIONS_DIR = savedSessionsDir
  }
  saveCacheSafeParams('alice', null)
  resetAutoDreamStateForTest()
  setRunSubagentForTest(null)
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('autoDream runner', () => {
  it('builds the four-phase consolidation prompt', () => {
    const prompt = buildDreamPrompt({
      memoryDir: '/memory/alice',
      transcriptDir: '/sessions',
      sessionIds: ['s1', 's2'],
    })
    assert.match(prompt, /Dream: Memory Consolidation/)
    assert.match(prompt, /Phase 1 - Orient/)
    assert.match(prompt, /Phase 4 - Prune And Index/)
    assert.match(prompt, /grep -n/)
    assert.match(prompt, /s1/)
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

  it('skips before lock acquisition when cacheSafeParams is unavailable', async () => {
    writeSession('old-1', 'alice', Date.now())
    writeSession('old-2', 'alice', Date.now() + 1)

    await executeAutoDream({
      userId: 'alice',
      memoryDir: tmpMemoryDir,
      currentSessionId: 'current',
      config: dreamConfig({ enabled: true, minHours: 0, minSessions: 2 }),
    })

    assert.equal(existsSync(tmpMemoryDir), true)
    assert.equal(existsSync(consolidationLockPath(tmpMemoryDir)), false)
    assert.equal(getAutoDreamInFlightCountForTest(), 0)
  })

  it('does not count the current session toward the session gate', async () => {
    writeSession('current', 'alice', Date.now())
    writeSession('old-1', 'alice', Date.now() + 1)
    saveCacheSafeParams('alice', fakeCacheSafeParams())

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
    saveCacheSafeParams('alice', fakeCacheSafeParams())

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
    saveCacheSafeParams('alice', fakeCacheSafeParams())
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
      saveCacheSafeParams('alice', fakeCacheSafeParams())

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
      saveCacheSafeParams('alice', fakeCacheSafeParams())

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
    saveCacheSafeParams('alice', fakeCacheSafeParams())

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

  it('rolls back the lock when the fork throws', async () => {
    writeSession('s1', 'alice', Date.now())
    writeSession('s2', 'alice', Date.now() + 1)
    saveCacheSafeParams('alice', fakeCacheSafeParams())

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

  it('does not run a second fork while one is in progress for the same user', async () => {
    writeSession('s1', 'alice', Date.now())
    writeSession('s2', 'alice', Date.now() + 1)
    saveCacheSafeParams('alice', fakeCacheSafeParams())

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
    saveCacheSafeParams('alice', fakeCacheSafeParams())

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

function fakeCacheSafeParams(): CacheSafeParams {
  return {
    systemPrompt: 'sys',
    tools: [],
    forkContextMessages: [],
    config: {} as LightClawConfig,
  }
}

function fakeForkResult(): SubagentResult {
  return {
    finalText: '',
    stopReason: 'end_turn',
  }
}
