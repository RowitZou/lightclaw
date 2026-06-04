import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  __resetStderrTeeForTest,
  flushLogTee,
  installStderrTee,
} from './logger.js'

test('installStderrTee mirrors stderr to a day-rotated log file under paths.logs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightclaw-logs-'))
  process.env.LIGHTCLAW_LOGS_DIR = dir
  try {
    const logFile = installStderrTee()
    assert.equal(path.dirname(logFile), dir, 'log file should sit under LIGHTCLAW_LOGS_DIR')
    assert.match(path.basename(logFile), /^\d{4}-\d{2}-\d{2}\.log$/, 'filename is the UTC date')

    const first = `startup-${Date.now()}\n`
    const second = `channel feishu: starting ${Date.now()}\n`
    process.stderr.write(first)
    process.stderr.write(second)
    await flushLogTee()

    const onDisk = fs.readFileSync(logFile, 'utf8')
    assert.ok(onDisk.includes(first), 'log file should contain the first stderr line')
    assert.ok(onDisk.includes(second), 'subsequent writes append, not overwrite')
    assert.ok(
      onDisk.indexOf(first) < onDisk.indexOf(second),
      'on-disk order matches write order',
    )
  } finally {
    __resetStderrTeeForTest()
    delete process.env.LIGHTCLAW_LOGS_DIR
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('stderr passthrough is preserved — the tee must not swallow the original write', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightclaw-logs-'))
  process.env.LIGHTCLAW_LOGS_DIR = dir
  const realWrite = process.stderr.write
  const seen: string[] = []
  // Install a spy as the *current* stderr.write so installStderrTee binds it
  // as the passthrough target, then assert the tee still forwards to it.
  process.stderr.write = ((chunk: unknown): boolean => {
    seen.push(typeof chunk === 'string' ? chunk : String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    installStderrTee()
    const marker = `passthrough-${Date.now()}\n`
    process.stderr.write(marker)
    await flushLogTee()
    assert.ok(
      seen.some(s => s.includes(marker)),
      'the original stderr.write must still receive every chunk',
    )
    const onDisk = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]!), 'utf8')
    assert.ok(onDisk.includes(marker), 'and the chunk is also mirrored to the log file')
  } finally {
    __resetStderrTeeForTest()
    process.stderr.write = realWrite
    delete process.env.LIGHTCLAW_LOGS_DIR
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
