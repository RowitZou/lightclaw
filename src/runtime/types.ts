export type RuntimeKind = 'local' | 'docker' | 'rlaunch' | 'rjob'

export type ExecInput = {
  command: string
  /**
   * Runtime-view working directory. LocalRuntime resolves this against the host
   * workspace; container backends should treat it as an environment path.
   */
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  abortSignal?: AbortSignal
  maxBufferBytes?: number
  stdin?: string | Buffer
}

export type ExecResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export type RuntimeStat = {
  size: number
  isFile: boolean
  isDirectory: boolean
  mtimeMs: number
}

export type GlobOptions = {
  cwd?: string
  ignore?: string[]
  onlyFiles?: boolean
  dot?: boolean
}

export type RuntimeFs = {
  readFile(pathname: string): Promise<Buffer>
  writeFile(pathname: string, content: Buffer | string): Promise<void>
  stat(pathname: string): Promise<RuntimeStat>
  glob(pattern: string | string[], options?: GlobOptions): Promise<string[]>
  readdir(pathname: string): Promise<string[]>
  /**
   * Opportunistic fast path for "host already has the full buffer in memory and
   * the target lives in a host-visible bind mount" — currently Feishu media
   * materialize, future host-side WebFetch downloads. Implementations write
   * directly via host fs and skip the per-32KB exec round-trips that the
   * sandbox-safe `writeFile` uses for fairness/sandbox reasons.
   *
   * Returns `null` when the runtime cannot satisfy the request via host fs
   * (target falls outside `mountTable`, host can't write to the host-side
   * prefix, runtime backend has no shared mount, etc.). The caller MUST treat
   * `null` as "fast path unavailable" and transparently fall back to
   * `writeFile()` so the call is still safe to make even when the runtime
   * doesn't support it. Only RlaunchRuntime implements this today; LocalRuntime
   * has no need (its `writeFile` is already a host-side write); DockerRuntime
   * can opt in later if a bind mount is detected.
   */
  writeFileViaHostMount?(pathname: string, content: Buffer): Promise<{ ok: true } | null>
}

export type RuntimeAvailability =
  | { ok: true }
  | {
      ok: false
      reason: 'image-pulling' | 'image-failed' | 'image-not-attempted' | 'autopull-disabled'
        | 'worker-scheduling' | 'worker-failed' | 'worker-quota-denied'
      /**
       * Channel-user-facing message: soft, no docker stderr leakage.
       */
      userMessage: string
      /**
       * Admin-facing message with formatPullError translation. Shown only via
       * stderr / admin push, never to channel end users.
       */
      adminMessage: string
    }

export type Runtime = {
  readonly kind: RuntimeKind
  readonly isolated: boolean
  /**
   * Workspace root in the environment's own path view.
   * LocalRuntime uses the host path; DockerRuntime will use /workspace.
   */
  readonly workspaceRoot: string
  readonly helperRoot: string

  start(): Promise<void>
  stop(): Promise<void>
  isRunning(): boolean
  /**
   * True iff the runtime can serve environment-domain tool calls *right now*.
   * LocalRuntime always returns ok. DockerRuntime consults the
   * ImageReadinessTracker — pulling/failed states return ok=false so the
   * agent loop can synthesize a graceful tool_result instead of blocking.
   */
  isAvailable(): Promise<RuntimeAvailability>

  exec(input: ExecInput): Promise<ExecResult>
  fs: RuntimeFs
}
