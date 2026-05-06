import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { saveCacheSafeParams } from '../../agents/cache-safe-params.js'
import type { LightClawConfig } from '../../config.js'
import { consolidationLockPath } from './lock.js'
import { buildDreamPrompt } from './prompt.js'
import {
  executeAutoDream,
  getAutoDreamInFlightCountForTest,
  resetAutoDreamStateForTest,
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
  saveCacheSafeParams(null)
  resetAutoDreamStateForTest()
})

afterEach(() => {
  if (savedSessionsDir === undefined) {
    delete process.env.LIGHTCLAW_SESSIONS_DIR
  } else {
    process.env.LIGHTCLAW_SESSIONS_DIR = savedSessionsDir
  }
  saveCacheSafeParams(null)
  resetAutoDreamStateForTest()
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

  it('does nothing when disabled', async () => {
    await executeAutoDream({
      userId: 'alice',
      memoryDir: tmpMemoryDir,
      currentSessionId: 'current',
      config: dreamConfig({ enabled: false }),
    })
    assert.equal(existsSync(tmpMemoryDir), false)
    assert.equal(getAutoDreamInFlightCountForTest(), 0)
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

    await executeAutoDream({
      userId: 'alice',
      memoryDir: tmpMemoryDir,
      currentSessionId: 'current',
      config: dreamConfig({ enabled: true, minHours: 0, minSessions: 2 }),
    })

    assert.equal(existsSync(consolidationLockPath(tmpMemoryDir)), false)
  })
})

function dreamConfig(autoDream: Partial<LightClawConfig['autoDream']>): LightClawConfig {
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
