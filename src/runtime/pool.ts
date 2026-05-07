import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import path from 'node:path'

import type { LightClawConfig } from '../config.js'
import {
  adminPath,
  sanitizePathSegment,
  workspaceFor,
  workspaceToGpfsMount,
} from '../identity/paths.js'
import { listActiveCanonicalUsers } from '../identity/store.js'

import {
  createRuntime,
  DockerRuntime,
  RlaunchRuntime,
  type DockerRuntimeConfig,
  type RlaunchRuntimeConfig,
} from './index.js'
import { dockerCmdRaw } from './docker.js'
import type { ImageReadinessTracker } from './image-readiness.js'
import { runProcess } from './process.js'
import { deleteWorkerRecord, readWorkerState } from './rlaunch-state.js'
import type { Runtime } from './types.js'
import { WorkerReadinessTracker } from './worker-readiness.js'

const REAPER_INTERVAL_MS = 60_000
const DEFAULT_IMAGE_OWNER = 'rowitzou'
const SANDBOX_PREFIX = 'lightclaw-sandbox-'

export class RuntimePool {
  private readonly runtimes = new Map<string, Runtime>()
  private reaperTimer: NodeJS.Timeout | null = null
  private deploymentHash = computeDeploymentHash()
  private idleTimeoutMs = 1_800_000

  acquire(
    userId: string,
    config: LightClawConfig,
    workspaceHostPath?: string,
    tracker?: ImageReadinessTracker,
  ): Runtime {
    this.idleTimeoutMs = config.runtime.docker.idleTimeoutMs
    const key = runtimeKey(userId, workspaceHostPath)
    const existing = this.runtimes.get(key)
    if (existing?.kind === config.runtime.backend) {
      return existing
    }

    const runtime = this.create(userId, config, workspaceHostPath, tracker)
    this.runtimes.set(key, runtime)
    return runtime
  }

  async release(userId: string, workspaceHostPath?: string): Promise<void> {
    const key = runtimeKey(userId, workspaceHostPath)
    const runtime = this.runtimes.get(key)
    if (runtime) {
      await runtime.stop()
    }
  }

  async remove(
    userId: string,
    workspaceHostPath?: string,
  ): Promise<{ containerName?: string; image?: string }> {
    const key = runtimeKey(userId, workspaceHostPath)
    const runtime = this.runtimes.get(key)
    if (!runtime) {
      return {}
    }
    const result = runtime instanceof DockerRuntime
      ? { containerName: runtime.containerName, image: runtime.image }
      : {}
    await runtime.stop().catch(() => {})
    if (runtime instanceof DockerRuntime) {
      await runtime.remove()
    } else if (runtime instanceof RlaunchRuntime) {
      await runtime.remove()
    }
    this.runtimes.delete(key)
    return result
  }

  async releaseAll(): Promise<void> {
    await Promise.allSettled([...this.runtimes.values()].map(runtime => runtime.stop()))
  }

  /**
   * Total cleanup for a user being removed. Stops + removes any in-pool
   * runtime, then probes the backend by name to clean remnants that the
   * pool didn't know about (cluster worker / docker container that
   * survived from a prior process). Safe to call when nothing exists.
   *
   * Returns what was actually cleaned so callers can surface it to admin.
   */
  async purgeUser(
    userId: string,
    config: LightClawConfig,
  ): Promise<{ rlaunchWorker?: string; dockerContainer?: string }> {
    const summary: { rlaunchWorker?: string; dockerContainer?: string } = {}

    const runtime = this.runtimes.get(userId)
    if (runtime) {
      if (runtime instanceof DockerRuntime) {
        summary.dockerContainer = runtime.containerName
        await runtime.remove()
      } else if (runtime instanceof RlaunchRuntime) {
        summary.rlaunchWorker = runtime.name ?? undefined
        await runtime.remove()
      } else {
        await runtime.stop().catch(() => {})
      }
      this.runtimes.delete(userId)
    }

    if (config.runtime.backend === 'rlaunch') {
      const record = readWorkerState()[userId]
      if (record) {
        summary.rlaunchWorker ??= record.name
        await runProcess('brainctl', [
          '-n', record.namespace,
          'stop', `process/${record.name}`,
        ], {
          timeoutMs: 30_000,
          maxBufferBytes: 1024 * 1024,
          limitMessage: 'brainctl stop process terminated',
        }).catch(() => undefined)
        await deleteWorkerRecord(userId)
      }
    } else if (config.runtime.backend === 'docker') {
      const containerName =
        `${SANDBOX_PREFIX}${sanitizeDockerName(userId)}-${this.deploymentHash}`
      const inspect = await dockerCmdRaw(['inspect', '--format', '{{.Id}}', containerName])
      if (inspect.exitCode === 0) {
        summary.dockerContainer ??= containerName
        await dockerCmdRaw(['rm', '-f', containerName]).catch(() => undefined)
      }
    }

    return summary
  }

