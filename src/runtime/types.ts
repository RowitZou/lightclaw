export type RuntimeKind = 'local' | 'docker' | 'rjob'

export type ExecInput = {
  command: string
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  abortSignal?: AbortSignal
  maxBufferBytes?: number
}

export type ExecResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export type RuntimeFs = {
  readFile(pathname: string): Promise<Buffer>
  writeFile(pathname: string, content: Buffer | string): Promise<void>
  stat(pathname: string): Promise<{
    size: number
    isFile: boolean
    isDirectory: boolean
    mtimeMs: number
  }>
}

export type Runtime = {
  readonly kind: RuntimeKind
  readonly isolated: boolean
  readonly workspaceHostPath: string
  readonly workspaceContainerPath: string

  start(): Promise<void>
  stop(): Promise<void>
  isRunning(): boolean

  exec(input: ExecInput): Promise<ExecResult>
  fs: RuntimeFs
}
