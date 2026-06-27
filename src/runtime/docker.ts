import { randomUUID } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import path from 'node:path'

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
import {
  ImageReadinessTracker,
  isImageMissingError,
  formatPullError,
} from './image-readiness.js'
import { BindMountData } from './data-plane/bind-mount.js'
import { withByteBudget } from './byte-budget.js'
import { LayeredDataPlane } from './data-plane/layered.js'
import { assertMountsAccessible, MountTablePathPolicy } from './path-policy/mount-table.js'
import { runProcess, shellQuote } from './process.js'
import { sandboxBackstopTimeoutMs, wrapSandboxCommandWithTimeout } from './exec-wrap.js'

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
  /** docker create `--storage-opt size=<value>` cap on rootfs writable
   *  layer. Null omits the flag. Requires overlay2 + XFS prjquota. */
  storageOptSize: string | null
  /** Hard cap (MiB) on `/workspace` bind-mount usage; null disables. */
  workspaceQuotaMb: number | null
}

export type DockerRuntimeConfig = {
  image: string
  workspaceHostPath: string
  containerName: string
  workspaceContainerPath: string
  mounts: readonly DockerMount[]
  tmpfs: readonly string[]
  env: Record<string, string>
  memoryLimit: string
  cpuLimit: number
  network: string
  autoPull: boolean
  maxExecRelayBytes?: number
  security: DockerRuntimeSecurity
  /**
   * The uid/gid agent-dispatched (non-privileged) execs drop to via
   * `docker exec --user`. Defaults to the daemon's own uid/gid at
   * `buildDockerRuntimeConfig` time. Files the agent creates in the
   * bind-mounted workspace are then daemon-owned, so the host-direct
   * `BindMountData` layer (which reads/writes as the daemon uid) has no
   * EACCES surface — the Docker analogue of RlaunchRuntime's setpriv wrap.
   * `ExecInput.privileged === true` bypasses the drop and runs as root for
   * bootstrap-only callers. When the daemon itself runs as root these are 0,
   * i.e. the historical default-user behavior, so root-daemon deployments are
   * unaffected.
   */
  daemonUid: number
  daemonGid: number
}

export type ContainerState =
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
// Cache TTL for the workspace `du` poll. Du on a multi-GB workspace is not
// free, but a 60s lag on quota detection is acceptable: the quota is the
// runaway-write tripwire, not a precise accountant.
const WORKSPACE_DU_CACHE_MS = 60_000
// Container-local scratch dir for IO-heavy throwaway work (git clone /
// build / archive extraction). Lives on the container's writable rootfs
// layer — overlay2 on the daemon host's local disk, bounded by the existing
// `storageOptSize` cap — so small-file ops run at local-disk speed instead
// of paying the GPFS metadata penalty of the workspace bind mount.
// Provisioned by `ensureScratchDir`; see `Runtime.scratchRoot`.
const SCRATCH_DIR = '/scratch'
// exec-relay read cap for the LayeredDataPlane. Unlike rlaunch's brainctl
// channel (`unreliable-large`, capped at the conservative 4MB default),
// `docker exec` stdout is `guaranteed`, so this tracks the real single-hop
// capability: 32 MiB base64-expands to ~42MB, within READ_FILE_BUFFER_BYTES
// (64MB) headroom. Container-local reads (`/tmp`, …) up to this size flow
// through exec-relay instead of being pre-refused.
const DEFAULT_MAX_EXEC_RELAY_BYTES = 1024 * 1024 * 1024

export class DockerRuntime implements Runtime {
  readonly kind = 'docker' as const
  readonly isolated = true
  readonly securityProfile = 'container-isolated' as const
  readonly workspaceRoot: string
  readonly scratchRoot: string
  readonly containerName: string
  readonly image: string
  readonly control: ControlPlane
  readonly data: DataPlane
  readonly paths: PathPolicy
  readonly fs: RuntimeFs

  lastActivityMs = Date.now()