  allRuntimes(): Iterable<Runtime> {
    return this.runtimes.values()
  }

  startReaper(): void {
    if (this.reaperTimer) {
      return
    }
    this.reaperTimer = setInterval(() => {
      void this.sweepIdle()
    }, REAPER_INTERVAL_MS)
    this.reaperTimer.unref?.()
  }

  stopReaper(): void {
    if (!this.reaperTimer) {
      return
    }
    clearInterval(this.reaperTimer)
    this.reaperTimer = null
  }

  async sweepOrphans(config: LightClawConfig): Promise<void> {
    if (config.runtime.backend === 'rlaunch') {
      await this.sweepRlaunchOrphans()
      return
    }
    if (config.runtime.backend !== 'docker') {
      return
    }
    const expectedImage = resolveDockerImage(config)
    const activeSanitized = new Set(
      (await listActiveCanonicalUsers()).map(u => sanitizeDockerName(u)),
    )
    const result = await dockerCmdRaw([
      'ps',
      '-a',
      '--filter',
      `name=${SANDBOX_PREFIX}`,
      '--format',
      '{{.Names}}|{{.Image}}|{{.Status}}',
    ])
    if (result.exitCode !== 0) {
      throw new Error(`docker ps failed: ${result.stderr.trim() || result.stdout.trim()}`)
    }

    for (const line of result.stdout.split('\n').filter(Boolean)) {
      const [name, image, status] = line.split('|')
      if (!name?.startsWith(SANDBOX_PREFIX)) {
        continue
      }
      const segments = name.split('-')
      const hash = segments.at(-1)
      const userSegment = segments.slice(2, -1).join('-')
      const statusLower = (status ?? '').toLowerCase()
      const shouldRemove =
        hash !== this.deploymentHash ||
        image !== expectedImage ||
        statusLower.startsWith('dead') ||
        statusLower.startsWith('removing') ||
        !activeSanitized.has(userSegment)
      if (shouldRemove) {
        await dockerCmdRaw(['rm', '-f', name])
      }
    }
  }

  private async sweepRlaunchOrphans(): Promise<void> {
    const state = readWorkerState()
    const activeUsers = new Set(await listActiveCanonicalUsers())
    for (const [canonical, record] of Object.entries(state)) {
      const hashMismatch = record.deploymentHash !== this.deploymentHash
      const userGone = !activeUsers.has(canonical)
      if (!hashMismatch && !userGone) {
        continue
      }
      await runProcess('brainctl', [
        '-n',
        record.namespace,
        'stop',
        `process/${record.name}`,
      ], {
        timeoutMs: 30_000,
        maxBufferBytes: 1024 * 1024,
        limitMessage: 'brainctl stop process terminated',
      }).catch(() => undefined)
      await deleteWorkerRecord(canonical)
    }
  }

