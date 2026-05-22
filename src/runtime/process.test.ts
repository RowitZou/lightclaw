import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { runProcess } from './process.js'

function isRunning(pid: number): boolean {
  try {
    const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim()
    // A live process has a non-empty state that is not 'Z' (zombie).
    return stat.length > 0 && !stat.startsWith('Z')
  } catch {
    // ps exits non-zero when the pid no longer exists.
    return false
  }
}

async function waitForPidFile(file: string, timeoutMs = 5_000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const raw = readFileSync(file, 'utf8').trim()
      if (raw.length > 0) {
        return Number(raw)
      }
    }
    await delay(20)
  }
  throw new Error(`timed out waiting for ${file}`)
}

describe('runProcess kills the whole process group', () => {
  it('reaps a SIGTERM-ignoring descendant when the command times out', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lightclaw-pg-timeout-'))
    const pidFile = path.join(dir, 'grandchild.pid')
    try {
      // The direct child spawns a grandchild that ignores SIGTERM and loops.
      // The direct child itself exits on SIGTERM, so the only thing that
      // reaps the grandchild is the process-group SIGKILL sweep — a plain
      // child.kill() would orphan it.
      const script =
        `bash -c 'trap "" TERM; echo $$ > ${JSON.stringify(pidFile)}; ` +
        `while true; do sleep 1; done' &\n` +
        `until [ -s ${JSON.stringify(pidFile)} ]; do sleep 0.02; done\n` +
        `sleep 30`
      const result = await runProcess('/bin/bash', ['-c', script], {
        timeoutMs: 500,
        forceKillGraceMs: 200,
        maxBufferBytes: 1024 * 1024,
        limitMessage: 'process terminated',
      })
      assert.equal(result.exitCode, -1)
      assert.match(result.stderr, /command timed out after 500ms/)

      assert.equal(existsSync(pidFile), true, 'grandchild should have started')
      const grandchildPid = Number(readFileSync(pidFile, 'utf8').trim())
      assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0)
      // Give the OS a moment to deliver SIGKILL and reap the process.
      await delay(200)
      assert.equal(
        isRunning(grandchildPid),
        false,
        `grandchild pid ${grandchildPid} should have been killed with the group`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('escalates to SIGKILL when the command itself ignores SIGTERM', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lightclaw-pg-escalate-'))
    const pidFile = path.join(dir, 'child.pid')
    try {
      const script =
        `trap "" TERM; echo $$ > ${JSON.stringify(pidFile)}; ` +
        `while true; do sleep 1; done`
      const started = runProcess('/bin/bash', ['-c', script], {
        timeoutMs: 300,
        forceKillGraceMs: 200,
        maxBufferBytes: 1024 * 1024,
        limitMessage: 'process terminated',
      })
      const childPid = await waitForPidFile(pidFile)
      const result = await started
      assert.equal(result.exitCode, -1)
      assert.match(result.stderr, /command timed out after 300ms/)
      assert.match(result.stderr, /sending SIGKILL/)
      await delay(200)
      assert.equal(
        isRunning(childPid),
        false,
        `child pid ${childPid} should have been force-killed`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// 5.21 dogfood Bug 4: the abort path (user /stop) must take down the whole
// process group with the same SIGTERM→SIGKILL escalation as the timeout path.
// Pre-fix runProcess passed `signal` to spawn(); Node's built-in abort handler
// only kills the direct child and synchronously emits an `error` event that
// resolves the promise with killed===false — so the SIGKILL group sweep and
// the escalation never run, and a SIGTERM-ignoring descendant leaks.
describe('runProcess kills the whole process group on abort', () => {
  it('reaps a SIGTERM-ignoring descendant when the command is aborted', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lightclaw-pg-abort-'))
    const pidFile = path.join(dir, 'grandchild.pid')
    try {
      const controller = new AbortController()
      // Same shape as the timeout test: the direct child exits on SIGTERM,
      // so only the process-group SIGKILL sweep can reap the grandchild.
      const script =
        `bash -c 'trap "" TERM; echo $$ > ${JSON.stringify(pidFile)}; ` +
        `while true; do sleep 1; done' &\n` +
        `until [ -s ${JSON.stringify(pidFile)} ]; do sleep 0.02; done\n` +
        `sleep 30`
      const started = runProcess('/bin/bash', ['-c', script], {
        abortSignal: controller.signal,
        // A long timeout so the abort path — not the timeout path — is the
        // thing under test.
        timeoutMs: 30_000,
        forceKillGraceMs: 200,
        maxBufferBytes: 1024 * 1024,
        limitMessage: 'process terminated',
      })
      const grandchildPid = await waitForPidFile(pidFile)
      controller.abort()
      const result = await started
      assert.equal(result.exitCode, -1)
      assert.match(result.stderr, /command aborted/)

      // Give the OS a moment to deliver SIGKILL and reap the process.
      await delay(200)
      assert.equal(
        isRunning(grandchildPid),
        false,
        `grandchild pid ${grandchildPid} should have been killed with the group`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('escalates to SIGKILL when an aborted command itself ignores SIGTERM', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lightclaw-pg-abort-escalate-'))
    const pidFile = path.join(dir, 'child.pid')
    try {
      const controller = new AbortController()
      const script =
        `trap "" TERM; echo $$ > ${JSON.stringify(pidFile)}; ` +
        `while true; do sleep 1; done`
      const started = runProcess('/bin/bash', ['-c', script], {
        abortSignal: controller.signal,
        timeoutMs: 30_000,
        forceKillGraceMs: 200,
        maxBufferBytes: 1024 * 1024,
        limitMessage: 'process terminated',
      })
      const childPid = await waitForPidFile(pidFile)
      controller.abort()
      const result = await started
      assert.equal(result.exitCode, -1)
      assert.match(result.stderr, /command aborted/)
      assert.match(result.stderr, /sending SIGKILL/)
      await delay(200)
      assert.equal(
        isRunning(childPid),
        false,
        `child pid ${childPid} should have been force-killed`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
