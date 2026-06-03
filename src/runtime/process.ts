import { spawn, type ChildProcess } from 'node:child_process'
import nodeProcess from 'node:process'
import { StringDecoder } from 'node:string_decoder'

import type { ExecResult } from './types.js'

export type RunProcessOptions = {
  abortSignal?: AbortSignal
  cwd?: string
  env?: NodeJS.ProcessEnv
  stdin?: string | Buffer
  timeoutMs: number
  maxBufferBytes: number
  limitMessage: string
  /** Override the SIGTERM→SIGKILL grace window. Defaults to
   *  FORCE_KILL_GRACE_MS; exposed mainly so tests don't wait the full 5s. */
  forceKillGraceMs?: number
}

const PROXY_ENV_KEYS = [
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
] as const

export function withoutProxyEnv(env: NodeJS.ProcessEnv = nodeProcess.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  for (const key of PROXY_ENV_KEYS) {
    delete out[key]
  }
  return out
}

// SIGTERM gives the child a chance to flush and exit cleanly; if it ignores
// the signal (e.g. brainctl wedged on a ws frame waiting on a black-holed
// upstream) we force-kill so the caller's promise can resolve. 5s is long
// enough for normal flush, short enough that admin-visible hangs stay bounded.
const FORCE_KILL_GRACE_MS = 5_000

// Every child is spawned `detached`, so its pid is also the leader of a fresh
// process group. Signalling `-pid` reaches the whole group — the child AND
// every descendant it spawned (`bash -c "git clone"` → git → git-index-pack).
// A plain `child.kill()` only hits the direct child and orphans the rest.
function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    return
  }
  try {
    nodeProcess.kill(-child.pid, signal)
  } catch (error) {
    // ESRCH = the group is already gone; nothing to do. For any other error
    // (EPERM is the only other realistic one, and unexpected for a child we
    // spawned ourselves) fall back to signalling just the direct child.
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return
    }
    try {
      child.kill(signal)
    } catch {
      // Child already reaped — nothing left to signal.
    }
  }
}

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
    const forceKillGraceMs = options.forceKillGraceMs ?? FORCE_KILL_GRACE_MS
    // `detached: true` makes the child a process-group leader (pgid == pid),
    // so a timeout / abort / maxBuffer kill can take down the whole tree.
    // We deliberately do NOT pass `signal` to spawn(): Node's built-in abort
    // handling only `child.kill()`s the direct child (orphaning every
    // descendant) and synchronously emits an `error` event, which would
    // `finish()` the promise with `killed === false` — skipping both the
    // SIGKILL group sweep in finish() and the SIGTERM→SIGKILL escalation.
    // The `onAbort` handler below is the sole abort path: it signals the
    // whole process group with the same escalation guarantee as the timeout
    // and maxBuffer kills, so a SIGTERM-ignoring descendant is reaped on
    // abort instead of leaking (5.21 Bug 4).
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
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
      // The direct child has exited. If we initiated a kill, sweep the process
      // group once more with SIGKILL: descendants that ignored the earlier
      // SIGTERM (or were simply slower to exit than the parent) are reaped
      // here instead of leaking as orphans. An empty group surfaces as ESRCH,
      // which signalProcessGroup swallows.
      if (killed) {
        signalProcessGroup(child, 'SIGKILL')
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
        stderr += `\nchild did not exit ${forceKillGraceMs}ms after SIGTERM; sending SIGKILL.`
        signalProcessGroup(child, 'SIGKILL')
      }, forceKillGraceMs)
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
      signalProcessGroup(child, 'SIGTERM')
      escalateKill()
    }

    const timeout = setTimeout(() => {
      if (killed) {
        return
      }
      killed = true
      stderr += `\ncommand timed out after ${options.timeoutMs}ms.`
      signalProcessGroup(child, 'SIGTERM')
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

    // Abort path (e.g. user /stop): SIGTERM the whole process group and apply
    // the same SIGTERM→SIGKILL escalation as the timeout / maxBuffer kills, so
    // a descendant that ignores SIGTERM is reaped instead of leaking as an
    // orphan. finish() then does the synchronous SIGKILL group sweep because
    // this path sets `killed`.
    if (options.abortSignal) {
      const onAbort = (): void => {
        if (killed) {
          return
        }
        killed = true
        stderr += `\ncommand aborted.`
        signalProcessGroup(child, 'SIGTERM')
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
