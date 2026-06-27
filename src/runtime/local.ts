import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { runProcess } from './process.js'
import { withByteBudget } from './byte-budget.js'
import type {
  ControlPlane,
  DataPlane,
  ExecInput,
  ExecResult,
  PathPolicy,
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
  readonly securityProfile = 'host-trusted' as const
  readonly workspaceRoot: string
  readonly scratchRoot: string
  readonly control: ControlPlane
  readonly data: DataPlane
  readonly paths: PathPolicy
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
    // Scratch lives on a host OS temp dir — genuine local disk even when the
    // workspace itself is a GPFS / shared mount. See `Runtime.scratchRoot`.
    this.scratchRoot = path.join(tmpdir(), 'lightclaw-scratch')
    this.proxyEnv = buildLocalProxyEnv(proxy, noProxy)
    this.control = {
      kind: 'local-spawn',
      stdoutByteReliability: 'guaranteed',
      exec: input => this.exec(input),
      start: () => this.start(),
      stop: () => this.stop(),
      isRunning: () => this.isRunning(),
      isAvailable: () => this.isAvailable(),
    }
    this.data = withByteBudget(this.fs)
    this.fs = this.data
    this.paths = {
      mountTable: [],
      toHostPath: pathname => this.absolutize(pathname),
      toWorkerPath: pathname => this.absolutize(pathname),
      isShared: () => true,
      isAllowed: () => true,
    }
  }

  async start(): Promise<void> {
    // Local execution is already available in the host process; the only
    // setup is the scratch dir. Best-effort — a missing scratch dir only
    // costs the shared-fs git slowdown that scratchRoot exists to avoid.
    try {
      await mkdir(this.scratchRoot, { recursive: true })
    } catch (err) {
      process.stderr.write(
        `[local] failed to create scratch dir ${this.scratchRoot}: ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
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
    // Build env precedence: process.env < proxyEnv (from
    // runtime.network.proxy) < input.env (caller override). When no
    // proxy is configured and no caller override is supplied we pass
    // `undefined` so child inherits parent env directly — matching
    // the historical behavior for the un-configured case.
    const env =
      this.proxyEnv || input.env
        ? { ...process.env, ...(this.proxyEnv ?? {}), ...(input.env ?? {}) }
        : undefined
    // Delegate to runProcess: a timeout / abort / maxBuffer kill then takes
    // down the whole spawned process group (`bash -c "git clone"` → git →
    // git-index-pack), not just the direct bash child. runProcess also adds
    // the SIGTERM→SIGKILL escalation this path never had.
    return runProcess('/bin/bash', ['-c', input.command], {
      abortSignal: input.abortSignal,
      cwd: this.absolutize(input.cwd),
      env,
      stdin: input.stdin,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBufferBytes: input.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
      limitMessage: 'process terminated',
    })
  }

  fs: RuntimeFs = {
    kind: 'host-direct',
    independentFromControl: true,
    reliability: 'fs-semantic',
    readFile: async pathname => readFile(this.absolutize(pathname)),
    writeFile: async (pathname, content) => {
      const resolved = this.absolutize(pathname)
      await mkdir(path.dirname(resolved), { recursive: true })
      await writeFile(resolved, content)
    },
    chmod: async (pathname, mode) => {
      await chmod(this.absolutize(pathname), mode)
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
