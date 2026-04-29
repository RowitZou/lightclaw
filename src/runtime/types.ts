export type RuntimeKind = 'local' | 'docker' | 'rjob'

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
}

export type RuntimeAvailability =
  | { ok: true }
  | {
      ok: false
      reason: 'image-pulling' | 'image-failed' | 'image-not-attempted' | 'autopull-disabled'
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
