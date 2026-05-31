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
  /**
   * Run the command as the container's default user (typically root) instead
   * of dropping privileges to the daemon's uid. Default `false` — every agent-
   * dispatched tool call runs unprivileged so files it creates in the shared
   * workspace are owned by the daemon and the daemon's host-side DataPlane
   * (shared-cluster-fs / bind-mount) can read/write them without EACCES.
   *
   * Set to `true` for backend-internal bootstrap that genuinely needs root:
   * apt staging (`stageHelpersOnce`), ownership bootstrap (`chownWorkspaceOnce`),
   * future NetworkBridge iptables. Never set this from tool code.
   */
  privileged?: boolean
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
  chmod?(pathname: string, mode: number): Promise<void>
  stat(pathname: string): Promise<RuntimeStat>
  readdir(pathname: string): Promise<string[]>
  /**
   * Opportunistic fast path for "host already has the full buffer in memory
   * and the target lives in a host-visible bind mount" — currently Feishu
   * media materialize, future host-side WebFetch downloads. Implementations
   * write directly via host fs and skip the per-32KB brainctl exec
   * round-trips that the legacy `writeFile()` exec-relay path uses.
   *
   * **Harness-internal callers only.** Phase 33 retired the "tools MUST go
   * through writeFile()" hard rule: tools now call `writeFile()` (which
   * routes through `LayeredDataPlane`, picking `bind-mount` /
   * `shared-cluster-fs` automatically when the path lives in the mount
   * table). `writeFileViaHostMount` skips that layered fall-through and is
   * appropriate for channel encoders / media materialization where the
   * bytes are already in the daemon Node process and the caller does not
   * need exec-relay fallback. Sandbox boundaries are enforced by
   * `PathPolicy` (mountTable + ro-mount write gate), not by the choice of
   * fast-path vs `writeFile()`. See `lightclaw/CLAUDE.md` "Runtime
   * Safety Notes" for the current contract.
   *
   * Returns `null` when the runtime cannot satisfy the request via host fs
   * (target falls outside `mountTable`, host can't write to the host-side
   * prefix, runtime backend has no shared mount, etc.). The caller MUST treat
   * `null` as "fast path unavailable" and transparently fall back to
   * `writeFile()` so the call is still safe to make even when the runtime
   * doesn't support it. Only RlaunchRuntime implements this today;
   * LocalRuntime has no need (its `writeFile` is already a host-side write);
   * DockerRuntime can opt in later if a bind mount is detected.
   */
  writeFileViaHostMount?(pathname: string, content: Buffer): Promise<{ ok: true } | null>
  /**
   * Symmetric counterpart to {@link writeFileViaHostMount}: read directly
   * from the host-side mount, skipping the brainctl exec + `base64 -w 0`
   * round-trip. **Harness-internal callers only** (Feishu inline encoders,
   * future webfetch staging) — tools go through `readFile()` which now
   * routes through `LayeredDataPlane` and picks the shared-cluster-fs /
   * bind-mount layer automatically when the path is in the mount table.
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
       * True when the unavailability is expected to clear on its own (image
       * still pulling, worker still scheduling): the next agent turn or a
       * short delay can recover without admin intervention. False for fatal
       * states (`image-failed`, `worker-failed`, `worker-quota-denied`) and
       * for `autopull-disabled` (a config decision, not a transient).
       *
       * Consumed by `query.ts` so the environment-gate `tool_result` carries
       * `is_error: true` only for fatal cases. Retryable cases ship as
       * `is_error: false` so the LLM doesn't get the "tool call failed"
       * mental-model trigger and instead reads the body as a soft backoff.
       */
      retryable: boolean
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
  /**
   * Scratch root in the environment's own path view — a fast, node-local /
   * container-local directory for IO-heavy throwaway work (git clone, build
   * trees, archive extraction).
   *
   * Distinct from `workspaceRoot`: on cluster deployments the workspace sits
   * on a GPFS / shared mount whose small-file metadata ops run ~50x slower
   * than local disk, so git operations that touch thousands of small files
   * pathologically slow down there. `scratchRoot` always points at genuine
   * local disk (DockerRuntime: the container's writable rootfs layer;
   * RlaunchRuntime: the worker pod's node-local filesystem; LocalRuntime: an
   * OS temp dir).
   *
   * Ephemeral: wiped on sandbox reset / container / worker restart. Anything
   * that must persist has to be copied into `workspaceRoot` explicitly.
   */
  readonly scratchRoot: string
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
