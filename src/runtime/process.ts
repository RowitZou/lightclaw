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

export async function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions,
): Promise<ExecResult> {
  return new Promise(resolve => {
    let settled = false
    let killed = false
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
      resolve({
        ...result,
        stdout: result.stdout + stdoutDecoder.end(),
        stderr: result.stderr + stderrDecoder.end(),
      })
    }

    const killForLimit = (streamName: 'stdout' | 'stderr'): void => {
      if (killed) {
        return
      }
      killed = true
      stderr += `\n${streamName} exceeded maxBufferBytes (${options.maxBufferBytes}); ${options.limitMessage}.`
      child.kill('SIGTERM')
    }

    const timeout = setTimeout(() => {
      if (killed) {
        return
      }
      killed = true
      stderr += `\ncommand timed out after ${options.timeoutMs}ms.`
      child.kill('SIGTERM')
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
