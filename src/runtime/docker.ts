import { spawn } from 'node:child_process'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import type {
  ExecInput,
  ExecResult,
  GlobOptions,
  Runtime,
  RuntimeFs,
  RuntimeStat,
} from './types.js'

export type DockerMount = {
  host: string
  container: string
  mode: 'rw' | 'ro'
}

export type DockerRuntimeConfig = {
  image: string
  workspaceHostPath: string
  containerName: string
  helperContainerPath: string
  workspaceContainerPath: string
  mounts: readonly DockerMount[]
  tmpfs: readonly string[]
  env: Record<string, string>
  memoryLimit: string
  cpuLimit: number
  network: string
  autoPull: boolean
}

type ContainerState =
  | 'absent'
  | 'created'
  | 'running'
  | 'exited'
  | 'paused'
  | 'restarting'
  | 'dead'
  | 'removing'
  | 'unknown'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024
const TMPFS_SIZE = '2g'

export class DockerRuntime implements Runtime {
  readonly kind = 'docker' as const
  readonly isolated = true
  readonly workspaceRoot: string
  readonly helperRoot: string
  readonly containerName: string
  readonly image: string

  lastActivityMs = Date.now()

  private readonly cfg: DockerRuntimeConfig
  private readonly mountTable: Array<[string, string]>
  private lastKnownState: ContainerState = 'unknown'
  private triedPull = false

  constructor(config: DockerRuntimeConfig) {
    this.cfg = config
    this.workspaceRoot = config.workspaceContainerPath
    this.helperRoot = config.helperContainerPath
    this.containerName = config.containerName
    this.image = config.image
    this.mountTable = [
      [path.resolve(config.workspaceHostPath), config.workspaceContainerPath],
      ...config.mounts.map(mount => [
        path.resolve(mount.host),
        path.posix.normalize(mount.container),
      ] as [string, string]),
    ]
  }

  async start(): Promise<void> {
    const state = await this.inspectState()
    if (state === 'running') {
      return
    }
    if (state === 'paused') {
      await this.dockerCmd(['unpause', this.cfg.containerName])
      this.lastKnownState = 'running'
      return
    }
    if (state === 'exited' || state === 'created') {
      await this.dockerCmd(['start', this.cfg.containerName])
      this.lastKnownState = 'running'
      return
    }
    if (state === 'dead' || state === 'removing') {
      await this.dockerCmd(['rm', '-f', this.cfg.containerName]).catch(() => {})
    }

    if (this.cfg.autoPull && !this.triedPull) {
      this.triedPull = true
      await this.ensureImagePulled()
    }

    await this.createContainer()
    await this.dockerCmd(['start', this.cfg.containerName])
    this.lastKnownState = 'running'
  }

  async stop(): Promise<void> {
    const state = await this.inspectState()
    if (state === 'running') {
      await this.dockerCmd(['stop', '--time', '5', this.cfg.containerName])
      this.lastKnownState = 'exited'
    }
  }

  async remove(): Promise<void> {
    await this.dockerCmd(['rm', '-f', this.cfg.containerName]).catch(() => {})
    this.lastKnownState = 'absent'
  }

  isRunning(): boolean {
    return this.lastKnownState === 'running'
  }

  async exec(input: ExecInput): Promise<ExecResult> {
    this.lastActivityMs = Date.now()
    await this.ensureRunning()
    return this.runDockerExec(input)
  }

  fs: RuntimeFs = {
    readFile: async pathname => {
      const containerPath = this.toContainerPath(pathname)
      const result = await this.exec({ command: `cat ${shellQuote(containerPath)}` })
      if (result.exitCode !== 0) {
        throw new Error(`readFile ${pathname}: ${result.stderr.trim() || result.stdout.trim()}`)
      }
      return Buffer.from(result.stdout, 'utf8')
    },
    writeFile: async (pathname, content) => {
      const containerPath = this.toContainerPath(pathname)
      const buffer = typeof content === 'string' ? Buffer.from(content) : content
      const command =
        `mkdir -p "$(dirname ${shellQuote(containerPath)})" && base64 -d > ${shellQuote(containerPath)}`
      const result = await this.exec({
        command,
        stdin: buffer.toString('base64'),
        maxBufferBytes: DEFAULT_MAX_BUFFER_BYTES,
      })
      if (result.exitCode !== 0) {
        throw new Error(`writeFile ${pathname}: ${result.stderr.trim() || result.stdout.trim()}`)
      }
    },
    stat: async (pathname): Promise<RuntimeStat> => {
      const containerPath = this.toContainerPath(pathname)
      const result = await this.exec({
        command: `stat -c '%s|%F|%Y' ${shellQuote(containerPath)}`,
      })
      if (result.exitCode !== 0) {
        throw new Error(`stat ${pathname}: ${result.stderr.trim() || result.stdout.trim()}`)
      }
      const [size, kind, mtime] = result.stdout.trim().split('|')
      return {
        size: Number(size),
        isFile: kind === 'regular file',
        isDirectory: kind === 'directory',
        mtimeMs: Number(mtime) * 1000,
      }
    },
    glob: async (pattern, options: GlobOptions = {}) => {
      const cwd = options.cwd ? this.toContainerPath(options.cwd) : this.workspaceRoot
      const result = await this.exec({
        command: `python3 ${shellQuote(path.posix.join(this.helperRoot, 'glob.py'))}`,
        stdin: JSON.stringify({
          pattern,
          cwd,
          ignore: options.ignore ?? [],
          onlyFiles: options.onlyFiles ?? true,
          dot: options.dot ?? false,
        }),
      })
      if (result.exitCode !== 0) {
        throw new Error(`glob: ${result.stderr.trim() || result.stdout.trim()}`)
      }
      return result.stdout.split('\n').filter(Boolean)
    },
    readdir: async pathname => {
      const containerPath = this.toContainerPath(pathname)
      const result = await this.exec({ command: `ls -A1 ${shellQuote(containerPath)}` })
      if (result.exitCode !== 0) {
        throw new Error(`readdir ${pathname}: ${result.stderr.trim() || result.stdout.trim()}`)
      }
      return result.stdout.split('\n').filter(Boolean)
    },
  }

