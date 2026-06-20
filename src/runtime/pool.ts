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
import { runProcess, withoutProxyEnv } from './process.js'
import { deleteWorkerRecord, readWorkerState } from './rlaunch-state.js'
import {
  resolveUserRlaunchRuntimeMounts,
  rlaunchMountFingerprint,
} from './rlaunch-mounts.js'
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
    this.idleTimeoutMs = config.runtime.dockerSettings.idleTimeoutMs
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
    if (runtime instanceof RlaunchRuntime) {
      // Mark retired BEFORE tearing down so any concurrent mid-turn ALS
      // reference to this instance forwards to whatever the pool serves up
      // next (initially nothing; once the caller / next turn re-acquires,
      // the new entry takes over). Stop / remove run after the flag is set
      // so an exec arriving during the brief stop() window forwards
      // gracefully instead of hitting the worker-lost retry / respawn path.
      runtime.markRetired(() => this.runtimes.get(key))
    }
    await runtime.stop().catch(() => {})
    if (runtime instanceof DockerRuntime) {
      await runtime.remove()
    } else if (runtime instanceof RlaunchRuntime) {
      await runtime.remove()
    }
    this.runtimes.delete(key)
    return result
  }

  /** Atomic /mount restart: build a new RlaunchRuntime with the current
   *  on-disk config (mount-aware deploymentHash, fresh extraMounts list),
   *  install it as the pool entry for this user, and mark the previous one
   *  retired so any AsyncLocalStorage reference held by a concurrent mid-
   *  turn session forwards to the new instance instead of trying to respawn
   *  a fresh worker with the OLD config.
   *
   *  Returns the new runtime; the caller is expected to `setRuntime(next)`
   *  in its own SessionContext and `await next.start()`. The OLD cluster
   *  worker is stopped inside that start() via the existing
   *  `_startOnce` deploymentHash-mismatch branch — we deliberately do not
   *  stop it here so the forwarder always has a live successor by the time
   *  any stale exec arrives. */
  swapRlaunchRuntime(
    userId: string,
    config: LightClawConfig,
    workspaceHostPath?: string,
  ): RlaunchRuntime {
    if (config.runtime.backend !== 'cluster') {
      throw new Error(
        'RuntimePool.swapRlaunchRuntime requires runtime.backend = "cluster"',
      )
    }
    const key = runtimeKey(userId, workspaceHostPath)
    const old = this.runtimes.get(key)
    const next = this.create(userId, config, workspaceHostPath, undefined)
    if (!(next instanceof RlaunchRuntime)) {
      throw new Error('RuntimePool.swapRlaunchRuntime expected RlaunchRuntime')
    }
    this.runtimes.set(key, next)
    if (old instanceof RlaunchRuntime && old !== next) {
      // Resolver reads `this.runtimes.get(key)` lazily on every successor
      // lookup, so subsequent swaps continue to forward correctly.
      old.markRetired(() => this.runtimes.get(key))
    }
    return next
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

    if (config.runtime.backend === 'cluster') {
      const record = readWorkerState()[userId]
      if (record) {
        summary.rlaunchWorker ??= record.name
        // Best-effort. If stop fails the record stays gone (admin removed
        // the user; no point keeping the link), but the cluster sweep
        // matches `comment` against listActiveCanonicalUsers and catches
        // workers for inactive users on the next pass.
        await stopRlaunchProcess(record.namespace, record.name, '[rlaunch] purgeUser stop')
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
    if (config.runtime.backend === 'cluster') {
      await this.sweepRlaunchOrphans(config)
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

  private async sweepRlaunchOrphans(config: LightClawConfig): Promise<void> {
    const state = readWorkerState()
    const activeUsers = new Set(await listActiveCanonicalUsers())
    // Tracks workers that stay legitimately bound to an active user under the
    // current deploymentHash. Drives the cluster-side filter: anything in our
    // namespace with a `lightclaw-runtime-*` comment whose name is NOT in
    // here (and hash matches) is a leaked orphan.
    const trackedNamesByUser = new Map<string, string>()
    // Namespaces to scan — start from the configured one, then union in any
    // namespace seen in state in case admin pivoted rlaunch.namespace and
    // left workers behind.
    const namespacesToScan = new Set<string>([config.runtime.clusterSettings.namespace])

    for (const [canonical, record] of Object.entries(state)) {
      namespacesToScan.add(record.namespace)
      const hashMismatch = record.deploymentHash !== this.deploymentHash
      const userGone = !activeUsers.has(canonical)
      if (!hashMismatch && !userGone) {
        trackedNamesByUser.set(canonical, record.name)
        continue
      }
      const stopped = await stopRlaunchProcess(
        record.namespace,
        record.name,
        '[rlaunch-sweep] state-based stop',
      )
      if (!stopped) {
        // Keep the record so the next sweep retries; the cluster scan below
        // will also catch it via `comment`. Treating it as still tracked for
        // this pass prevents the cluster scan from racing the same stop call.
        trackedNamesByUser.set(canonical, record.name)
        continue
      }
      await deleteWorkerRecord(canonical)
    }

    for (const namespace of namespacesToScan) {
      await this.sweepClusterRlaunchOrphans(namespace, activeUsers, trackedNamesByUser)
    }
  }

  private async sweepClusterRlaunchOrphans(
    namespace: string,
    activeUsers: ReadonlySet<string>,
    trackedNamesByUser: ReadonlyMap<string, string>,
  ): Promise<void> {
    const result = await runProcess('brainctl', [
      '-n', namespace,
      'get', 'process',
      '-o', 'json',
    ], {
      env: withoutProxyEnv(),
      timeoutMs: 30_000,
      maxBufferBytes: 16 * 1024 * 1024,
      limitMessage: 'brainctl get process terminated',
    }).catch(error => {
      process.stderr.write(
        `[rlaunch-sweep] brainctl get -n ${namespace} failed: ${String(error)}\n`,
      )
      return null
    })
    if (!result) return
    if (result.exitCode !== 0) {
      process.stderr.write(
        `[rlaunch-sweep] brainctl get -n ${namespace} exit ${result.exitCode}: ` +
        `${result.stderr.trim() || result.stdout.trim()}\n`,
      )
      return
    }

    let processes: ClusterRlaunchProcess[]
    try {
      processes = parseBrainctlProcessList(result.stdout)
    } catch (error) {
      process.stderr.write(
        `[rlaunch-sweep] failed to parse brainctl json from -n ${namespace}: ${String(error)}\n`,
      )
      return
    }

    const orphans = selectRlaunchOrphans({
      processes,
      deploymentHash: this.deploymentHash,
      activeUsers,
      trackedNamesByUser,
    })
    for (const orphan of orphans) {
      process.stderr.write(
        `[rlaunch-sweep] stopping orphan worker ${orphan.name} ` +
        `(canonical=${orphan.canonical}, hash=${orphan.hash}, ` +
        `phase=${orphan.phase}, reason=${orphan.reason})\n`,
      )
      await stopRlaunchProcess(namespace, orphan.name, '[rlaunch-sweep] cluster stop')
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
    if (config.runtime.backend === 'cluster') {
      if (config.runtime.driver !== 'brainpp') {
        throw new Error('runtime.driver = "brainpp" is required for cluster runtime backend')
      }
      return createRuntime({
        kind: 'cluster',
        driver: config.runtime.driver,
        config: buildRlaunchRuntimeConfig(userId, workspaceHostPath, config, this.deploymentHash),
        tracker: new WorkerReadinessTracker(userId),
      })
    }
    const exhaustive: never = config.runtime.backend
    throw new Error(`Unsupported runtime backend: ${String(exhaustive)}`)
  }
}

function runtimeKey(userId: string, workspaceHostPath?: string): string {
  return userId === '__terminal__' && workspaceHostPath
    ? `${userId}:${path.resolve(workspaceHostPath)}`
    : userId
}

export function resolveDockerImage(config: LightClawConfig): string {
  return config.runtime.dockerSettings.imageOverride ??
    config.runtime.dockerSettings.image ??
    defaultImageRef()
}

export function buildDockerRuntimeConfig(
  userId: string,
  workspaceHostPath: string,
  config: LightClawConfig,
  deploymentHash = computeDeploymentHash(),
): DockerRuntimeConfig {
  const docker = config.runtime.dockerSettings
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
    workspaceContainerPath: '/workspace',
    mounts: docker.mounts,
    tmpfs: docker.tmpfs,
    env,
    memoryLimit: docker.memoryLimit,
    cpuLimit: docker.cpuLimit,
    network: dockerNetwork,
    autoPull: docker.autoPull,
    security: docker.security,
  }
}

export function buildRlaunchRuntimeConfig(
  userId: string,
  workspaceHostPath: string,
  config: LightClawConfig,
  deploymentHash = computeDeploymentHash(),
): RlaunchRuntimeConfig {
  const rlaunch = config.runtime.clusterSettings
  const network = config.runtime.network
  const gpfs = workspaceToGpfsMount(userId, rlaunch)
  const extraMounts = resolveUserRlaunchRuntimeMounts(userId, rlaunch)
  const mountHash = rlaunchMountFingerprint(extraMounts)
  const rlaunchDeploymentHash = createHash('sha256')
    .update(deploymentHash)
    .update('\0')
    .update(workspaceHostPath)
    .update('\0')
    .update(mountHash)
    .digest('hex')
    .slice(0, 8)
  // rlaunch worker is on a different cluster node, so it cannot reach the
  // bridge over loopback — point at the host's first non-internal IPv4.
  const env = network.mode === 'host'
    ? { ...buildBridgeEnv(detectHostIp(), network.port, network.noProxy), ...rlaunch.env }
    : rlaunch.env
  return {
    canonicalUser: userId,
    deploymentHash: rlaunchDeploymentHash,
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
    workspaceContainerPath: '/workspace',
    extraMounts,
    env,
    daemonUid: process.getuid?.() ?? 0,
    daemonGid: process.getgid?.() ?? 0,
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

const RLAUNCH_COMMENT_PREFIX = 'lightclaw-runtime-'
const RLAUNCH_COMMENT_RE = /^lightclaw-runtime-(.+)-([a-f0-9]{4,})$/
const RLAUNCH_LIVE_PHASES = new Set(['running', 'starting', 'pending', 'containercreating'])

export type ClusterRlaunchProcess = {
  name: string
  comment: string
  phase: string
}

export type RlaunchOrphanSelection = {
  name: string
  canonical: string
  hash: string
  phase: string
  reason: 'foreign-hash' | 'inactive-user' | 'untracked-name'
}

/**
 * Parse `brainctl get process -o json` output into the minimum surface we
 * need to make orphan decisions: name + comment annotation + phase. Foreign
 * processes (no `lightclaw-runtime-` comment) are dropped at parse time.
 */
export function parseBrainctlProcessList(json: string): ClusterRlaunchProcess[] {
  const parsed = JSON.parse(json) as { items?: unknown }
  if (!Array.isArray(parsed.items)) return []
  const out: ClusterRlaunchProcess[] = []
  for (const item of parsed.items) {
    if (!item || typeof item !== 'object') continue
    const meta = (item as { metadata?: unknown }).metadata as
      | { name?: unknown; annotations?: Record<string, unknown> }
      | undefined
    const status = (item as { status?: unknown }).status as { phase?: unknown } | undefined
    const name = typeof meta?.name === 'string' ? meta.name : null
    const comment = meta?.annotations?.['workspace.brainpp.cn/comment']
    if (!name || typeof comment !== 'string') continue
    if (!comment.startsWith(RLAUNCH_COMMENT_PREFIX)) continue
    const phase = typeof status?.phase === 'string' ? status.phase : ''
    out.push({ name, comment, phase })
  }
  return out
}

/**
 * Decide which cluster-side processes are orphans and should be stopped.
 * Pure: no I/O. Inputs come from `parseBrainctlProcessList` + state file +
 * identity store.
 *
 * Stop reasons (order of evaluation):
 *   - foreign-hash: comment hash != current deploymentHash. Not safe to
 *     stop in general (could be a sibling lightclaw build sharing the
 *     cluster), so we currently SKIP these. Kept in the type for future
 *     use behind an admin opt-in.
 *   - inactive-user: comment canonical is not in the current activeUsers
 *     set — admin removed the user but the worker leaked.
 *   - untracked-name: hash matches and user is active, but state holds a
 *     different name (or no name) for this canonical. The classic
 *     spawn-then-crash orphan; this is the case the screenshot bug hit.
 *
 * Phase filter: only Live phases are returned. Stopped/Failed workers
 * cost no GPU and brainctl stop on them is a no-op anyway.
 */
export function selectRlaunchOrphans(input: {
  processes: readonly ClusterRlaunchProcess[]
  deploymentHash: string
  activeUsers: ReadonlySet<string>
  trackedNamesByUser: ReadonlyMap<string, string>
}): RlaunchOrphanSelection[] {
  const out: RlaunchOrphanSelection[] = []
  for (const proc of input.processes) {
    const match = RLAUNCH_COMMENT_RE.exec(proc.comment)
    if (!match) continue
    const [, canonical, hash] = match
    if (!RLAUNCH_LIVE_PHASES.has(proc.phase.toLowerCase())) continue
    if (hash !== input.deploymentHash) {
      // Skip: could belong to a sibling deployment sharing the cluster.
      continue
    }
    if (!input.activeUsers.has(canonical)) {
      out.push({
        name: proc.name,
        canonical,
        hash,
        phase: proc.phase,
        reason: 'inactive-user',
      })
      continue
    }
    const trackedName = input.trackedNamesByUser.get(canonical)
    if (trackedName === proc.name) continue
    out.push({
      name: proc.name,
      canonical,
      hash,
      phase: proc.phase,
      reason: 'untracked-name',
    })
  }
  return out
}

/**
 * Centralized brainctl stop helper. Logs failure to stderr and returns true
 * iff the worker is now in a terminal state (stopped or never existed).
 * Treats `current phase is Stopped` and `not found` as success — matches
 * RlaunchRuntime.stopWorker's classifier.
 */
async function stopRlaunchProcess(
  namespace: string,
  name: string,
  context: string,
): Promise<boolean> {
  const result = await runProcess('brainctl', [
    '-n', namespace,
    'stop', `process/${name}`,
  ], {
    env: withoutProxyEnv(),
    timeoutMs: 30_000,
    maxBufferBytes: 1024 * 1024,
    limitMessage: 'brainctl stop process terminated',
  }).catch(error => {
    process.stderr.write(`${context} ${name}: ${String(error)}\n`)
    return null
  })
  if (!result) return false
  if (result.exitCode === 0) return true
  const text = `${result.stderr}\n${result.stdout}`
  if (/current phase is Stopped|not found/i.test(text)) {
    return true
  }
  process.stderr.write(
    `${context} ${name} exit ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}\n`,
  )
  return false
}
