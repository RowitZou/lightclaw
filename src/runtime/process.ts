import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

import type { ExecResult } from './types.js'

export type RunProcessOptions = {
  abortSignal?: AbortSignal
  stdin?: string | Buffer
  timeoutMs: number
  maxBufferBytes: number
  limitMessage: string
}

// SIGTERM gives the child a chance to flush and exit cleanly; if it ignores
// the signal (e.g. brainctl wedged on a ws frame waiting on a black-holed
// upstream) we force-kill so the caller's promise can resolve. 5s is long
// enough for normal flush, short enough that admin-visible hangs stay bounded.
const FORCE_KILL_GRACE_MS = 5_000

export async function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions,
): Promise<ExecResult> {
  return new Promise(resolve => {
    let settled = false
    let killed = false
    let forceKillTimer: NodeJS.Timeout | null = null
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    const child = spawn(command, args, {
      signal: options.abortSignal,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const finish = (result: ExecResult): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      if (forceKillTimer) {
        clearTimeout(forceKillTimer)
        forceKillTimer = null
      }
      resolve({
        ...result,
        stdout: result.stdout + stdoutDecoder.end(),
        stderr: result.stderr + stderrDecoder.end(),
      })
    }

    // Two-stage kill: SIGTERM first, then SIGKILL after a grace window if the
    // child has not exited. Without the escalation, a child that ignores
    // SIGTERM (brainctl ws upstream hang is the canonical case) leaves the
    // promise pending forever and the calling exec loop wedged.
    const escalateKill = (): void => {
      if (forceKillTimer || settled) {
        return
      }
      forceKillTimer = setTimeout(() => {
        forceKillTimer = null
        if (settled) {
          return
        }
        stderr += `\nchild did not exit ${FORCE_KILL_GRACE_MS}ms after SIGTERM; sending SIGKILL.`
        child.kill('SIGKILL')
      }, FORCE_KILL_GRACE_MS)
      // Don't let the grace timer keep the event loop alive on its own —
      // close handler clears it via finish() anyway.
      forceKillTimer.unref?.()
    }

    const killForLimit = (streamName: 'stdout' | 'stderr'): void => {
      if (killed) {
        return
      }
      killed = true
      stderr += `\n${streamName} exceeded maxBufferBytes (${options.maxBufferBytes}); ${options.limitMessage}.`
      child.kill('SIGTERM')
      escalateKill()
    }

    const timeout = setTimeout(() => {
      if (killed) {
        return
      }
      killed = true
      stderr += `\ncommand timed out after ${options.timeoutMs}ms.`
      child.kill('SIGTERM')
      escalateKill()
    }, options.timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes <= options.maxBufferBytes) {
        stdout += stdoutDecoder.write(chunk)
      } else {
        killForLimit('stdout')
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (stderrBytes <= options.maxBufferBytes) {
        stderr += stderrDecoder.write(chunk)
      } else {
        killForLimit('stderr')
      }
    })
    child.on('error', error => {
      finish({ stdout, stderr: stderr || error.message, exitCode: -1 })
    })
    child.on('close', (code, signal) => {
      finish({ stdout, stderr, exitCode: killed || signal ? -1 : code ?? 1 })
    })
    child.stdin.on('error', () => { /* ignored */ })

    // Abort path (e.g. user /stop): spawn() itself emits SIGTERM when the
    // signal fires, but the same escalation guarantee applies — if the
    // child ignores SIGTERM, force-kill after the grace window so the
    // caller's promise still resolves.
    if (options.abortSignal) {
      const onAbort = (): void => {
        if (killed) {
          return
        }
        killed = true
        stderr += `\ncommand aborted.`
        escalateKill()
      }
      if (options.abortSignal.aborted) {
        onAbort()
      } else {
        options.abortSignal.addEventListener('abort', onAbort, { once: true })
      }
    }

    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin)
    } else {
      child.stdin.end()
    }
  })
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
