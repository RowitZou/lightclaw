import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'

import fastGlob from 'fast-glob'

import type {
  ExecInput,
  ExecResult,
  GlobOptions,
  Runtime,
  RuntimeAvailability,
  RuntimeFs,
  RuntimeStat,
} from './types.js'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024

export class LocalRuntime implements Runtime {
  readonly kind = 'local' as const
  readonly isolated = false
  readonly workspaceRoot: string
  readonly helperRoot: string
  /** Proxy env injected into every spawned Bash subprocess, sourced
   *  from `runtime.network.proxy` + `runtime.network.noProxy`. Null =
   *  no injection (subprocesses see the parent process env unchanged).
   *  LightClaw's own outbound HTTP paths read proxy from per-component
   *  config, never from this shared parent env, so injection here only
   *  affects user shell tools (curl/git/pnpm/etc.). */
  private readonly proxyEnv: Record<string, string> | null

  constructor(
    workspaceRoot: string,
    proxy?: string | null,
    noProxy: readonly string[] = [],
  ) {
    this.workspaceRoot = path.resolve(workspaceRoot)
    this.helperRoot = resolveDefaultHelperRoot()
    this.proxyEnv = buildLocalProxyEnv(proxy, noProxy)
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

  async isAvailable(): Promise<RuntimeAvailability> {
    return { ok: true }
  }

  private absolutize(pathname: string | undefined, fallback?: string): string {
    if (!pathname) {
      return fallback ?? this.workspaceRoot
    }

    return path.isAbsolute(pathname)
      ? path.resolve(pathname)
      : path.resolve(this.workspaceRoot, pathname)
  }

  async exec(input: ExecInput): Promise<ExecResult> {
    return new Promise(resolve => {
      let settled = false
      let killed = false
      let stdout = ''
      let stderr = ''
      let stdoutBytes = 0
      let stderrBytes = 0
      const maxBytes = input.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES
      // StringDecoder buffers partial UTF-8 sequences across chunk boundaries
      // so multi-byte characters split mid-sequence are not corrupted.
      const stdoutDecoder = new StringDecoder('utf8')
      const stderrDecoder = new StringDecoder('utf8')

      // Build env precedence: process.env < proxyEnv (from
      // runtime.network.proxy) < input.env (caller override). When no
      // proxy is configured and no caller override is supplied we pass
      // `undefined` so child inherits parent env directly — matching
      // the historical behavior for the un-configured case.
      const env =
        this.proxyEnv || input.env
          ? { ...process.env, ...(this.proxyEnv ?? {}), ...(input.env ?? {}) }
          : undefined
      const child = spawn('/bin/bash', ['-c', input.command], {
        cwd: this.absolutize(input.cwd),
        env,
        signal: input.abortSignal,
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
        stderr += `\n${streamName} exceeded maxBufferBytes (${maxBytes}); process terminated.`
        child.kill('SIGTERM')
      }

      const timeout = setTimeout(() => {
        if (killed) {
          return
        }
        killed = true
        stderr += `\ncommand timed out after ${input.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms.`
        child.kill('SIGTERM')
      }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS)

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length
        if (stdoutBytes <= maxBytes) {
          stdout += stdoutDecoder.write(chunk)
        } else {
          killForLimit('stdout')
        }
      })

      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length
        if (stderrBytes <= maxBytes) {
          stderr += stderrDecoder.write(chunk)
        } else {
          killForLimit('stderr')
        }
      })

      child.on('error', error => {
        finish({
          stdout,
          stderr: stderr || error.message,
          exitCode: -1,
        })
      })

      child.on('close', (code, signal) => {
        finish({
          stdout,
          stderr,
          exitCode: killed || signal ? -1 : code ?? 1,
        })
      })

      // Swallow EPIPE / ERR_STREAM_DESTROYED if the child dies (or is killed by
      // an aborted signal) before we finish writing stdin. Without this, the
      // unhandled 'error' event would crash the host process.
      child.stdin.on('error', () => { /* ignored */ })

      if (input.stdin !== undefined) {
        child.stdin.end(input.stdin)
      } else {
        child.stdin.end()
      }
    })
  }

  fs: RuntimeFs = {
    readFile: async pathname => readFile(this.absolutize(pathname)),
    writeFile: async (pathname, content) => {
      const resolved = this.absolutize(pathname)
      await mkdir(path.dirname(resolved), { recursive: true })
      await writeFile(resolved, content)
    },
    stat: async (pathname): Promise<RuntimeStat> => {
      const result = await stat(this.absolutize(pathname))
      return {
        size: result.size,
        isFile: result.isFile(),
        isDirectory: result.isDirectory(),
        mtimeMs: result.mtimeMs,
      }
    },
    glob: async (pattern, options: GlobOptions = {}) => {
      const cwd = this.absolutize(options.cwd, this.workspaceRoot)
      return fastGlob(pattern, {
        cwd,
        ignore: options.ignore,
        onlyFiles: options.onlyFiles ?? true,
        dot: options.dot ?? false,
      })
    },
    readdir: async pathname => readdir(this.absolutize(pathname)),
  }
}

function buildLocalProxyEnv(
  proxy: string | null | undefined,
  noProxy: readonly string[],
): Record<string, string> | null {
  const trimmed = typeof proxy === 'string' ? proxy.trim() : ''
  if (!trimmed) return null
  // Match buildBridgeEnv's shape so admin sees the same env semantics
  // regardless of runtime backend (local / docker host / rlaunch host).
  const builtin = ['localhost', '127.0.0.1', '::1', '.local']
  const merged = [...builtin, ...noProxy.filter(Boolean)].join(',')
  return {
    http_proxy: trimmed,
    https_proxy: trimmed,
    HTTP_PROXY: trimmed,
    HTTPS_PROXY: trimmed,
    no_proxy: merged,
    NO_PROXY: merged,
  }
}

export function resolveDefaultHelperRoot(): string {
  const dirname = fileURLToPath(new URL('.', import.meta.url))
  const candidates = [
    path.resolve(dirname, '../../scripts/sandbox-helpers'),
    path.resolve(dirname, '../scripts/sandbox-helpers'),
    path.resolve(process.cwd(), 'scripts/sandbox-helpers'),
  ]
  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0]
}