  private readonly cfg: DockerRuntimeConfig
  private readonly mountTable: Array<[string, string]>
  private readonly tracker: ImageReadinessTracker
  private lastKnownState: ContainerState = 'unknown'
  private workspaceUsageBytes = 0
  private workspaceUsageCheckedAtMs = 0
  private workspaceUsageInflight: Promise<number> | null = null
  // Memoizes scratch-dir provisioning for the current container. Reset on
  // container recreate (`createContainer`) and removal (`remove`) so a fresh
  // rootfs gets re-provisioned.
  private scratchReady = false
  // The current container id, refreshed by `inspectState`. Serves as the
  // restart "generation" token for `currentGeneration()`; null before any
  // container has been inspected / created and after `remove()`.
  private currentContainerId: string | null = null

  constructor(config: DockerRuntimeConfig, tracker: ImageReadinessTracker) {
    this.cfg = config
    this.tracker = tracker
    this.workspaceRoot = config.workspaceContainerPath
    this.scratchRoot = SCRATCH_DIR
    this.containerName = config.containerName
    this.image = config.image
    this.mountTable = [
      [path.resolve(config.workspaceHostPath), config.workspaceContainerPath],
      ...config.mounts.map(mount => [
        path.resolve(mount.host),
        path.posix.normalize(mount.container),
      ] as [string, string]),
    ]
    this.control = {
      kind: 'docker-exec',
      stdoutByteReliability: 'guaranteed',
      exec: input => this.exec(input),
      start: () => this.start(),
      stop: () => this.stop(),
      isRunning: () => this.isRunning(),
      isAvailable: () => this.isAvailable(),
    }
    this.paths = new MountTablePathPolicy([
      {
        host: config.workspaceHostPath,
        worker: config.workspaceContainerPath,
        mode: 'rw',
      },
      ...config.mounts.map(mount => ({
        host: mount.host,
        worker: mount.container,
        mode: mount.mode,
      })),
    ])
    const bindMountData = new BindMountData(this.paths)
    const guardedBindMountData: DataPlane = {
      kind: bindMountData.kind,
      independentFromControl: bindMountData.independentFromControl,
      reliability: bindMountData.reliability,
      readFile: async pathname => {
        await this.ensureRunning()
        return bindMountData.readFile(pathname)
      },
      writeFile: async (pathname, content) => {
        await this.ensureRunning()
        await this.assertWorkspaceQuota()
        return bindMountData.writeFile(pathname, content)
      },
      chmod: async (pathname, mode) => {
        await this.ensureRunning()
        return bindMountData.chmod(pathname, mode)
      },
      stat: async pathname => {
        await this.ensureRunning()
        return bindMountData.stat(pathname)
      },
      readdir: async pathname => {
        await this.ensureRunning()
        return bindMountData.readdir(pathname)
      },
    }
    this.data = withByteBudget(new LayeredDataPlane(
      [
        guardedBindMountData,
        this.execRelayFs,
      ],
      this.paths,
      { maxExecRelayBytes: config.maxExecRelayBytes ?? DEFAULT_MAX_EXEC_RELAY_BYTES },
    ))
    this.fs = this.data
  }

  async start(): Promise<void> {
    // Fail fast on misconfigured host mounts before any docker action.
    // BindMountData / LayeredDataPlane assume daemon can reach mount.host;
    // without this probe a permission / ENOENT misconfig would only surface
    // as a sticky-disabled stderr line on the first tool call, silently
    // routing all reads back through docker exec.
    await assertMountsAccessible(this.paths, 'docker')

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
    // Re-inspect so `currentContainerId` reflects the freshly created
    // container's id (its rootfs is new — /tmp, /scratch, in-container
    // processes are gone). The reuse branches above kept the existing
    // container, whose id the top-of-start inspectState already captured.
    await this.inspectState()
  }

