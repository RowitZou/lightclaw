import path from 'node:path'

import type {
  ExecInput,
  ExecResult,
  GlobOptions,
  Runtime,
  RuntimeAvailability,
  RuntimeFs,
  RuntimeStat,
} from './types.js'
import {
  ImageReadinessTracker,
  isImageMissingError,
  formatPullError,
} from './image-readiness.js'
import { runProcess, shellQuote } from './process.js'

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
  private readonly tracker: ImageReadinessTracker
  private lastKnownState: ContainerState = 'unknown'

  constructor(config: DockerRuntimeConfig, tracker: ImageReadinessTracker) {
    this.cfg = config
    this.tracker = tracker
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

    // Image readiness is the tracker's responsibility. Container creation
    // assumes ready; if the image is gone we surface the rollback path in
    // createContainer's catch.
    await this.createContainer()
    await this.dockerCmd(['start', this.cfg.containerName])
    this.lastKnownState = 'running'
  }

  async isAvailable(): Promise<RuntimeAvailability> {
    const snap = this.tracker.snapshot()
    if (snap.state === 'ready') return { ok: true }
    if (snap.state === 'pulling') {
      const elapsed = snap.pullDurationMs ? Math.round(snap.pullDurationMs / 1000) : 0
      return {
        ok: false,
        reason: 'image-pulling',
        userMessage:
          `Sandbox 镜像还在准备中（已 ${elapsed} 秒）。我现在不能执行命令、读写文件或抓取网页，` +
          '但可以继续聊天讨论。要不你先告诉我你想做什么，我帮你想思路？',
        adminMessage: `Sandbox 镜像 ${snap.image ?? this.cfg.image} 拉取中（已 ${elapsed} 秒）`,
      }
    }
    if (snap.state === 'failed') {
      // autoPull-disabled is encoded as failed with a marker error.
      const isAutoPullOff = snap.lastError?.startsWith('AUTOPULL_DISABLED:')
      if (isAutoPullOff) {
        return {
          ok: false,
          reason: 'autopull-disabled',
          userMessage:
            '管理员已禁用自动镜像拉取，需要联系管理员准备 sandbox 后才能用工具。' +
            '当前我可以处理聊天类话题。',
          adminMessage:
            `runtime.docker.autoPull = false 已禁用自动拉取，且本地无 ${this.cfg.image}；` +
            `请手动 docker pull ${this.cfg.image} 或将 autoPull 设回 true。`,
        }
      }
      return {
        ok: false,
        reason: 'image-failed',
        userMessage:
          'Sandbox 镜像未就绪。已通知管理员，目前我只能处理聊天类话题。',
        adminMessage:
          `Sandbox 镜像 ${snap.image ?? this.cfg.image} 拉取失败：\n${snap.lastError ?? '未知错误'}`,
      }
    }
    return {
      ok: false,
      reason: 'image-not-attempted',
      userMessage:
        'Sandbox 镜像还未开始准备。我现在只能处理聊天类话题。',
      adminMessage:
        `ImageReadinessTracker 未触发 prefetch（image=${this.cfg.image}）；` +
        '检查 init.ts 是否在 docker backend 下调用了 startPrefetch。',
    }
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
      // base64 transit keeps binary content intact across the docker exec
      // string pipe (StringDecoder is UTF-8 and would mangle non-text bytes).
      const result = await this.exec({
        command: `base64 -w 0 ${shellQuote(containerPath)}`,
      })
      if (result.exitCode !== 0) {
        throw new Error(`readFile ${pathname}: ${result.stderr.trim() || result.stdout.trim()}`)
      }
      return Buffer.from(result.stdout.trim(), 'base64')
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
    try {
      await this.dockerCmd(args)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Image was inspect-ready earlier but createContainer can't find it now —
      // most likely external `docker rmi` (D2) or layer corruption (D7). Roll
      // tracker back to failed so the next inbound message retries the pull.
      if (isImageMissingError(message)) {
        this.tracker.markFailed(formatPullError(message))
      }
      throw err
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

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
