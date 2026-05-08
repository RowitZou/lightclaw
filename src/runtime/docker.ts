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

export type DockerRuntimeSecurity = {
  capDrop: readonly string[]
  capAdd: readonly string[]
  noNewPrivileges: boolean
  readOnlyRootfs: boolean
  pidsLimit: number | null
  ulimits: Readonly<Record<string, string>>
  tmpfsOptions: string
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
  security: DockerRuntimeSecurity
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
// fs.readFile single-hop ceiling: docker exec stdout is unbounded but child_process
// buffering is not. 64 MB covers a 30 MB file (~40 MB base64) plus headroom.
const READ_FILE_BUFFER_BYTES = 64 * 1024 * 1024

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
      // Single-hop with a roomy buffer: docker exec has no ws frame ceiling,
      // so a 30 MB file (~40 MB base64) fits in one read with READ_FILE_BUFFER
      // headroom. If we ever need >50 MB reads, switch to chunked dd like
      // RlaunchRuntime does.
      const result = await this.exec({
        command: `base64 -w 0 ${shellQuote(containerPath)}`,
        maxBufferBytes: READ_FILE_BUFFER_BYTES,
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
    const args = buildDockerCreateArgs(this.cfg)
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

/**
 * Pure builder for `docker create` argv. Extracted from createContainer so
 * the security-flag wiring is unit-testable without spawning docker.
 *
 * Tmpfs entries support per-entry options: a bare path like `"/tmp"` picks
 * up `cfg.security.tmpfsOptions` as the mount option string, while an
 * entry that already contains `:` (e.g. `"/tmp:rw,nosuid,size=1g"`) is
 * used verbatim. This keeps the legacy path-only config working while
 * giving admins full docker-tmpfs syntax when they need it.
 */
export function buildDockerCreateArgs(cfg: DockerRuntimeConfig): string[] {
  const args = [
    'create',
    '--name',
    cfg.containerName,
    '--label',
    'lightclaw.runtime=docker',
    '--label',
    `lightclaw.image=${cfg.image}`,
    '--memory',
    cfg.memoryLimit,
    '--cpus',
    String(cfg.cpuLimit),
    '--network',
    cfg.network,
    '-v',
    `${cfg.workspaceHostPath}:${cfg.workspaceContainerPath}:rw`,
  ]

  const sec = cfg.security
  for (const cap of sec.capDrop) {
    args.push('--cap-drop', cap)
  }
  for (const cap of sec.capAdd) {
    args.push('--cap-add', cap)
  }
  if (sec.noNewPrivileges) {
    args.push('--security-opt', 'no-new-privileges')
  }
  if (sec.readOnlyRootfs) {
    args.push('--read-only')
  }
  if (sec.pidsLimit !== null) {
    args.push('--pids-limit', String(sec.pidsLimit))
  }
  for (const [name, value] of Object.entries(sec.ulimits)) {
    args.push('--ulimit', `${name}=${value}`)
  }

  for (const mount of cfg.mounts) {
    args.push('-v', `${mount.host}:${mount.container}:${mount.mode}`)
  }
  for (const tmpfs of cfg.tmpfs) {
    args.push('--tmpfs', formatTmpfsArg(tmpfs, sec.tmpfsOptions))
  }
  for (const [key, value] of Object.entries(cfg.env)) {
    args.push('-e', `${key}=${value}`)
  }
  args.push(cfg.image, 'sleep', 'infinity')
  return args
}

function formatTmpfsArg(entry: string, defaultOptions: string): string {
  // Per-entry options win: `/tmp:size=1g` is honored verbatim. A bare path
  // (no `:`) picks up the security default so admin-supplied lists like
  // `["/tmp", "/var/tmp"]` get the same hardened mount opts.
  return entry.includes(':') ? entry : `${entry}:${defaultOptions}`
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