  async isAvailable(): Promise<RuntimeAvailability> {
    const snap = this.tracker.snapshot()
    if (snap.state === 'ready') return { ok: true }
    if (snap.state === 'pulling') {
      const elapsed = snap.pullDurationMs ? Math.round(snap.pullDurationMs / 1000) : 0
      return {
        ok: false,
        reason: 'image-pulling',
        retryable: true,
        userMessage:
          `Sandbox 镜像还在准备中（已 ${elapsed} 秒）。` +
          '如果不急，可以下一轮再发起同一个工具调用；或者继续聊别的话题，等镜像就绪后再回来。',
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
          retryable: false,
          userMessage:
            '管理员已禁用自动镜像拉取，需要联系管理员准备 sandbox 后才能用工具。' +
            '当前我可以处理聊天类话题。',
          adminMessage:
            `runtime.dockerSettings.autoPull = false 已禁用自动拉取，且本地无 ${this.cfg.image}；` +
            `请手动 docker pull ${this.cfg.image} 或将 autoPull 设回 true。`,
        }
      }
      return {
        ok: false,
        reason: 'image-failed',
        retryable: false,
        userMessage:
          'Sandbox 镜像未就绪。已通知管理员，目前我只能处理聊天类话题。',
        adminMessage:
          `Sandbox 镜像 ${snap.image ?? this.cfg.image} 拉取失败：\n${snap.lastError ?? '未知错误'}`,
      }
    }
    return {
      ok: false,
      reason: 'image-not-attempted',
      retryable: true,
      userMessage:
        'Sandbox 镜像还未开始准备。我现在只能处理聊天类话题，过一会再试同一个工具调用即可。',
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
    this.scratchReady = false
    this.currentContainerId = null
  }

  isRunning(): boolean {
    return this.lastKnownState === 'running'
  }

  /**
   * Restart "generation" token: the current container id. It changes whenever
   * the container is replaced (`createContainer` after a dead/removing state,
   * or after `remove()`), which is exactly when container-local /tmp /scratch
   * and in-container processes are lost. `query.ts` diffs this per session to
   * inject the runtime-restart reminder. Null before any container has been
   * inspected / created. Mirrors RlaunchRuntime.currentGeneration (worker name).
   */
  currentGeneration(): string | null {
    return this.currentContainerId
  }

  async exec(input: ExecInput): Promise<ExecResult> {
    this.lastActivityMs = Date.now()
    await this.ensureRunning()
    await this.assertWorkspaceQuota()
    // Wrap agent commands so the container kills the command's whole process
    // tree on timeout: killing the local `docker exec` client does NOT reach
    // the in-container process (Bug 4). Skipped when stdin is set — those are
    // harness-internal fast IO (execRelayFs.writeFile) that spawn no tree and
    // whose stdin should not detour through the wrapper's setsid child.
    if (input.stdin === undefined) {
      const budgetMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
      return this.runDockerExec({
        ...input,
        command: wrapSandboxCommandWithTimeout(input.command, budgetMs),
        timeoutMs: sandboxBackstopTimeoutMs(budgetMs),
      })
    }
    return this.runDockerExec(input)
  }

