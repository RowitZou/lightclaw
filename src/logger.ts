import fs from 'node:fs'
import path from 'node:path'

import { resolveLogsDir } from './config.js'

/**
 * Daemon stderr tee.
 *
 * LightClaw's operational logging — startup, channel events, crash / error
 * traces, the ~90 `process.stderr.write` call sites — goes to stderr only,
 * which means it lives in the tmux pane and nowhere else. On a remote
 * deployment that pane is unreachable. This module mirrors every stderr
 * write to a day-rotated file under `paths.logs` (default
 * `<lightclawHome>/logs/<YYYY-MM-DD>.log`), so when home points at shared
 * (gpfs) storage the daemon's logs are readable from anywhere with the
 * mount — the same visibility session transcripts already have. stderr
 * passthrough is preserved, so a locally-attached tmux still shows the live
 * stream.
 *
 * Why tee at the source rather than route every call site through a logger
 * object: the REPL admin console renders to stdout (`repl.ts`) while all
 * operational logging is on stderr, so the two streams are already cleanly
 * split. Mirroring stderr captures every existing call site with zero churn
 * and the log file stays free of the interactive console's redraws. A
 * structured per-call-site logger can be layered on later without changing
 * this contract.
 */

let installed = false
let originalWrite: typeof process.stderr.write | undefined
// Serializes appendFile calls so on-disk line order matches write order even
// though the patched stderr.write fires the append and returns immediately.
let writeChain: Promise<void> = Promise.resolve()
let dirReady = false

function mirror(dir: string, text: string): void {
  writeChain = writeChain.then(async () => {
    try {
      if (!dirReady) {
        await fs.promises.mkdir(dir, { recursive: true })
        dirReady = true
      }
      // Recomputed per append so a long-running daemon rolls to a new file at
      // the UTC date boundary without a restart.
      const date = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
      await fs.promises.appendFile(path.join(dir, `${date}.log`), text, 'utf8')
    } catch {
      // A failing log mirror must never block or crash the daemon, and must
      // never write to stderr — that would recurse through the patched write.
    }
  })
}

function logFilePathFor(dir: string): string {
  return path.join(dir, `${new Date().toISOString().slice(0, 10)}.log`)
}

/**
 * Patch `process.stderr.write` so every chunk is also appended to the
 * day-rotated log file. Idempotent. Returns today's log file path so the
 * caller can announce it. Call once at startup, AFTER the LightClaw home /
 * `paths.logs` are resolved.
 */
export function installStderrTee(): string {
  const dir = resolveLogsDir()
  if (installed) {
    return logFilePathFor(dir)
  }
  installed = true
  const original = process.stderr.write.bind(process.stderr)
  originalWrite = original
  process.stderr.write = function (
    chunk: unknown,
    encoding?: unknown,
    cb?: unknown,
  ): boolean {
    // Pass through to the real stderr first so tmux / attached consoles see
    // the live stream unchanged, preserving the original return value and all
    // three call signatures (chunk / chunk,cb / chunk,encoding,cb).
    const result = (original as (...a: unknown[]) => boolean)(chunk, encoding, cb)
    try {
      const text =
        typeof chunk === 'string'
          ? chunk
          : Buffer.isBuffer(chunk)
            ? chunk.toString('utf8')
            : String(chunk)
      mirror(dir, text)
    } catch {
      // Never let the mirror break stderr.
    }
    return result
  } as typeof process.stderr.write
  return logFilePathFor(dir)
}

/**
 * Await the pending log-file appends. Call before a process exit so the tail
 * of the log (shutdown drain lines) lands on disk; tests also use it to read
 * back deterministically.
 */
export function flushLogTee(): Promise<void> {
  return writeChain
}

/** Test-only: restore the original stderr.write and reset module state. */
export function __resetStderrTeeForTest(): void {
  if (originalWrite) {
    process.stderr.write = originalWrite
  }
  installed = false
  originalWrite = undefined
  writeChain = Promise.resolve()
  dirReady = false
}
