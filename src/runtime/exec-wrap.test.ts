import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import {
  sandboxBackstopTimeoutMs,
  wrapSandboxCommandWithTimeout,
} from './exec-wrap.js'
import { runProcess } from './process.js'

function isRunning(pid: number): boolean {
  try {
    const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim()
    return stat.length > 0 && !stat.startsWith('Z')
  } catch {
    return false
  }
}

describe('sandboxBackstopTimeoutMs', () => {
  it('runs past the in-sandbox budget + grace by a fixed margin', () => {
    // budget 30s + grace 5s + 5s margin.
    assert.equal(sandboxBackstopTimeoutMs(30_000), 40_000)
    assert.equal(sandboxBackstopTimeoutMs(30_000, 2_000), 37_000)
  })
})

describe('wrapSandboxCommandWithTimeout', () => {
  it('runs the command via setsid with a watchdog at the rounded budget', () => {
    const wrapped = wrapSandboxCommandWithTimeout('echo hi', 30_000)
    assert.match(wrapped, /setsid bash -c 'echo hi'/)
    assert.match(wrapped, /sleep 30/)
    assert.match(wrapped, /exceeded the 30s sandbox time limit/)
    assert.match(wrapped, /exit \$__lc_rc/)
  })

  it('is transparent: forwards stdout and exit code of a normal command', async () => {
    // Budget is intentionally small (2s, not the docker/rlaunch default 30s)
    // so the watchdog sleep doesn't dominate test wall time. The point of
    // this case is "fast command rides through unchanged" — the inner echo
    // exits in ~1ms and the wrapper should return immediately afterward.
    // (Pre-2026-05-23 this used budget=30s and took ~35s; the wait on the
    // killed watchdog group still drags out the full budget+grace under
    // some bash configurations, so keep the budget tight here.)
    const wrapped = wrapSandboxCommandWithTimeout('echo hello && exit 7', 2_000)
    const result = await runProcess('/bin/bash', ['-c', wrapped], {
      timeoutMs: sandboxBackstopTimeoutMs(2_000),
      maxBufferBytes: 1024 * 1024,
      limitMessage: 'process terminated',
    })
    assert.equal(result.stdout.trim(), 'hello')
    assert.equal(result.exitCode, 7)
  })

  it('self-terminates a runaway process tree at the sandbox budget', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lightclaw-sandbox-timeout-'))
    const pidFile = path.join(dir, 'descendant.pid')
    try {
      // A runaway: spawns a descendant that loops, then sleeps far past the
      // budget. The in-sandbox watchdog must take the whole tree down.
      const runaway =
        `bash -c 'echo $$ > ${JSON.stringify(pidFile)}; ` +
        `while true; do sleep 1; done' &\n` +
        `until [ -s ${JSON.stringify(pidFile)} ]; do sleep 0.02; done\n` +
        `sleep 60`
      const wrapped = wrapSandboxCommandWithTimeout(runaway, 1_000, 500)
      const backstop = sandboxBackstopTimeoutMs(1_000, 500)
      const start = Date.now()
      const result = await runProcess('/bin/bash', ['-c', wrapped], {
        timeoutMs: backstop,
        maxBufferBytes: 1024 * 1024,
        limitMessage: 'process terminated',
      })
      const elapsed = Date.now() - start

      // The in-sandbox watchdog (1s budget, +1s grace) resolves the command
      // well before the daemon-side backstop would have fired.
      assert.ok(
        elapsed < backstop - 1_000,
        `should self-terminate via the in-sandbox watchdog, took ${elapsed}ms`,
      )
      assert.notEqual(result.exitCode, 0)
      assert.match(result.stderr, /exceeded the 1s sandbox time limit/)

      assert.equal(existsSync(pidFile), true, 'descendant should have started')
      const descendantPid = Number(readFileSync(pidFile, 'utf8').trim())
      await delay(200)
      assert.equal(
        isRunning(descendantPid),
        false,
        `descendant pid ${descendantPid} should be killed with the tree`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
