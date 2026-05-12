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

export type ControlPlaneKind = 'local-spawn' | 'docker-exec' | 'brainctl-exec'

export type ControlPlane = {
  readonly kind: ControlPlaneKind
  readonly stdoutByteReliability: 'guaranteed' | 'best-effort' | 'unreliable-large'
  exec(input: ExecInput): Promise<ExecResult>
  start(): Promise<void>
  stop(): Promise<void>
  isRunning(): boolean
  isAvailable(): Promise<RuntimeAvailability>
}

export type DataPlaneKind =
  | 'host-direct'
  | 'bind-mount'
  | 'shared-cluster-fs'
  | 'exec-relay'

export type DataPlane = {
  readonly kind: DataPlaneKind
  readonly independentFromControl: boolean
  readonly reliability: 'fs-semantic' | 'protocol-multiplex' | 'depends-on-control-plane'
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
   * **Daemon-only.** This is harness-internal plumbing for cases where the
   * data was originated on host and needs to land in a path the runtime can
   * see. Tool implementations MUST go through `writeFile()` so sandbox
   * boundaries (permissions, audit, runtime ownership of effects) are
   * preserved. See `lightclaw/CLAUDE.md` "Daemon-only fast IO" note.
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
  /**
   * Symmetric counterpart to {@link writeFileViaHostMount}: read directly
   * from the host-side mount, skipping the brainctl exec + `base64 -w 0`
   * round-trip. **Daemon-only** — only call from harness-internal code
   * (Feishu inline encoders today, future webfetch staging) where the bytes
   * have to flow into the daemon Node process anyway. Tool implementations
   * MUST stay on `readFile()` so sandbox boundaries are preserved (the
   * runtime might enforce path translation, perm narrowing, or future
   * overlay semantics that host-side fs would skip).
   *
   * Returns `null` when the path falls outside `mountTable` or the host
   * read fails (sticky-disabled per-runtime instance after the first
   * failure, parallel to writeFileViaHostMount). Caller transparently
   * falls back to `readFile()`.
   */
  readFileViaHostMount?(pathname: string): Promise<Buffer | null>
}

export type RuntimeFs = DataPlane

export type MountEntry = {
  host: string
  worker: string
  mode: 'rw' | 'ro'
}

export type PathPolicy = {
  readonly mountTable: ReadonlyArray<MountEntry>
  toHostPath(workerPath: string): string | null
  toWorkerPath(hostPath: string): string | null
  isShared(workerPath: string): boolean
  isAllowed(workerPath: string, op: 'read' | 'write' | 'stat'): boolean
}

export type SecurityProfile = 'host-trusted' | 'container-isolated' | 'cluster-isolated'

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
  /** @deprecated since Phase 33 — use securityProfile. */
  readonly isolated: boolean
  /**
   * Workspace root in the environment's own path view.
   * LocalRuntime uses the host path; DockerRuntime will use /workspace.
   */
  readonly workspaceRoot: string
  readonly helperRoot: string
  readonly securityProfile: SecurityProfile
  readonly control: ControlPlane
  readonly data: DataPlane
  readonly paths: PathPolicy

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

  /** @deprecated since Phase 33 — use runtime.control.exec. */
  exec(input: ExecInput): Promise<ExecResult>
  /** @deprecated since Phase 33 — use runtime.data. */
  fs: RuntimeFs
}