  private readonly execRelayFs: RuntimeFs = {
    kind: 'exec-relay',
    independentFromControl: false,
    reliability: 'depends-on-control-plane',
    readFile: async pathname => {
      const containerPath = this.toContainerPath(pathname)
      const id = randomUUID()
      const stageContainer = path.posix.join(this.workspaceRoot, '.lightclaw', 'exec', `${id}.read`)
      const stageHost = path.join(this.cfg.workspaceHostPath, '.lightclaw', 'exec', `${id}.read`)
      const result = await this.exec({
        command: `mkdir -p ${shellQuote(path.posix.dirname(stageContainer))} && cp -- ${shellQuote(containerPath)} ${shellQuote(stageContainer)}`,
      })
      if (result.exitCode !== 0) {
        throw new Error(`readFile ${pathname}: ${result.stderr.trim() || result.stdout.trim()}`)
      }
      try {
        return await fsp.readFile(stageHost)
      } finally {
        await fsp.rm(stageHost, { force: true }).catch(() => undefined)
      }
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
    chmod: async (pathname, mode) => {
      const containerPath = this.toContainerPath(pathname)
      const result = await this.exec({ command: `chmod ${mode.toString(8)} ${shellQuote(containerPath)}` })
      if (result.exitCode !== 0) {
        throw new Error(`chmod ${pathname}: ${result.stderr.trim() || result.stdout.trim()}`)
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
    if (state !== 'running') {
      if (state === 'restarting' || state === 'removing') {
        await delay(100)
      }
      await this.start()
    }
    await this.ensureScratchDir()
  }

  /**
   * Provision the container-local scratch dir (`SCRATCH_DIR`) once per
   * container lifecycle. The mkdir runs as root (`-u 0`) because the
   * filesystem root is not writable by the image's unprivileged user;
   * `chmod 1777` then lets agent-dispatched execs (which run as that
   * unprivileged user) write there. Memoized via `scratchReady`, reset on
   * container recreate. Non-fatal on failure: the agent can still work in
   * the workspace mount — scratch is only the fast path for git-heavy work.
   */
  private async ensureScratchDir(): Promise<void> {
    if (this.scratchReady) return
    const result = await dockerCmdRaw([
      'exec', '-u', '0', this.cfg.containerName, 'bash', '-c',
      `mkdir -p ${shellQuote(this.scratchRoot)} && chmod 1777 ${shellQuote(this.scratchRoot)}`,
    ])
    if (result.exitCode !== 0) {
      process.stderr.write(
        `[docker] failed to provision scratch dir ${this.scratchRoot} in ` +
        `${this.cfg.containerName}: ${result.stderr.trim() || result.stdout.trim()}\n`,
      )
      return
    }
    this.scratchReady = true
  }

  private async assertWorkspaceQuota(): Promise<void> {
    const limitMb = this.cfg.security.workspaceQuotaMb
    if (limitMb === null) return
    const used = await this.getWorkspaceUsageBytes()
    const limitBytes = limitMb * 1024 * 1024
    if (used > limitBytes) {
      const usedMb = Math.round(used / 1024 / 1024)
      throw new Error(
        `workspace quota exceeded: ${usedMb} MiB used > ${limitMb} MiB limit at ${this.workspaceRoot}. ` +
        `Clean up files or raise runtime.dockerSettings.security.workspaceQuotaMb.`,
      )
    }
  }

  // `du -sb` runs inside the container against the bind-mounted workspace,
  // so the result reflects host-fs usage. Cached for WORKSPACE_DU_CACHE_MS
  // because du on a multi-GB tree is not free; concurrent calls coalesce
  // through a single inflight promise. A failed du does not block the
  // operation — we keep the prior cached value rather than spuriously
  // refusing exec when the helper transiently fails.
  private async getWorkspaceUsageBytes(): Promise<number> {
    const now = Date.now()
    if (now - this.workspaceUsageCheckedAtMs < WORKSPACE_DU_CACHE_MS) {
      return this.workspaceUsageBytes
    }
    if (this.workspaceUsageInflight) return this.workspaceUsageInflight
    this.workspaceUsageInflight = (async () => {
      try {
        const result = await this.runDockerExec({
          command: `du -sb ${shellQuote(this.workspaceRoot)} 2>/dev/null | awk '{print $1}'`,
        })
        if (result.exitCode === 0) {
          const bytes = Number.parseInt(result.stdout.trim(), 10)
          if (Number.isFinite(bytes) && bytes >= 0) {
            this.workspaceUsageBytes = bytes
            this.workspaceUsageCheckedAtMs = Date.now()
          }
        }
      } catch {
        // swallow: keep cached value, retry on next exec
      }
      return this.workspaceUsageBytes
    })().finally(() => {
      this.workspaceUsageInflight = null
    })
    return this.workspaceUsageInflight
  }

  private async runDockerExec(input: ExecInput): Promise<ExecResult> {
    const args = buildDockerExecArgs({
      containerName: this.cfg.containerName,
      workdir: input.cwd ? this.toContainerPath(input.cwd) : this.workspaceRoot,
      env: input.env,
      command: input.command,
      // Agent-dispatched (non-privileged) execs drop to the daemon uid so the
      // files they create in the workspace bind mount are daemon-owned and the
      // host-direct BindMountData layer has no EACCES surface. Only bootstrap
      // callers set privileged; root-daemon deployments resolve to `0:0`.
      user: input.privileged === true
        ? '0:0'
        : `${this.cfg.daemonUid}:${this.cfg.daemonGid}`,
    })
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

    // Host-side absolute paths under a configured mount → translated.
    const resolved = path.resolve(pathname)
    for (const [hostPrefix, containerPrefix] of this.mountTable) {
      if (resolved === hostPrefix || resolved.startsWith(`${hostPrefix}${path.sep}`)) {
        return path.posix.join(containerPrefix, resolved.slice(hostPrefix.length))
      }
    }

    // Container-local absolute paths (`/tmp`, `/var/log`, `/proc/...`) pass
    // through to docker exec; container isolation + permission system are the
    // safety boundary. Mirrors rlaunch's same fix; finishes the 18ff987 sweep.
    if (path.posix.isAbsolute(normalizedContainerPath)) {
      return normalizedContainerPath
    }

    throw new Error(`Path is not absolute: ${pathname}`)
  }

  private async createContainer(): Promise<void> {
    // Fresh rootfs incoming — the scratch dir must be re-provisioned.
    this.scratchReady = false
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
    const result = await dockerCmdRaw([
      'inspect', '--format', '{{.Id}} {{.State.Status}}', this.cfg.containerName,
    ])
    if (result.exitCode !== 0) {
      this.lastKnownState = 'absent'
      this.currentContainerId = null
      return 'absent'
    }
    const { id, state } = parseDockerInspect(result.stdout)
    this.currentContainerId = id
    this.lastKnownState = state
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
  if (sec.storageOptSize !== null) {
    args.push('--storage-opt', `size=${sec.storageOptSize}`)
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

/**
 * Pure builder for `docker exec` argv. Extracted so the `--user` uid-drop
 * (the Docker analogue of RlaunchRuntime's setpriv wrap) is unit-testable
 * without spawning docker. `-u` is always emitted: agent-dispatched execs pass
 * the daemon `uid:gid`, bootstrap-only callers pass `0:0`, and a root daemon
 * naturally resolves to `0:0` (the historical default-user behavior).
 */
export function buildDockerExecArgs(opts: {
  containerName: string
  workdir: string
  command: string
  env?: Record<string, string>
  user: string
}): string[] {
  const args = ['exec', '-i', '-u', opts.user, '--workdir', opts.workdir]
  if (opts.env) {
    for (const [key, value] of Object.entries(opts.env)) {
      args.push('-e', `${key}=${value}`)
    }
  }
  args.push(opts.containerName, 'bash', '-c', opts.command)
  return args
}

/**
 * Parse `docker inspect --format '{{.Id}} {{.State.Status}}'` output into the
 * container id (the restart "generation" token) and lifecycle state. A blank /
 * malformed line yields `{ id: null, state: 'unknown' }` so a transient
 * inspect glitch never fabricates a generation.
 */
export function parseDockerInspect(
  stdout: string,
): { id: string | null; state: ContainerState } {
  const trimmed = stdout.trim()
  if (!trimmed) return { id: null, state: 'unknown' }
  const sep = trimmed.indexOf(' ')
  const id = sep === -1 ? trimmed : trimmed.slice(0, sep)
  const stateRaw = sep === -1 ? '' : trimmed.slice(sep + 1).trim()
  return { id: id || null, state: (stateRaw || 'unknown') as ContainerState }
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
