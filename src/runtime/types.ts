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

  exec(input: ExecInput): Promise<ExecResult>
  fs: RuntimeFs
}