  private async sweepIdle(): Promise<void> {
    const now = Date.now()
    for (const runtime of this.runtimes.values()) {
      if (!(runtime instanceof DockerRuntime) || !runtime.isRunning()) {
        continue
      }
      if (now - runtime.lastActivityMs <= this.idleTimeoutMs) {
        continue
      }
      if (Date.now() - runtime.lastActivityMs > this.idleTimeoutMs) {
        await runtime.stop().catch(() => {})
      }
    }
  }

  private create(
    userId: string,
    config: LightClawConfig,
    workspaceRoot?: string,
    tracker?: ImageReadinessTracker,
  ): Runtime {
    const workspaceHostPath = path.resolve(workspaceRoot ?? workspaceFor(userId))
    // Ensure the per-user workspace dir exists before any backend hands the
    // path to a bind-mount. RlaunchRuntime in particular fails fast at the
    // kubelet `hostPath type check` (5 min ForceGC, then a fresh failed
    // worker) when the GPFS dir is missing — the channel runner's
    // resetSessionContext mkdir doesn't cover preheat-on-approval /
    // preheat-on-startup / `/sandbox prefetch`, all of which acquire a
    // runtime without going through that path.
    mkdirSync(workspaceHostPath, { recursive: true, mode: 0o700 })
    if (config.runtime.backend === 'local') {
      return createRuntime({
        kind: 'local',
        workspaceRoot: workspaceHostPath,
        proxy: config.runtime.network.proxy,
        noProxy: config.runtime.network.noProxy,
      })
    }
    if (config.runtime.backend === 'docker') {
      if (!tracker) {
        throw new Error(
          'DockerRuntime requires an ImageReadinessTracker; pass it via RuntimePool.acquire().',
        )
      }
      return createRuntime({
        kind: 'docker',
        config: buildDockerRuntimeConfig(userId, workspaceHostPath, config, this.deploymentHash),
        tracker,
      })
    }
    if (config.runtime.backend === 'rlaunch') {
      return createRuntime({
        kind: 'rlaunch',
        config: buildRlaunchRuntimeConfig(userId, workspaceHostPath, config, this.deploymentHash),
        tracker: new WorkerReadinessTracker(userId),
      })
    }
    return createRuntime({ kind: 'rjob' })
  }
}

function runtimeKey(userId: string, workspaceHostPath?: string): string {
  return userId === '__terminal__' && workspaceHostPath
    ? `${userId}:${path.resolve(workspaceHostPath)}`
    : userId
}

export function resolveDockerImage(config: LightClawConfig): string {
  return config.runtime.docker.imageOverride ??
    config.runtime.docker.image ??
    defaultImageRef()
}

export function buildDockerRuntimeConfig(
  userId: string,
  workspaceHostPath: string,
  config: LightClawConfig,
  deploymentHash = computeDeploymentHash(),
): DockerRuntimeConfig {
  const docker = config.runtime.docker
  const network = config.runtime.network
  // mode=host puts the container in the host's net namespace and routes its
  // proxy env through the in-process NetworkBridge over loopback. Admin env
  // wins (...docker.env last) so per-user overrides remain authoritative.
  const useHost = network.mode === 'host'
  const dockerNetwork = useHost ? 'host' : docker.network
  const env = useHost
    ? { ...buildBridgeEnv('127.0.0.1', network.port, network.noProxy), ...docker.env }
    : docker.env
  return {
    image: resolveDockerImage(config),
    workspaceHostPath,
    containerName: `${SANDBOX_PREFIX}${sanitizeDockerName(userId)}-${deploymentHash}`,
    helperContainerPath: '/opt/lightclaw/sandbox-helpers',
    workspaceContainerPath: '/workspace',
    mounts: docker.mounts,
    tmpfs: docker.tmpfs,
    env,
    memoryLimit: docker.memoryLimit,
    cpuLimit: docker.cpuLimit,
    network: dockerNetwork,
    autoPull: docker.autoPull,
  }
}