  private async ensureRunning(): Promise<void> {
    const state = await this.inspectState()
    if (state === 'running') {
      return
    }
    if (state === 'restarting' || state === 'removing') {
      await delay(100)
    }
    await this.start()
  }

  private async runDockerExec(input: ExecInput): Promise<ExecResult> {
    const args = ['exec', '-i', '--workdir', input.cwd ? this.toContainerPath(input.cwd) : this.workspaceRoot]
    if (input.env) {
      for (const [key, value] of Object.entries(input.env)) {
        args.push('-e', `${key}=${value}`)
      }
    }
    args.push(this.cfg.containerName, 'bash', '-c', input.command)
    return runProcess('docker', args, {
      abortSignal: input.abortSignal,
      stdin: input.stdin,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBufferBytes: input.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
      limitMessage: 'container exec terminated',
    })
  }

  private toContainerPath(pathname: string): string {
    const normalizedContainerPath = path.posix.normalize(pathname)
    for (const [, containerPrefix] of this.mountTable) {
      if (normalizedContainerPath === containerPrefix ||
        normalizedContainerPath.startsWith(`${containerPrefix}/`)) {
        return normalizedContainerPath
      }
    }

    const resolved = path.resolve(pathname)
    for (const [hostPrefix, containerPrefix] of this.mountTable) {
      if (resolved === hostPrefix || resolved.startsWith(`${hostPrefix}${path.sep}`)) {
        return path.posix.join(containerPrefix, resolved.slice(hostPrefix.length))
      }
    }

    throw new Error(`Path is not within any DockerRuntime mount: ${pathname}`)
  }

  private async createContainer(): Promise<void> {
    const args = [
      'create',
      '--name',
      this.cfg.containerName,
      '--label',
      'lightclaw.runtime=docker',
      '--label',
      `lightclaw.image=${this.cfg.image}`,
      '--memory',
      this.cfg.memoryLimit,
      '--cpus',
      String(this.cfg.cpuLimit),
      '--network',
      this.cfg.network,
      '-v',
      `${this.cfg.workspaceHostPath}:${this.cfg.workspaceContainerPath}:rw`,
    ]

    for (const mount of this.cfg.mounts) {
      args.push('-v', `${mount.host}:${mount.container}:${mount.mode}`)
    }
    for (const tmpfs of this.cfg.tmpfs) {
      args.push('--tmpfs', `${tmpfs}:size=${TMPFS_SIZE}`)
    }
    for (const [key, value] of Object.entries(this.cfg.env)) {
      args.push('-e', `${key}=${value}`)
    }
    args.push(this.cfg.image, 'sleep', 'infinity')
    await this.dockerCmd(args)
  }

  private async ensureImagePulled(): Promise<void> {
    const exists = await this.dockerCmd(['image', 'inspect', this.cfg.image])
      .then(() => true)
      .catch(() => false)
    if (exists) {
      return
    }
    const result = await runProcess('docker', ['pull', this.cfg.image], {
      timeoutMs: 5 * 60_000,
      maxBufferBytes: 8 * 1024 * 1024,
      limitMessage: 'docker pull terminated',
    })
    if (result.exitCode !== 0) {
      throw new Error(`docker pull ${this.cfg.image} failed: ${result.stderr.trim() || result.stdout.trim()}`)
    }
  }

  private async inspectState(): Promise<ContainerState> {
    const result = await dockerCmdRaw(['inspect', '--format', '{{.State.Status}}', this.cfg.containerName])
    if (result.exitCode !== 0) {
      this.lastKnownState = 'absent'
      return 'absent'
    }
    const state = result.stdout.trim() as ContainerState
    this.lastKnownState = state || 'unknown'
    return this.lastKnownState
  }

  private async dockerCmd(args: string[]): Promise<void> {
    const result = await dockerCmdRaw(args)
    if (result.exitCode !== 0) {
      throw new Error(`docker ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`)
    }
  }
}

export async function dockerCmdRaw(args: string[]): Promise<ExecResult> {
  return runProcess('docker', args, {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxBufferBytes: DEFAULT_MAX_BUFFER_BYTES,
    limitMessage: 'docker command terminated',
  })
}

async function runProcess(
  command: string,
  args: string[],
  options: {
    abortSignal?: AbortSignal
    stdin?: string | Buffer
    timeoutMs: number
    maxBufferBytes: number
    limitMessage: string
  },
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
