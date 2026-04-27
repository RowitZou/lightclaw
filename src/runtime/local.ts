import { execFile } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import type { ExecInput, ExecResult, Runtime, RuntimeFs } from './types.js'

const execFileAsync = promisify(execFile)
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024

export class LocalRuntime implements Runtime {
  readonly kind = 'local' as const
  readonly isolated = false
  readonly workspaceHostPath: string
  readonly workspaceContainerPath: string

  constructor(workspace: string) {
    const resolved = path.resolve(workspace)
    this.workspaceHostPath = resolved
    this.workspaceContainerPath = resolved
  }

  async start(): Promise<void> {
    // Local execution is already available in the host process.
  }

  async stop(): Promise<void> {
    // No external process or container to tear down.
  }

  isRunning(): boolean {
    return true
  }

  async exec(input: ExecInput): Promise<ExecResult> {
    try {
      const result = await execFileAsync('/bin/bash', ['-c', input.command], {
        cwd: input.cwd ?? this.workspaceHostPath,
        env: input.env ? { ...process.env, ...input.env } : undefined,
        timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: input.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
        signal: input.abortSignal,
      })

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: 0,
      }
    } catch (error) {
      const execError = error as {
        stdout?: string
        stderr?: string
        message?: string
        code?: string | number
        killed?: boolean
        signal?: string
      }
      const exitCode = typeof execError.code === 'number'
        ? execError.code
        : execError.killed || execError.signal
          ? -1
          : 1

      return {
        stdout: execError.stdout ?? '',
        stderr: execError.stderr ?? execError.message ?? '',
        exitCode,
      }
    }
  }

  fs: RuntimeFs = {
    readFile: async pathname => readFile(pathname),
    writeFile: async (pathname, content) => {
      await mkdir(path.dirname(pathname), { recursive: true })
      await writeFile(pathname, content)
    },
    stat: async pathname => {
      const result = await stat(pathname)
      return {
        size: result.size,
        isFile: result.isFile(),
        isDirectory: result.isDirectory(),
        mtimeMs: result.mtimeMs,
      }
    },
  }
}