export function buildRlaunchRuntimeConfig(
  userId: string,
  workspaceHostPath: string,
  config: LightClawConfig,
  deploymentHash = computeDeploymentHash(),
): RlaunchRuntimeConfig {
  const rlaunch = config.runtime.rlaunch
  const network = config.runtime.network
  const gpfs = workspaceToGpfsMount(userId, rlaunch)
  // rlaunch worker is on a different cluster node, so it cannot reach the
  // bridge over loopback — point at the host's first non-internal IPv4.
  const env = network.mode === 'host'
    ? { ...buildBridgeEnv(detectHostIp(), network.port, network.noProxy), ...rlaunch.env }
    : rlaunch.env
  return {
    canonicalUser: userId,
    deploymentHash,
    image: rlaunch.image,
    chargedGroup: rlaunch.chargedGroup,
    namespace: rlaunch.namespace,
    cpu: rlaunch.cpu,
    memoryMb: rlaunch.memoryMb,
    gpu: rlaunch.gpu,
    privateMachine: rlaunch.privateMachine,
    positiveTags: rlaunch.positiveTags,
    workerGcTimeHours: rlaunch.workerGcTimeHours,
    imagePullPolicy: rlaunch.imagePullPolicy,
    maxWaitDuration: rlaunch.maxWaitDuration,
    predictBeforeStart: rlaunch.predictBeforeStart,
    workspaceHostPath: gpfs.hostPath || workspaceHostPath,
    workspaceGpfsMount: gpfs.mount,
    helperContainerPath: '/opt/lightclaw/sandbox-helpers',
    workspaceContainerPath: '/workspace',
    env,
  }
}

export function buildBridgeEnv(
  host: string,
  port: number,
  noProxy: readonly string[] = [],
): Record<string, string> {
  const url = `http://${host}:${port}`
  // The bridge itself already enforces no_proxy on the upstream-routing
  // side, but the in-container env is what user shell tools (curl,
  // pnpm, git, etc.) consult — so we mirror the same list into the
  // env so those tools skip the bridge entirely for matching destinations.
  const builtin = ['localhost', '127.0.0.1', '::1', '.local']
  const merged = [...builtin, ...noProxy.filter(Boolean)].join(',')
  return {
    http_proxy: url,
    https_proxy: url,
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    no_proxy: merged,
    NO_PROXY: merged,
  }
}

export function detectHostIp(): string {
  const ifaces = networkInterfaces()
  for (const list of Object.values(ifaces)) {
    if (!list) continue
    for (const entry of list) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return entry.address
      }
    }
  }
  // Fallback — admin can override via runtime.network.bindHost; if even
  // that is 0.0.0.0 the rlaunch pod cannot reach back, but the bridge
  // will still spawn so we surface a clearer failure later.
  return '127.0.0.1'
}

function computeDeploymentHash(): string {
  const target = adminPath()
  if (!existsSync(target)) {
    return 'noadmin0'
  }
  return createHash('sha256')
    .update(readFileSync(target))
    .digest('hex')
    .slice(0, 8)
}

function sanitizeDockerName(userId: string): string {
  return sanitizePathSegment(userId)
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/^-+|-+$/g, '') || 'user'
}

function defaultImageRef(): string {
  const version = readPackageVersion()
  const owner = (process.env.LIGHTCLAW_DOCKER_OWNER ?? DEFAULT_IMAGE_OWNER).toLowerCase()
  return `ghcr.io/${owner}/lightclaw-sandbox:${version}`
}

function readPackageVersion(): string {
  const dirname = fileDirname()
  const candidates = [
    path.resolve(dirname, '../../package.json'),
    path.resolve(dirname, '../package.json'),
    path.resolve(process.cwd(), 'package.json'),
    path.resolve(homedir(), 'workspace/lightclaw/package.json'),
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue
    }
    const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: string }
    if (parsed.version) {
      return parsed.version
    }
  }
  return '0.1.0'
}

function fileDirname(): string {
  return path.dirname(new URL(import.meta.url).pathname)
}
