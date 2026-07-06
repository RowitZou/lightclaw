import { randomUUID } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import { createReadStream } from 'node:fs'
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
import { LayeredDataPlane, STAGING_COPY_TIMEOUT_MS } from './data-plane/layered.js'
import { withByteBudget } from './byte-budget.js'
import { SharedClusterFsData } from './data-plane/shared-cluster-fs.js'
import { agentExecEnv } from './exec-home.js'
import { sandboxBackstopTimeoutMs, wrapSandboxCommandWithTimeout } from './exec-wrap.js'
import { assertMountsAccessible, MountTablePathPolicy } from './path-policy/mount-table.js'
import { runProcess, shellQuote, withoutProxyEnv } from './process.js'
import { formatRlaunchError, translateRlaunchError } from './rlaunch-errors.js'
import {
  filesetKeyFromGpfsMount,
  observePuyuclawMode,
  type MountReport,
} from './mount-authz.js'
import {
  deleteWorkerRecord,
  lookupWorkerRecord,
  writeWorkerRecord,
} from './rlaunch-state.js'
import { WorkerReadinessTracker, type WorkerReadinessSnapshot } from './worker-readiness.js'

export type RlaunchRuntimeConfig = {
  canonicalUser: string
  deploymentHash: string
  image: string
  chargedGroup: string
  namespace: string
  cpu: number
  memoryMb: number
  gpu: number
  privateMachine: 'group' | 'yes' | 'no' | 'project' | 'tenant'
  positiveTags: readonly string[]
  workerGcTimeHours: number
  imagePullPolicy: 'IfNotPresent' | 'Always' | 'Never'
  maxWaitDuration: string
  predictBeforeStart: boolean
  workspaceHostPath: string
  workspaceGpfsMount: string
  workspaceContainerPath: string
  extraMounts?: readonly {
    hostPath: string
    workerPath: string
    gpfsMount: string
    mode: 'rw' | 'ro'
    requestedMode?: 'rw' | 'ro'
    fileset?: string
    daemonVisible?: boolean
  }[]
  /** Env injected at worker creation via `rlaunch -e KEY=VALUE`. */
  env: Readonly<Record<string, string>>
  /**
   * The uid/gid to drop privileges to when dispatching unprivileged exec
   * calls. The kubebrain ml-base image starts as root; we keep root for the
   * worker PID 1 and for bootstrap steps (apt), but every tool-side
   * exec is wrapped in `setpriv --reuid=<daemonUid> --regid=<daemonGid>` so
   * files it creates in the gpfs-backed workspace are owned by the daemon
   * (host uid). Defaults to `process.getuid()` / `process.getgid()` at
   * `buildRlaunchRuntimeConfig` time; tests / multi-host deployments can
   * override.
   */
  daemonUid: number
  daemonGid: number
  maxExecRelayBytes?: number
}

type ProcessState =
  | 'absent'
  | 'running'
  | 'starting'
  | 'pending'
  | 'stopped'
  | 'failed'
  | 'unknown'

const DEFAULT_TIMEOUT_MS = 30_000
const START_TIMEOUT_MS = 180_000
const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024
// brainctl's exec stdout no longer carries tool output: every non-privileged
// (agent-dispatched) exec redirects the command's stdout/stderr to files on
// the gpfs-backed workspace and brainctl stdout carries only the
// `LIGHTCLAW_EXIT:<n>` marker. This cap bounds that marker channel — a few
// hundred KB is far more than the marker needs but leaves room for stray
// setpriv / bash diagnostics without `runProcess` killing the call.
const BRAINCTL_MARKER_BUFFER_BYTES = 256 * 1024
// Workspace-relative (container-path) scratch dir for exec output-capture
// files and exec-relay file staging. Sits under the workspace mount so the
// daemon can read it host-side via shared-cluster-fs; swept by inbox-aging at
// a short (6h) TTL as a backstop for daemon-crash stragglers.
const EXEC_SCRATCH_SUBDIR = '.lightclaw/exec'
// Worker-node-local scratch dir for IO-heavy throwaway work (git clone /
// build / archive extraction). NOT a gpfs mount — it lives on the worker
// pod's own filesystem, so small-file ops run at local-disk speed instead of
// paying the ~50x GPFS metadata penalty of the workspace mount. Ephemeral:
// wiped on worker restart, re-provisioned by `ensureScratchDir`. Distinct
// from `EXEC_SCRATCH_SUBDIR` above, which is harness-internal exec plumbing
// on the gpfs mount. See `Runtime.scratchRoot`.
const WORKER_SCRATCH_DIR = '/scratch'

// Cluster runtime implementation for runtime.driver = "brainpp".
//
// Keep the split explicit:
// - Brain++ driver seam: rlaunch/brainctl argv construction, worker-name
//   parsing, and Brain++ control-plane error classification.
// - Reusable remote-worker skeleton: lifecycle, pooling, retry shell,
//   mount/data-plane layering, scratch provisioning, and host-mount fast paths.
//
// Do not extract a generic ClusterDriver yet. This file is the seam marker for
// the second cluster implementation to prove the right interface shape.
export class RlaunchRuntime implements Runtime {
  readonly kind = 'cluster' as const
  readonly isolated = true
  readonly securityProfile = 'cluster-isolated' as const
  readonly workspaceRoot: string
  readonly scratchRoot: string
  readonly canonicalUser: string
  readonly control: ControlPlane
  /** Internal storage for `data` / `fs`. Public access goes through getters
   *  that forward to a `markRetired()`-installed successor when this instance
   *  has been swapped out of the pool but is still referenced by some
   *  AsyncLocalStorage-cached SessionContext. */
  private _data!: DataPlane
  private _fs!: RuntimeFs
  /** Internal storage for `paths`. Same forwarding rationale as `_data`. */
  private _paths!: PathPolicy

  lastActivityMs = Date.now()

  private readonly cfg: RlaunchRuntimeConfig
  private readonly tracker: WorkerReadinessTracker
  private readonly mountTable: Array<[string, string]>
  private workerName: string | null = null
  private lastKnownState: ProcessState = 'unknown'
  private inflightStart: Promise<void> | null = null
  /** Set to true via `markRetired()` when this runtime has been swapped out
   *  of `RuntimePool` (typically by /system mount applying a new mount config). The
   *  resolver, when set, returns the user's current pool entry — almost
   *  always the successor `RlaunchRuntime`. All public methods that touch
   *  cluster state check this flag and forward to the successor when present
   *  so that stale ALS references from concurrent mid-turn sessions follow
   *  the new runtime instead of trying to respawn against a dead worker.
   *  See `# LightClaw Runtime Safety Notes` (worker retire / forwarder). */
  private retired = false
  private successorResolver: (() => Runtime | undefined) | null = null
  /** Memoizes successful helper staging per worker. Reset implicitly when
   *  workerName changes (worker restart / GC) so the next ensureRunning()
   *  re-stages into the fresh container. */
  private helpersStagedFor: string | null = null
  private inflightStaging: Promise<void> | null = null
  /** Memoizes successful scratch-dir provisioning per worker. Same lifecycle
   *  as `helpersStagedFor` — resets when the workerName changes, so a
   *  respawned worker (whose node-local /scratch was wiped) re-provisions. */
  private scratchDirReadyFor: string | null = null
  private inflightScratchDir: Promise<void> | null = null
  /** Arms the fire-and-forget background provisioning drive per worker so the
   *  preheat / respawn / health-restart paths (which call `start()`, never the
   *  on-demand `ensureRunning()`) still stage helpers without blocking
   *  `start()`'s fast-return contract. Re-armed when the workerName changes
   *  (respawn); un-armed if the drive errors so a later `start()` can retry. */
  private provisionDriveFor: string | null = null
  private mountAuthReadyFor: string | null = null
  private inflightMountAuth: Promise<void> | null = null
  /** Mounts from the last applyMountAuthorizations pass that the cluster did not
   *  provide for the service identity at all. Read once by a mount-change
   *  rebuild via consumeMountReport(). */
  private lastMountReport: MountReport = { unmountable: [] }
  /** Sticky negative cache for the host-mount fast-write path. Set to true
   *  on the first failed attempt (typically EACCES / ENOENT on the host-side
   *  mount prefix, indicating the daemon doesn't have a local view of gpfs)
   *  so subsequent calls don't pay another doomed round-trip before falling
   *  back to the brainctl chunked path. The gpfs/virtiofs mount is set up at
   *  boot and doesn't appear/disappear at runtime, so a process-lifetime
   *  cache is safe; a daemon restart re-probes. */
  private hostMountFastWriteDisabled = false
  /** Sticky negative cache for the host-mount fast-read path. Independent
   *  from the write flag because the failure modes diverge (worker-only
   *  permissions, race with concurrent writes, etc.); flipping read off
   *  shouldn't penalize materialize writes that are still working. */
  private hostMountFastReadDisabled = false

  constructor(config: RlaunchRuntimeConfig, tracker: WorkerReadinessTracker) {
    this.cfg = config
    this.tracker = tracker
    this.canonicalUser = config.canonicalUser
    this.workspaceRoot = config.workspaceContainerPath
    this.scratchRoot = WORKER_SCRATCH_DIR
    const mounts = [
      {
        host: config.workspaceHostPath,
        worker: config.workspaceContainerPath,
        mode: 'rw' as const,
      },
      ...(config.extraMounts ?? []).map(mount => ({
        host: mount.hostPath,
        worker: mount.workerPath,
        mode: mount.mode,
        ...(mount.daemonVisible === false ? { daemonVisible: false } : {}),
      })),
    ]
    this.mountTable = mounts.map(mount => [
      path.resolve(mount.host),
      path.posix.normalize(mount.worker),
    ] as [string, string])
    this.control = {
      kind: 'brainctl-exec',
      stdoutByteReliability: 'unreliable-large',
      exec: input => this.exec(input),
      start: () => this.start(),
      stop: () => this.stop(),
      isRunning: () => this.isRunning(),
      isAvailable: () => this.isAvailable(),
    }
    this._paths = new MountTablePathPolicy(mounts)
    const sharedClusterFsData = new SharedClusterFsData(this._paths, () => this.workerName)
    const guardedSharedClusterFsData: DataPlane = {
      kind: sharedClusterFsData.kind,
      independentFromControl: sharedClusterFsData.independentFromControl,
      reliability: sharedClusterFsData.reliability,
      readFile: async pathname => {
        await this.ensureRunning()
        return sharedClusterFsData.readFile(pathname)
      },
      createReadStream: async pathname => {
        await this.ensureRunning()
        return sharedClusterFsData.createReadStream(pathname)
      },
      writeFile: async (pathname, content) => {
        await this.ensureRunning()
        return sharedClusterFsData.writeFile(pathname, content)
      },
      chmod: async (pathname, mode) => {
        await this.ensureRunning()
        return sharedClusterFsData.chmod(pathname, mode)
      },
      stat: async pathname => {
        await this.ensureRunning()
        return sharedClusterFsData.stat(pathname)
      },
      readdir: async pathname => {
        await this.ensureRunning()
        return sharedClusterFsData.readdir(pathname)
      },
    }
    const layeredData: DataPlane = new LayeredDataPlane(
      [
        guardedSharedClusterFsData,
        this.execRelayFs,
      ],
      this._paths,
      { maxExecRelayBytes: config.maxExecRelayBytes ?? 1024 * 1024 * 1024 },
    )
    layeredData.writeFileViaHostMount = this.execRelayFs.writeFileViaHostMount
    layeredData.readFileViaHostMount = this.execRelayFs.readFileViaHostMount
    this._data = withByteBudget(layeredData)
    this._fs = this._data
  }

  /** Returns the successor runtime if this instance has been marked retired
   *  AND the pool's current entry resolves to a different instance. Returns
   *  null when not retired or when the pool has no successor yet (e.g. mid-
   *  swap, or after `purgeUser` cleared the slot entirely). */
  private liveSuccessor(): Runtime | null {
    if (!this.retired) return null
    const successor = this.successorResolver?.()
    return successor && successor !== this ? successor : null
  }

  /** Public accessor for the data plane. Forwards to the successor's data
   *  plane when retired so stale ALS references see the new MountTablePathPolicy
   *  + new SharedClusterFsData (which captures the new worker name getter). */
  get data(): DataPlane {
    return this.liveSuccessor()?.data ?? this._data
  }

  /** Same forwarding shape as `data`. `fs === data` for Rlaunch by construction,
   *  preserved here for both the successor case (successor.fs) and the local
   *  fallback. */
  get fs(): RuntimeFs {
    return this.liveSuccessor()?.fs ?? this._fs
  }

  /** Forward path policy too — RO/RW mode bits on extra mounts diverge between
   *  generations after a /system mount add/rm changes the mount set, and `runtime.paths`
   *  is the authoritative source the PathPolicy gate consults for write
   *  rejection. Stale callers using OLD.paths would otherwise enforce stale
   *  semantics. */
  get paths(): PathPolicy {
    return this.liveSuccessor()?.paths ?? this._paths
  }

  /** Mark this runtime as retired, supplying a resolver that the pool calls
   *  to find the current live runtime for the same canonical user. Public
   *  methods (`exec`, `ensureRunning`, `start`, `isAvailable`, `isRunning`,
   *  the `data` / `fs` / `paths` getters) forward to that successor when set.
   *
   *  Called by `RuntimePool.swapRlaunchRuntime()` (the /system mount restart path)
   *  and by `RuntimePool.remove()` / `purgeUser()` for graceful degradation
   *  of stale ALS references during admin tear-down. Idempotent: re-marking
   *  is a no-op except for refreshing the resolver. */
  markRetired(resolver: () => Runtime | undefined): void {
    this.retired = true
    this.successorResolver = resolver
  }

  get name(): string | null {
    return this.workerName
  }

  /** The worker name is the generation token: it is freshly allocated on every
   *  spawn (respawn after worker-lost, health-checker restart, or /system mount swap),
   *  so a change signals that the worker pod — and its container-local /tmp,
   *  /scratch, and any in-worker background process — was replaced. Forwards to
   *  the successor when retired so a stale ALS reference reads the live worker
   *  name, matching the `name` / `data` / `paths` getters. */
  currentGeneration(): string | null {
    const successor = this.liveSuccessor()
    if (successor) return successor.currentGeneration?.() ?? null
    return this.workerName
  }

  /** Snapshot of the per-user worker readiness tracker. Exposed so the
   *  /admin sandbox status admin command can render rlaunch-flavored health
   *  (worker state / cluster image / schedule duration / last error)
   *  instead of the docker-flavored ImageReadinessTracker that doesn't
   *  apply to this backend. */
  workerSnapshot(): WorkerReadinessSnapshot {
    return this.tracker.snapshot()
  }

  async start(triggerReason?: string): Promise<void> {
    const successor = this.liveSuccessor()
    if (successor) return successor.start()
    // Dedup concurrent callers (preheat-on-startup, preheat-on-approval,
    // ensureRunning, health checker restart) so they don't each spawn a
    // duplicate cluster worker and orphan the older ones.
    if (this.inflightStart) {
      return this.inflightStart
    }
    this.inflightStart = this._startOnce(triggerReason).finally(() => {
      this.inflightStart = null
    })
    return this.inflightStart
  }

  private async _startOnce(triggerReason?: string): Promise<void> {
    // Fail fast on misconfigured host mounts before any cluster action.
    // SharedClusterFsData / LayeredDataPlane assume daemon can reach
    // mount.host (the gpfs host-side prefix); without this probe a
    // permission / ENOENT misconfig would only surface as a sticky-disabled
    // stderr line on the first tool call, silently routing all reads back
    // through brainctl exec — exactly the Bug 1 regression path.
    await assertMountsAccessible(this.paths, 'rlaunch')

    const record = lookupWorkerRecord(this.cfg.canonicalUser)
    // Reason carried through to the spawn log so admin can grep cause when
    // workers churn (Bug 3 in the 2026-05-10 audit). triggerReason wins so
    // explicit callers like restartUnhealthy() get attributed correctly even
    // when the worker record was already deleted before _startOnce ran.
    let spawnReason: string
    if (record && record.deploymentHash === this.cfg.deploymentHash) {
      const phase = await this.processPhase(record.name)
      // 'unknown' = transient brainctl-get failure (API blip / unknown column).
      // The worker is most likely still alive — attaching is safer than
      // discarding the record and orphaning a running worker on the cluster.
      if (
        phase === 'running' ||
        phase === 'starting' ||
        phase === 'pending' ||
        phase === 'unknown'
      ) {
        this.workerName = record.name
        if (phase === 'running') {
          this.tracker.markReady()
        } else {
          this.tracker.startSchedule(this.cfg.image)
        }
        process.stderr.write(
          `[rlaunch] reused worker ${record.name} for ${this.cfg.canonicalUser} (phase=${phase})\n`,
        )
        // A reused record on a fresh RlaunchRuntime instance (daemon restart /
        // mount swap) has empty provisioning memos: re-probe in the background
        // so a worker that came back without `rg` (fresh ml-base) self-heals
        // before the user's first tool call instead of on it.
        this.kickBackgroundProvisioning()
        return
      }
      process.stderr.write(
        `[rlaunch] dropping stale worker ${record.name} for ${this.cfg.canonicalUser} ` +
        `(phase=${phase}); will spawn fresh\n`,
      )
      await deleteWorkerRecord(this.cfg.canonicalUser)
      spawnReason = triggerReason ?? `previous worker phase=${phase}`
    } else if (record) {
      // Best-effort: still drop the record + spawn fresh even if the cluster
      // stop fails, so a transient cluster blip doesn't permanently lock a
      // user out of acquiring a runtime. The orphan is recoverable —
      // RuntimePool.sweepOrphans scans the cluster by `comment` annotation
      // (independent of the lost name here) and will reap on the next pass.
      await this.stopWorker(record.name).catch(error => {
        process.stderr.write(
          `[rlaunch] failed to stop stale worker ${record.name} for ` +
          `${this.cfg.canonicalUser} on hash change: ${String(error)}; ` +
          `cluster sweep will reap orphan\n`,
        )
      })
      await deleteWorkerRecord(this.cfg.canonicalUser)
      spawnReason =
        triggerReason ??
        `deploymentHash changed (${record.deploymentHash} -> ${this.cfg.deploymentHash})`
    } else {
      spawnReason = triggerReason ?? 'no existing record'
    }

    this.tracker.startSchedule(this.cfg.image)
    if (this.cfg.predictBeforeStart) {
      await this.runPredict()
    }

    const newName = await this.spawnWorker()
    this.workerName = newName
    await writeWorkerRecord(this.cfg.canonicalUser, {
      name: newName,
      namespace: this.cfg.namespace,
      chargedGroup: this.cfg.chargedGroup,
      image: this.cfg.image,
      deploymentHash: this.cfg.deploymentHash,
      createdAt: Date.now(),
    })
    process.stderr.write(
      `[rlaunch] spawned worker ${newName} for ${this.cfg.canonicalUser} ` +
      `(reason: ${spawnReason}; image=${this.cfg.image})\n`,
    )
    // Stage scratch + helpers in the background so a freshly-spawned
    // ml-base worker (no ripgrep/jq/poppler baked in) is provisioned before
    // the first Grep/Glob, without blocking start()'s fast-return contract.
    this.kickBackgroundProvisioning()
  }

  async isAvailable(): Promise<RuntimeAvailability> {
    const successor = this.liveSuccessor()
    if (successor) return successor.isAvailable()
    if (this.workerName) {
      const phase = await this.processPhase(this.workerName)
      if (phase === 'running') {
        this.tracker.markReady()
        return { ok: true }
      }
      if (phase === 'failed' || phase === 'stopped' || phase === 'absent') {
        this.tracker.markFailed(`worker ${this.workerName} is ${phase}`)
      }
    }

    const snap = this.tracker.snapshot()
    if (snap.state === 'ready') return { ok: true }
    if (snap.state === 'scheduling' || snap.state === 'not-attempted') {
      const elapsed = snap.scheduleDurationMs ? Math.round(snap.scheduleDurationMs / 1000) : 0
      return {
        ok: false,
        reason: 'worker-scheduling',
        retryable: true,
        userMessage:
          `集群正在准备工作环境（已 ${elapsed} 秒，通常几十秒内就绪）。` +
          '如果不急，可以下一轮再发起同一个工具调用；或者继续聊别的话题，等环境就绪后再回来。',
        adminMessage:
          `RlaunchRuntime worker scheduling for ${this.cfg.canonicalUser} ` +
          `(image=${snap.image ?? this.cfg.image}, elapsed=${elapsed}s)`,
      }
    }
    if (snap.state === 'quota-denied') {
      return {
        ok: false,
        reason: 'worker-quota-denied',
        retryable: false,
        userMessage: '集群资源暂时不足，当前不能使用工具。已记录给管理员排查。',
        adminMessage: snap.lastError ??
          `RlaunchRuntime quota denied for ${this.cfg.canonicalUser}`,
      }
    }
    return {
      ok: false,
      reason: 'worker-failed',
      retryable: false,
      userMessage: '集群工作环境未就绪。已记录给管理员排查，目前我只能处理聊天类话题。',
      adminMessage: snap.lastError ?? `RlaunchRuntime worker failed for ${this.cfg.canonicalUser}`,
    }
  }

  async stop(): Promise<void> {
    // Intentionally NO liveSuccessor() forward here: stop() runs the
    // *cluster-side* teardown for this instance's worker; forwarding would
    // ask the successor to stop ITS worker, which is the wrong target.
    // After markRetired(), the successor takes over cluster lifecycle via
    // its own _startOnce() deploymentHash-mismatch branch — if this OLD
    // worker was already stopped by that path, the lookupWorkerRecord
    // check below will find no record matching this OLD cfg.deploymentHash
    // and return early without re-stopping.
    if (!this.workerName) {
      const record = lookupWorkerRecord(this.cfg.canonicalUser)
      this.workerName = record?.deploymentHash === this.cfg.deploymentHash ? record.name : null
    }
    if (!this.workerName) {
      return
    }
    await this.stopWorker(this.workerName)
    this.lastKnownState = 'stopped'
  }

  async remove(): Promise<void> {
    // Same rationale as stop(): no successor forward; this is the
    // teardown path for THIS instance's worker record.
    await this.stop().catch(() => {})
    await deleteWorkerRecord(this.cfg.canonicalUser)
    this.workerName = null
  }

  isRunning(): boolean {
    const successor = this.liveSuccessor()
    if (successor) return successor.isRunning()
    return this.lastKnownState === 'running'
  }

  async exec(input: ExecInput): Promise<ExecResult> {
    const successor = this.liveSuccessor()
    if (successor) return successor.exec(input)
    this.lastActivityMs = Date.now()
    await this.ensureRunning()
    // Wrap the command so the worker pod kills the command's whole process
    // tree on timeout: killing the local `brainctl exec` client does NOT
    // reach the in-worker process (Bug 4). This is the agent tool-exec path;
    // privileged bootstrap execs (helper staging) call runBrainctlExec
    // directly and stay unwrapped.
    const wrapped = this.wrapForSandboxTimeout(input)
    const result = await this.runBrainctlExec(wrapped)
    if (!this.isWorkerLostError(result)) {
      return result
    }

    // The 5-substring isWorkerLostError detector matches several brainctl
    // control-plane / kubelet websocket transients (`unable to upgrade
    // connection`, `connection refused`, …) as well as legitimate worker
    // death. 2026-05-12 dogfood confirmed a false positive: the original
    // worker was still alive on the cluster, but a transient brainctl
    // error tripped the detector and respawned a fresh worker, leaking
    // the old one. Mitigation: log the original stderr (otherwise lost —
    // `runBrainctlExec` does not write anything to daemon stderr on
    // failure) and retry once after a 1s pause. Real worker death survives
    // the retry; transient blips usually clear within a second.
    process.stderr.write(
      `[rlaunch] worker-lost-like error from ${this.workerName ?? '<unknown>'} ` +
      `(retry in 1s before respawn): exitCode=${result.exitCode} ` +
      `stderr=${truncateForLog(result.stderr)} stdout=${truncateForLog(result.stdout)}\n`,
    )
    await delay(workerLostRetryDelayMs)
    if (input.abortSignal?.aborted) {
      // Caller aborted while we were waiting; do not respawn behind their
      // back. Return the original failed result so the upstream handler
      // sees the normal cancellation flow.
      return result
    }
    const firstRetry = await this.runBrainctlExec(wrapped)
    if (!this.isWorkerLostError(firstRetry)) {
      process.stderr.write(
        `[rlaunch] worker-lost retry recovered on ${this.workerName ?? '<unknown>'}; ` +
        'first error was a transient control-plane blip, original worker preserved\n',
      )
      return firstRetry
    }

    process.stderr.write(
      `[rlaunch] worker-lost retry still failed on ${this.workerName ?? '<unknown>'}; ` +
      `respawning. retry exitCode=${firstRetry.exitCode} ` +
      `stderr=${truncateForLog(firstRetry.stderr)}\n`,
    )
    await deleteWorkerRecord(this.cfg.canonicalUser)
    this.workerName = null
    await this.start('worker-lost on exec after 1s retry, retrying')
    // bringToReady (not bare waitUntilRunning): the respawned worker is a fresh
    // ml-base pod with no scratch / ripgrep, so provision it before
    // running the retry command — otherwise the very next Grep/Glob lands on an
    // unstaged worker and returns `rg: command not found`. Coalesces with the
    // background drive start() kicked off, via the per-worker ensure* memos.
    await this.bringToReady()
    // The respawned command's stderr is returned verbatim — no "worker
    // restarted" prefix. Restart signalling is unified in the model-facing
    // <system-reminder> driven by `currentGeneration()` change detection
    // (`restart-notice.ts` + query.ts), which covers every restart path
    // (worker-lost respawn, health-checker, /system mount swap) consistently instead
    // of polluting one unlucky command's stderr on only this path.
    return this.runBrainctlExec(wrapped)
  }

  /**
   * Wrap an agent exec so the worker pod self-enforces the timeout and kills
   * the command's whole process tree — see `wrapSandboxCommandWithTimeout`.
   * The daemon-side `runProcess` timeout is bumped to a backstop so the
   * in-worker watchdog always resolves the command first.
   */
  private wrapForSandboxTimeout(input: ExecInput): ExecInput {
    const budgetMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
    return {
      ...input,
      command: wrapSandboxCommandWithTimeout(input.command, budgetMs),
      timeoutMs: sandboxBackstopTimeoutMs(budgetMs),
    }
  }

  private readonly execRelayFs: RuntimeFs = {
    kind: 'exec-relay',
    independentFromControl: false,
    reliability: 'depends-on-control-plane',
    readFile: async pathname => {
      // Stage the (possibly container-local) file onto the gpfs-backed
      // scratch dir with `cp`, then read it host-side. The bytes never
      // traverse brainctl's exec stdout — the channel carries only cp's
      // exit code.
      const containerPath = this.toContainerPath(pathname)
      const id = this.execScratchId()
      const stageContainer = path.posix.join(this.execScratchDirContainer(), `${id}.read`)
      const stageHost = this.toHostPath(stageContainer)
      if (!stageHost) {
        throw new Error(`readFile ${pathname}: cannot resolve a host-visible scratch path`)
      }
      const result = await this.exec({
        command: `cp -- ${shellQuote(containerPath)} ${shellQuote(stageContainer)}`,
        // Byte transfer up to maxExecRelayBytes over virtiofs+GPFS — the 30s
        // control-plane default SIGTERMs a legitimate multi-hundred-MB copy.
        timeoutMs: STAGING_COPY_TIMEOUT_MS,
      })
      if (result.exitCode !== 0) {
        throw new Error(`readFile ${pathname}: ${result.stderr.trim() || result.stdout.trim()}`)
      }
      try {
        return await fsp.readFile(stageHost)
      } finally {
        await fsp.rm(stageHost, { force: true }).catch(() => {})
      }
    },
    createReadStream: async pathname => {
      // Streaming sibling of readFile: stage the (possibly container-local /
      // worker-only-mount) file onto the gpfs-backed scratch dir with `cp`,
      // then stream it host-side. Bytes never traverse brainctl; the scratch
      // copy is removed once the stream closes (end / error / destroy all emit
      // 'close'). Lets callers cap output without buffering the whole file.
      const containerPath = this.toContainerPath(pathname)
      const id = this.execScratchId()
      const stageContainer = path.posix.join(this.execScratchDirContainer(), `${id}.read`)
      const stageHost = this.toHostPath(stageContainer)
      if (!stageHost) {
        throw new Error(`createReadStream ${pathname}: cannot resolve a host-visible scratch path`)
      }
      const result = await this.exec({
        command: `cp -- ${shellQuote(containerPath)} ${shellQuote(stageContainer)}`,
        timeoutMs: STAGING_COPY_TIMEOUT_MS,
      })
      if (result.exitCode !== 0) {
        throw new Error(`createReadStream ${pathname}: ${result.stderr.trim() || result.stdout.trim()}`)
      }
      const stream = createReadStream(stageHost)
      stream.once('close', () => { void fsp.rm(stageHost, { force: true }).catch(() => {}) })
      return stream
    },
    writeFile: async (pathname, content) => {
      // Write the payload to the gpfs-backed scratch dir host-side (zero-copy,
      // byte-exact), then `cp` it into place inside the worker. No base64, no
      // inline cap, no chunking — the payload never rides the exec channel, so
      // there is no byte-mismatch surface left to verify against.
      const containerPath = this.toContainerPath(pathname)
      const buffer = typeof content === 'string' ? Buffer.from(content) : content
      const id = this.execScratchId()
      const stageContainer = path.posix.join(this.execScratchDirContainer(), `${id}.write`)
      const stageHost = this.toHostPath(stageContainer)
      if (!stageHost) {
        throw new Error(`writeFile ${pathname}: cannot resolve a host-visible scratch path`)
      }
      await fsp.mkdir(path.dirname(stageHost), { recursive: true })
      await fsp.writeFile(stageHost, buffer)
      try {
        const result = await this.exec({
          command:
            `mkdir -p "$(dirname ${shellQuote(containerPath)})" && ` +
            `cp -- ${shellQuote(stageContainer)} ${shellQuote(containerPath)}`,
          timeoutMs: STAGING_COPY_TIMEOUT_MS,
        })
        if (result.exitCode !== 0) {
          throw new Error(`writeFile ${pathname}: ${result.stderr.trim() || result.stdout.trim()}`)
        }
      } finally {
        await fsp.rm(stageHost, { force: true }).catch(() => {})
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
    writeFileViaHostMount: async (pathname, content) => {
      // Opportunistic: if the daemon has a host-side view of the same gpfs/
      // virtiofs share that the worker pod mounts at /workspace, write through
      // the host fs and skip the per-32KB exec round-trips entirely. The
      // worker sees the new file immediately via the bind mount.
      //
      // We never throw on failure — the contract is "return null and let the
      // caller fall back to writeFile()". A flaky host write should not be
      // worse than the slow-but-correct path it's meant to optimize.
      if (this.hostMountFastWriteDisabled) {
        return null
      }
      if (!this.paths.isAllowed(pathname, 'write')) {
        return null
      }
      const hostPath = this.toHostPath(pathname)
      if (!hostPath) {
        return null
      }
      try {
        await fsp.mkdir(path.dirname(hostPath), { recursive: true })
        await fsp.writeFile(hostPath, content)
        return { ok: true }
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error)
        this.hostMountFastWriteDisabled = true
        process.stderr.write(
          `[rlaunch] host-mount fast write disabled for worker ${this.workerName ?? '<unbound>'}; ` +
          `falling back to brainctl chunked path: ${text}\n`,
        )
        return null
      }
    },
    readFileViaHostMount: async (pathname) => {
      // Daemon-only fast read. Symmetric to writeFileViaHostMount; same
      // sticky-disabled posture, same toHostPath gate. Tools must NOT call
      // this — they use readFile() so the runtime owns sandbox semantics
      // (path translation, perm narrowing, future overlay rules). This
      // path is for harness-internal consumers (channel inline encoders,
      // future webfetch staging) where the bytes have to traverse to the
      // daemon Node process anyway and there is no value in routing a
      // bind-mounted read through brainctl exec.
      if (this.hostMountFastReadDisabled) {
        return null
      }
      const hostPath = this.toHostPath(pathname)
      if (!hostPath) {
        return null
      }
      try {
        return await fsp.readFile(hostPath)
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error)
        this.hostMountFastReadDisabled = true
        process.stderr.write(
          `[rlaunch] host-mount fast read disabled for worker ${this.workerName ?? '<unbound>'}; ` +
          `falling back to runtime.fs.readFile: ${text}\n`,
        )
        return null
      }
    },
  }

  async peekProcessPhase(): Promise<ProcessState> {
    if (!this.workerName) {
      const record = lookupWorkerRecord(this.cfg.canonicalUser)
      if (!record || record.deploymentHash !== this.cfg.deploymentHash) {
        return 'absent'
      }
      this.workerName = record.name
    }
    return this.processPhase(this.workerName)
  }

  async restartUnhealthy(): Promise<void> {
    // Stop the old worker before forgetting it. Without this, every health
    // tick that triggers a restart leaves the previous worker alive on the
    // cluster (workerGcTimeHours collects it, but that may be hours away),
    // so a flapping worker accumulates orphans under the same canonicalUser.
    const oldName =
      this.workerName ?? lookupWorkerRecord(this.cfg.canonicalUser)?.name ?? null
    if (oldName) {
      // Same trade-off as `_startOnce`: log loudly and continue so the
      // health restart loop can still bring up a fresh worker. Cluster-side
      // sweep reaps the orphan on the next pass via `comment` annotation.
      await this.stopWorker(oldName).catch(error => {
        process.stderr.write(
          `[rlaunch] restartUnhealthy failed to stop ${oldName} for ` +
          `${this.cfg.canonicalUser}: ${String(error)}; ` +
          `cluster sweep will reap orphan\n`,
        )
      })
    }
    await deleteWorkerRecord(this.cfg.canonicalUser)
    this.workerName = null
    await this.start('health-check restart')
  }

  private async ensureRunning(): Promise<void> {
    // Defense in depth: the `fs` / `data` getters already forward to the
    // successor when retired, so external callers should never reach this
    // instance's ensureRunning post-retire. The guard is here in case a
    // closure inside _data (built at construction time) still holds a
    // bound reference to `this.ensureRunning`.
    const successor = this.liveSuccessor()
    if (successor) {
      // Successor's fs/data plane runs its own ensureRunning internally,
      // so just delegate via a no-op exec that exercises ensureRunning.
      await successor.start()
      return
    }
    if (!this.workerName) {
      await this.start()
    }
    await this.bringToReady()
  }

  /**
   * Drive a brought-up worker to fully provisioned: wait for the cluster to
   * report phase=running, then run the one-time scratch + helper
   * staging bootstrap. Split out of `ensureRunning` so EVERY path that stands
   * a worker up — the on-demand exec / data-plane gate here, the exec
   * worker-lost retry, and the background drive `_startOnce` kicks off for
   * preheat / deploymentHash respawn / health-restart — guarantees a
   * provisioned worker, not just the on-demand path.
   *
   * Why this split exists: `start()` / `_startOnce()` only SCHEDULE the worker
   * (the `wait-ready` contract deliberately returns before phase=running), and
   * staging used to hang solely off `ensureRunning`. A worker stood up by any
   * path that bypassed `ensureRunning` (preheat's `start()`, the worker-lost
   * retry's bare `start()+waitUntilRunning()`, `restartUnhealthy`) served
   * Grep/Glob with no `rg` — the ml-base image ships none — until some later
   * call happened to flow through `ensureRunning`, surfacing as
   * `rg not found in this runtime; Glob cannot operate`.
   *
   * Idempotent + cheap to re-enter: the three ensure* helpers are memoized per
   * workerName and inflight-guarded, so the background drive and any concurrent
   * synchronous drive coalesce onto the same apt / pip work rather than
   * doubling it.
   */
  private async bringToReady(): Promise<void> {
    await this.waitUntilRunning()
    await this.ensureProvisioned()
  }

  /**
   * One-time worker provisioning: scratch dir, then helper staging. The gpfs
   * workspace mount needs no ownership bootstrap — `RuntimePool.acquire` mkdirs
   * it host-side as the daemon uid, and every tool exec is setpriv-wrapped to
   * that same uid (see `daemonUid`), so files in the workspace are daemon-owned
   * by construction. There is no root-owned surface for shared-cluster-fs to
   * hit EACCES on, so the old recursive `chown -R` bootstrap was removed (it was
   * a one-time cleanup for pre-setpriv legacy trees, and on a large pre-existing
   * workspace its full-tree walk only timed out — see 2026-06-26).
   */
  private async ensureProvisioned(): Promise<void> {
    await this.ensureMountAuthorizations()
    await this.ensureScratchDir()
    await this.ensureHelpersStaged()
  }

  private async ensureMountAuthorizations(): Promise<void> {
    if (this.mountAuthReadyFor === this.workerName) return
    if (this.inflightMountAuth) return this.inflightMountAuth
    this.inflightMountAuth = this.applyMountAuthorizations().finally(() => {
      this.inflightMountAuth = null
    })
    return this.inflightMountAuth
  }

  /** Read and clear the mount issues recorded by the last authorization pass.
   *  Called by a mount-change rebuild (see mount-ops.ts) so the user / admin
   *  can be told which paths the cluster could not mount. */
  consumeMountReport(): MountReport {
    const report = this.lastMountReport
    this.lastMountReport = { unmountable: [] }
    return report
  }

  /** Wait for the worker to be running and its mounts authorized (skips the
   *  slower helper-staging step), then return + clear the mount report. The
   *  rebuild path awaits this so its slash / card response can reflect the
   *  actual mount outcome. */
  async applyMountsAndReport(): Promise<MountReport> {
    await this.waitUntilRunning()
    await this.ensureMountAuthorizations()
    return this.consumeMountReport()
  }

  /** Observe-only: the cluster's storage webhook materializes each path at the
   *  service identity's real GPFS permission (ro / rw); LightClaw never requests
   *  or kernel-enforces the mode, it only observes it. A path the cluster did
   *  not mount at all (observed 'none') is surfaced as an unmountable issue so a
   *  bad path is reported rather than silently absent; it never throws and never
   *  bricks the worker. */
  private async applyMountAuthorizations(): Promise<void> {
    const mounts = this.cfg.extraMounts ?? []
    const unmountable: MountReport['unmountable'] = []
    if (mounts.length > 0) {
      const procMounts = await this.readProcMounts()
      for (const mount of mounts) {
        const observed = observePuyuclawMode(procMounts, mount.workerPath)
        if (observed === 'none') {
          unmountable.push({
            fileset: mount.fileset ?? filesetKeyFromGpfsMount(mount.gpfsMount),
            path: mount.workerPath,
          })
        }
      }
    }
    this.lastMountReport = { unmountable }
    this.mountAuthReadyFor = this.workerName
  }

  private async readProcMounts(): Promise<string> {
    const result = await this.runBrainctlExec({
      command: 'cat /proc/mounts',
      timeoutMs: 30_000,
      maxBufferBytes: 2 * 1024 * 1024,
      privileged: true,
    })
    if (result.exitCode !== 0) {
      throw new Error(`failed to inspect worker mounts: ${result.stderr.trim() || result.stdout.trim()}`)
    }
    return result.stdout
  }

  /**
   * Fire-and-forget: drive a just-(re)created worker to provisioned in the
   * background so the preheat / deploymentHash-respawn / health-restart paths
   * (all of which go through `start()`, never `ensureRunning()`) stage helpers
   * without blocking `start()` — the `wait-ready` contract requires `start()`
   * to return before phase=running. Guarded per workerName so concurrent
   * `start()` callers don't stack redundant drives; a respawn (new workerName)
   * re-arms it. Errors are swallowed-with-log: the next real exec / data-plane
   * call awaits `bringToReady()` synchronously and retries provisioning if this
   * lost the race or failed (the ensure* memos only latch on success).
   */
  private kickBackgroundProvisioning(): void {
    const name = this.workerName
    if (!name || this.provisionDriveFor === name) return
    this.provisionDriveFor = name
    void this.bringToReady().catch(error => {
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(
        `[rlaunch] background provisioning for ${name} did not complete ` +
        `(tools provision lazily on first use): ${detail}\n`,
      )
      // Un-arm so a later start() for the same worker can retry the drive.
      if (this.provisionDriveFor === name) this.provisionDriveFor = null
    })
  }

  /**
   * Idempotently provision the worker-node-local scratch dir (`scratchRoot`)
   * so the agent has a fast local-disk area for git clone / build / archive
   * work instead of paying the ~50x small-file penalty of the gpfs-backed
   * workspace mount. `/scratch` is NOT a gpfs mount — it lives on the worker
   * pod's own filesystem and is wiped when the worker restarts, so this is
   * memoized per workerName and re-runs on respawn, parallel to
   * `ensureHelpersStaged`. Failures are loud but non-fatal: git-heavy work
   * just falls back to the slower workspace mount.
   */
  private async ensureScratchDir(): Promise<void> {
    if (this.scratchDirReadyFor === this.workerName) return
    if (this.inflightScratchDir) return this.inflightScratchDir
    this.inflightScratchDir = this.provisionScratchDirOnce().finally(() => {
      this.inflightScratchDir = null
    })
    return this.inflightScratchDir
  }

  private async provisionScratchDirOnce(): Promise<void> {
    // chmod 1777 (sticky world-writable, like /tmp) lets the setpriv-wrapped
    // daemon-uid tool execs write here without threading the uid into this
    // command. Privileged exec: creating a dir at the container fs root needs
    // root (worker PID 1).
    const result = await this.runBrainctlExec({
      command:
        `mkdir -p ${shellQuote(this.scratchRoot)} && ` +
        `chmod 1777 ${shellQuote(this.scratchRoot)} || true`,
      timeoutMs: 30_000,
      privileged: true,
    })
    if (result.exitCode !== 0) {
      process.stderr.write(
        `[rlaunch] scratch dir provisioning (${this.scratchRoot}) failed ` +
        `for worker ${this.workerName ?? '<unbound>'}; git-heavy work will ` +
        `fall back to the slower workspace mount: ` +
        `${result.stderr.trim() || result.stdout.trim()}\n`,
      )
      // Still memoize so we don't retry every tool call; admin must investigate.
    }
    this.scratchDirReadyFor = this.workerName
  }

  /**
   * Idempotently stage sandbox helpers + install Python deps in the worker.
   *
   * The rlaunch path uses a generic kubebrain image (no `/opt/lightclaw/`
   * baked in, no `markdownify` pre-installed), so the first exec into a
   * fresh worker has to seed both. Cost is one-time per worker (~30s for
   * pip), then memoized via `helpersStagedFor === workerName`.
   *
   * pip is invoked with `-i https://pypi.org/simple/` to bypass the image's
   * default index (an internal mirror unreachable from the worker pod) and
   * relies on the http_proxy injected by NetworkBridge to tunnel egress.
   */
  private async ensureHelpersStaged(): Promise<void> {
    if (this.helpersStagedFor === this.workerName) return
    if (this.inflightStaging) return this.inflightStaging
    this.inflightStaging = this.stageHelpersOnce().finally(() => {
      this.inflightStaging = null
    })
    return this.inflightStaging
  }

  private async stageHelpersOnce(): Promise<void> {
    const probeCmd =
      // pdftotext / pdftoppm gate Read('foo.pdf') text and Read('foo.pdf', pages=...) visual respectively;
      // rg backs Grep + Glob (Glob rewrite uses `rg --files --sort=modified`);
      // jq is not a hard harness dep but model-driven Bash hits `curl | jq` constantly, so probing it
      // here keeps the apt step self-healing instead of leaving 127s for the model to discover;
      // PIL / openpyxl / docx / pptx gate the office and image-resize paths.
      `command -v pdftotext >/dev/null 2>&1 && ` +
      `command -v pdftoppm >/dev/null 2>&1 && ` +
      `command -v rg >/dev/null 2>&1 && ` +
      `command -v jq >/dev/null 2>&1 && ` +
      `python3 -c "import openpyxl, docx, pptx, PIL" 2>/dev/null`
    const probe = await this.runBrainctlExec({
      command: probeCmd,
      timeoutMs: 15_000,
      privileged: true,
    })
    if (probe.exitCode === 0) {
      this.helpersStagedFor = this.workerName
      return
    }

    // Observability: staging is otherwise silent on success, which made a
    // "worker ready but Grep/Glob say rg-not-found" deployment impossible to
    // diagnose from logs. One line in, one line out brackets the ~5-60s apt +
    // pip window so admins can confirm staging actually ran on this worker.
    process.stderr.write(
      `[rlaunch] staging helpers on ${this.workerName ?? '<unknown>'} ` +
      `(apt: poppler-utils ripgrep jq; pip: Pillow openpyxl python-docx python-pptx)\n`,
    )

    // Apt deps for the rlaunch ml-base image (ubuntu 22.04 + ML libs, no dev tooling).
    // Confirmed missing in 2026-05-13 dep audit on a fresh worker:
    //   - poppler-utils → pdftotext + pdftoppm + pdfinfo (Read tool's PDF text + visual paths)
    //   - ripgrep       → Grep + Glob (`rg --files --sort=modified`)
    //   - jq            → not a hard harness dep, but model-driven Bash hits `curl | jq`
    //                     and `cat foo.json | jq` constantly. ~2 MB cost, prevents per-call exit 127.
    // Without staging here every Glob/Grep returned exit 127 (`bash: rg: command not found`)
    // and prior to the `isWorkerLostError` exit-127 guard, the substring 'not found'
    // tripped the worker-lost retry+respawn loop on every call.
    // Combined apt install is ~5–6 s on the corp mirror, well under the 240 s budget.
    // apt is best-effort: root + working corp mirror are usual on this image, but if
    // either fails we surface the error and let the affected tools degrade with their
    // own "install <pkg>" warnings (Grep already has a `grep -R` fallback; Glob
    // returns an error message telling the model to fall back to `Bash` with
    // `find` / `ls`; jq just returns 127 to the model).
    const apt = await this.runBrainctlExec({
      command:
        'command -v pdftotext >/dev/null 2>&1 && command -v pdftoppm >/dev/null 2>&1 ' +
        '&& command -v rg >/dev/null 2>&1 && command -v jq >/dev/null 2>&1 || ' +
        'apt-get update -qq && apt-get install -y -qq --no-install-recommends poppler-utils ripgrep jq',
      timeoutMs: 240_000,
      maxBufferBytes: 4 * 1024 * 1024,
      privileged: true,
    })
    if (apt.exitCode !== 0) {
      process.stderr.write(
        `[rlaunch] poppler-utils + ripgrep + jq install failed (PDF / Grep / Glob / jq tools will degrade): ${apt.stderr.trim() || apt.stdout.trim()}\n`,
      )
    }

    // Python deps. Use the image's pre-configured pip mirror (typically an
    // internal pypi inside .pjlab.org.cn): pjlab's outbound proxy black-holes
    // pypi.org / tuna / aliyun, so an explicit `-i https://pypi.org/simple/`
    // hangs forever (worker pip routes through the NetworkBridge http_proxy
    // → upstream proxy → blocked). The matching `no_proxy=...,.pjlab.org.cn`
    // injected via `buildBridgeEnv` lets pip reach the internal mirror
    // directly without traversing the bridge.
    // Pillow / openpyxl / python-docx / python-pptx feed the resize gate +
    // office extractors; pin only minor floors to track upstream security
    // fixes without bumping major API breakage. Phase 34 removed httpx +
    // markdownify here because the webfetch / websearch helpers they
    // backed were deleted in Iter C0 (daemon-side TS now).
    const pip = await this.runBrainctlExec({
      command:
        'python3 -m pip install --quiet --no-warn-script-location ' +
        '--break-system-packages ' +
        '"Pillow>=10,<12" "openpyxl>=3.1,<4" "python-docx>=1.1,<2" "python-pptx>=1.0,<2"',
      timeoutMs: 240_000,
      maxBufferBytes: 4 * 1024 * 1024,
      privileged: true,
    })
    if (pip.exitCode !== 0) {
      throw new Error(
        `RlaunchRuntime helper staging: pip install failed: ` +
          `${pip.stderr.trim() || pip.stdout.trim()}`,
      )
    }

    this.helpersStagedFor = this.workerName
    process.stderr.write(
      `[rlaunch] helper staging complete on ${this.workerName ?? '<unknown>'}\n`,
    )
  }

  private async waitUntilRunning(): Promise<void> {
    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      const name = this.workerName
      if (!name) {
        await this.start()
        continue
      }
      const phase = await this.processPhase(name)
      if (phase === 'running') {
        this.tracker.markReady()
        return
      }
      if (phase === 'failed' || phase === 'stopped' || phase === 'absent') {
        this.tracker.markFailed(`worker ${name} is ${phase}`)
        throw new Error(`RlaunchRuntime worker ${name} is ${phase}`)
      }
      await delay(3000)
    }
    throw new Error(`RlaunchRuntime worker ${this.workerName ?? '<unknown>'} did not become Running in time.`)
  }

  private async runBrainctlExec(input: ExecInput): Promise<ExecResult> {
    if (!this.workerName) {
      throw new Error('RlaunchRuntime worker is not started.')
    }
    // brainctl exec is a control channel only. Its websocket exec stream
    // silently drops bytes on large payloads in BOTH directions (the
    // `9cafbdc` stdin incident: ~16% writeFile corruption; the 6 MB PDF
    // stdout byte-mismatch dogfood bug). `ExecInput.stdin` is therefore
    // unsupported — callers stage payloads via fs.writeFile — and tool
    // command output is redirected to files on the gpfs-backed workspace
    // rather than streamed back over brainctl stdout.
    if (input.stdin !== undefined) {
      throw new Error(
        'RlaunchRuntime exec does not accept ExecInput.stdin; stage the ' +
        'payload with fs.writeFile and read it from disk inside the command.',
      )
    }
    // Privileged bootstrap execs (helper staging) keep brainctl's own
    // stdout: they run as root, so capture files written under the workspace
    // would be root-owned and unreadable by the non-root daemon, and their
    // output is small / log-only anyway.
    if (input.privileged === true) {
      return runProcess('brainctl', buildBrainppExecArgs({
        namespace: this.cfg.namespace,
        workerName: this.workerName,
        wrappedCommand: this.wrapCommand(input),
      }), {
        abortSignal: input.abortSignal,
        env: withoutProxyEnv(),
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBufferBytes: input.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
        limitMessage: 'rlaunch worker exec terminated',
      })
    }
    // Tool execs: the command's stdout / stderr land in per-call files on the
    // gpfs-backed workspace; brainctl stdout carries only `LIGHTCLAW_EXIT:<n>`.
    const id = this.execScratchId()
    const scratchDir = this.execScratchDirContainer()
    const outFile = path.posix.join(scratchDir, `${id}.out`)
    const errFile = path.posix.join(scratchDir, `${id}.err`)
    const brainctlResult = await runProcess(
      'brainctl',
      buildBrainppExecArgs({
        namespace: this.cfg.namespace,
        workerName: this.workerName,
        wrappedCommand: this.wrapCommand(input, { outFile, errFile }),
      }),
      {
        abortSignal: input.abortSignal,
        env: withoutProxyEnv(),
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBufferBytes: BRAINCTL_MARKER_BUFFER_BYTES,
        limitMessage: 'rlaunch worker exec terminated',
      },
    )
    return this.collectExecOutput(
      brainctlResult,
      outFile,
      errFile,
      input.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
    )
  }

  /** Container-path scratch dir for exec output-capture files and exec-relay
   *  file staging. Under the workspace mount so it is host-visible via
   *  shared-cluster-fs; swept by inbox-aging at a 6h TTL. */
  private execScratchDirContainer(): string {
    return path.posix.join(this.workspaceRoot, EXEC_SCRATCH_SUBDIR)
  }

  /** Per-call unique basename for a scratch file. randomUUID alone guarantees
   *  no collision between concurrent execs — the rlaunch worker (and its one
   *  exec dir) is shared by every session and dispatched worker of a single
   *  canonical user — and the canonical-user prefix is a human-readable
   *  marker for any straggler the 6h sweep has to reap. */
  private execScratchId(): string {
    const marker = this.canonicalUser.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48)
    return `${marker}-${randomUUID()}`
  }

  /** Assemble an `ExecResult` from a capture-mode brainctl call: parse the
   *  `LIGHTCLAW_EXIT:<n>` marker off brainctl stdout, read the command's
   *  stdout / stderr from their gpfs-backed files host-side, then delete them.
   *  When no marker is present the wrapped script never ran (a brainctl-level
   *  failure); the raw brainctl result is returned so `exec()`'s
   *  `isWorkerLostError` still sees the real control-plane envelope. */
  private async collectExecOutput(
    brainctlResult: ExecResult,
    outFile: string,
    errFile: string,
    capBytes: number,
  ): Promise<ExecResult> {
    const exitCode = parseExitMarker(brainctlResult.stdout)
    if (exitCode === null) {
      return brainctlResult
    }
    const outHost = this.toHostPath(outFile)
    const errHost = this.toHostPath(errFile)
    const out = outHost
      ? await readCappedFile(outHost, capBytes)
      : { text: '', truncated: false }
    const err = errHost
      ? await readCappedFile(errHost, capBytes)
      : { text: '', truncated: false }
    if (outHost) await fsp.rm(outHost, { force: true }).catch(() => {})
    if (errHost) await fsp.rm(errHost, { force: true }).catch(() => {})
    let stderr = err.text
    if (out.truncated) {
      stderr += `${stderr ? '\n' : ''}[stdout truncated at ${capBytes} bytes]`
    }
    if (err.truncated) {
      stderr += `${stderr ? '\n' : ''}[stderr truncated at ${capBytes} bytes]`
    }
    return { stdout: out.text, stderr, exitCode }
  }

  private wrapCommand(
    input: ExecInput,
    capture?: { outFile: string; errFile: string },
  ): string {
    const cwd = input.cwd ? this.toContainerPath(input.cwd) : this.workspaceRoot
    const privileged = input.privileged === true
    // Agent execs run as the daemon uid, which cannot write the image's default
    // HOME (/root) — every HOME-default tool (pip --user, conda -n, ~/.cache,
    // ~/.gitconfig, ~/.ssh, HF cache) would hit permission-denied. Point HOME at
    // a writable, persistent dir under the workspace so those Just Work and
    // survive worker restarts. Privileged bootstrap execs keep the image HOME.
    const env = agentExecEnv(this.workspaceRoot, privileged, input.env)
    return composeExecScript({
      command: input.command,
      env,
      cwd,
      dropPrivileges: privileged
        ? undefined
        : { uid: this.cfg.daemonUid, gid: this.cfg.daemonGid },
      capture: privileged || !capture
        ? undefined
        : {
            outFile: capture.outFile,
            errFile: capture.errFile,
            execDir: this.execScratchDirContainer(),
            maxBytes: input.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
          },
    })
  }

  private async spawnWorker(): Promise<string> {
    const args = this.launchArgs({ detach: true, predictOnly: false })
    const result = await runProcess('rlaunch', args, {
      env: withoutProxyEnv(),
      timeoutMs: START_TIMEOUT_MS,
      maxBufferBytes: DEFAULT_MAX_BUFFER_BYTES,
      limitMessage: 'rlaunch worker launch terminated',
    })
    if (result.exitCode !== 0) {
      const formatted = formatRlaunchError(`${result.stderr}\n${result.stdout}`, this.cfg)
      this.tracker.markFailed(formatted)
      throw new Error(`rlaunch failed: ${formatted}`)
    }
    const name = parseWorkerName(`${result.stdout}\n${result.stderr}`)
    if (!name) {
      const detail = `cannot parse worker name from rlaunch output:\n${result.stdout}\n${result.stderr}`
      this.tracker.markFailed(detail)
      throw new Error(detail)
    }
    return name
  }

  private async runPredict(): Promise<void> {
    const result = await runProcess('rlaunch', this.launchArgs({
      detach: false,
      predictOnly: true,
    }), {
      env: withoutProxyEnv(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxBufferBytes: DEFAULT_MAX_BUFFER_BYTES,
      limitMessage: 'rlaunch predict terminated',
    })
    if (result.exitCode !== 0) {
      const formatted = formatRlaunchError(`${result.stderr}\n${result.stdout}`, this.cfg)
      if (isQuotaLike(`${result.stderr}\n${result.stdout}`)) {
        this.tracker.markQuotaDenied(formatted)
      } else {
        this.tracker.markFailed(formatted)
      }
      throw new Error(`rlaunch predict failed: ${formatted}`)
    }
  }

  private launchArgs(input: { detach: boolean; predictOnly: boolean }): string[] {
    return buildBrainppLaunchArgs(this.cfg, input)
  }

  private async processPhase(name: string): Promise<ProcessState> {
    const result = await runProcess('brainctl', buildBrainppGetProcessArgs(this.cfg.namespace, name), {
      env: withoutProxyEnv(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxBufferBytes: DEFAULT_MAX_BUFFER_BYTES,
      limitMessage: 'brainctl process inspect terminated',
    })
    if (result.exitCode !== 0) {
      this.lastKnownState = this.isNotFoundOrForbidden(result) ? 'absent' : 'unknown'
      return this.lastKnownState
    }
    const columns = result.stdout.trim().split(/\s+/)
    const status = columns[4]?.toLowerCase()
    this.lastKnownState = normalizeProcessState(status)
    return this.lastKnownState
  }

  private async stopWorker(name: string): Promise<void> {
    const result = await runProcess('brainctl', buildBrainppStopProcessArgs(this.cfg.namespace, name), {
      env: withoutProxyEnv(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxBufferBytes: DEFAULT_MAX_BUFFER_BYTES,
      limitMessage: 'brainctl stop process terminated',
    })
    if (result.exitCode !== 0 && !/current phase is Stopped|not found/i.test(`${result.stderr}\n${result.stdout}`)) {
      throw new Error(`brainctl stop process/${name} failed: ${result.stderr.trim() || result.stdout.trim()}`)
    }
  }

  private isWorkerLostError(result: ExecResult): boolean {
    return isBrainppWorkerLostExecFailure(result)
  }

  private isNotFoundOrForbidden(result: ExecResult): boolean {
    return isBrainppNotFoundOrForbidden(result)
  }

  private toContainerPath(pathname: string): string {
    const normalizedContainerPath = path.posix.normalize(pathname)
    if (normalizedContainerPath === this.workspaceRoot ||
      normalizedContainerPath.startsWith(`${this.workspaceRoot}/`)) {
      return normalizedContainerPath
    }

    // Host-side absolute paths mapped to a configured mount get translated to
    // the matching container prefix.
    const resolved = path.resolve(pathname)
    for (const [hostPrefix, containerPrefix] of this.mountTable) {
      if (resolved === hostPrefix || resolved.startsWith(`${hostPrefix}${path.sep}`)) {
        return path.posix.join(containerPrefix, resolved.slice(hostPrefix.length))
      }
    }

    // Other absolute paths (`/tmp`, `/var/log`, `/proc/...`, ...) are
    // container-local. Pass through to the exec-relay layer, which runs in the
    // container via brainctl and sees the worker's own filesystem. shared-
    // cluster-fs self-filters via `PathPolicy.isShared` so it never gets these
    // paths. Container isolation + the Phase 5 permission system are the
    // actual safety boundary; this finishes the sweep started in 18ff987 that
    // removed path-string guards from tools / permission policy.
    if (path.posix.isAbsolute(normalizedContainerPath)) {
      return normalizedContainerPath
    }

    throw new Error(`Path is not absolute: ${pathname}`)
  }

  /** Reverse of {@link toContainerPath}. Container path → host path via
   *  `mountTable`. Accepts either a container path (`/workspace/...`) or an
   *  already-host path (`/mnt/.../...`); returns null if the input falls
   *  outside every mount, which lets `writeFileViaHostMount` opt out cleanly
   *  without throwing. Pure: no fs probing here, the caller does that. */
  private toHostPath(pathname: string): string | null {
    const normalizedContainer = path.posix.normalize(pathname)
    for (const [hostPrefix, containerPrefix] of this.mountTable) {
      if (
        normalizedContainer === containerPrefix ||
        normalizedContainer.startsWith(`${containerPrefix}/`)
      ) {
        const suffix = normalizedContainer.slice(containerPrefix.length)
        return path.join(hostPrefix, suffix)
      }
    }
    const resolvedHost = path.resolve(pathname)
    for (const [hostPrefix] of this.mountTable) {
      if (resolvedHost === hostPrefix || resolvedHost.startsWith(`${hostPrefix}${path.sep}`)) {
        return resolvedHost
      }
    }
    return null
  }
}

/**
 * Build the bash script that goes to `brainctl exec ... -- bash -c <script>`.
 * Pure: no class state, no side effects. The dispatcher (RlaunchRuntime.exec)
 * resolves cwd against the mount table and hands us a container-side path.
 *
 * Two shapes:
 *
 * Privileged / no-capture (bootstrap: helper staging) — output streams
 * back on brainctl's own stdout:
 *   <env> cd '<cwd>' && <command>
 *   <env> cd '<cwd>' && setpriv --reuid=<u> --regid=<g> … -- bash -c '<command>'
 *
 * Capture (every agent-dispatched tool exec) — the command's stdout / stderr
 * are redirected to files on the gpfs-backed workspace so the bytes never
 * traverse brainctl's unreliable-large exec stdout; brainctl stdout carries
 * only the `LIGHTCLAW_EXIT:<n>` marker:
 *   <env> setpriv … -- bash -c '
 *     mkdir -p <execDir> && cd <cwd> &&
 *     { <command>; } 2> <errFile> | head -c <cap> > <outFile>
 *     echo "LIGHTCLAW_EXIT:${PIPESTATUS[0]}"'
 *
 * `head -c <cap>` is a real pipe (not process substitution): when the cap is
 * hit head closes the pipe, the command takes SIGPIPE and dies, so a runaway
 * cannot fill the gpfs mount; and because it is a pipeline stage, the wrapped
 * bash does not exit until head has fully drained — no read-before-flush race.
 * `${PIPESTATUS[0]}` is the command's own exit code (head's is `[1]`). stderr
 * goes straight to a file (host-capped on read; a stderr-only runaway is
 * bounded by the exec timeout). The capture path is always setpriv-wrapped so
 * the files are daemon-owned and the daemon can read them back host-side;
 * `env` exports cross the setpriv boundary, `cwd` is applied by the inner
 * shell.
 */
export function composeExecScript(input: {
  command: string
  env?: Record<string, string>
  cwd: string
  dropPrivileges?: { uid: number; gid: number }
  capture?: { outFile: string; errFile: string; execDir: string; maxBytes: number }
}): string {
  const envPart = input.env && Object.keys(input.env).length > 0
    ? `${Object.entries(input.env)
      .map(([key, value]) => `export ${key}=${shellQuote(value)};`)
      .join(' ')} `
    : ''

  if (!input.capture) {
    const cwdCd = `cd ${shellQuote(input.cwd)} && `
    if (!input.dropPrivileges) {
      return `${envPart}${cwdCd}${input.command}`
    }
    const { uid, gid } = input.dropPrivileges
    return (
      `${envPart}${cwdCd}setpriv ` +
      `--reuid=${uid} --regid=${gid} --clear-groups --inh-caps=-all ` +
      `-- bash -c ${shellQuote(input.command)}`
    )
  }

  if (!input.dropPrivileges) {
    // A capture request without setpriv would write root-owned files the
    // non-root daemon cannot read back. wrapCommand always pairs them.
    throw new Error('composeExecScript: capture mode requires dropPrivileges')
  }
  const { outFile, errFile, execDir, maxBytes } = input.capture
  // The brace group around <command> keeps the redirections attached to the
  // whole user command, not just its first segment.
  const body =
    `mkdir -p ${shellQuote(execDir)} && cd ${shellQuote(input.cwd)} && ` +
    `{ ${input.command}; } 2> ${shellQuote(errFile)} ` +
    `| head -c ${maxBytes} > ${shellQuote(outFile)}\n` +
    `echo "LIGHTCLAW_EXIT:${'${PIPESTATUS[0]}'}"`
  const { uid, gid } = input.dropPrivileges
  return (
    `${envPart}setpriv ` +
    `--reuid=${uid} --regid=${gid} --clear-groups --inh-caps=-all ` +
    `-- bash -c ${shellQuote(body)}`
  )
}

export function buildLaunchArgs(
  cfg: RlaunchRuntimeConfig,
  input: { detach: boolean; predictOnly: boolean },
): string[] {
  return buildBrainppLaunchArgs(cfg, input)
}

export function buildBrainppExecArgs(input: {
  namespace: string
  workerName: string
  wrappedCommand: string
}): string[] {
  return [
    '-n', input.namespace,
    'exec', `process/${input.workerName}`,
    '--', 'bash', '-c', input.wrappedCommand,
  ]
}

export function buildBrainppGetProcessArgs(namespace: string, name: string): string[] {
  return [
    '-n',
    namespace,
    'get',
    'process',
    name,
    '--no-headers',
  ]
}

export function buildBrainppStopProcessArgs(namespace: string, name: string): string[] {
  return [
    '-n',
    namespace,
    'stop',
    `process/${name}`,
  ]
}

export function buildBrainppLaunchArgs(
  cfg: RlaunchRuntimeConfig,
  input: { detach: boolean; predictOnly: boolean },
): string[] {
  const args = [
    '--gpu',
    String(cfg.gpu),
    '--cpu',
    String(cfg.cpu),
    '--memory',
    String(cfg.memoryMb),
    '--namespace',
    cfg.namespace,
    '--charged-group',
    cfg.chargedGroup,
    `--image=${cfg.image}`,
    `--private-machine=${cfg.privateMachine}`,
    `--image-pull-policy=${cfg.imagePullPolicy}`,
    `--max-wait-duration=${cfg.maxWaitDuration}`,
    `--worker-garbage-collection-time=${formatGcDuration(cfg.workerGcTimeHours)}`,
  ]
  for (const mount of [cfg.workspaceGpfsMount, ...(cfg.extraMounts ?? []).map(mount => mount.gpfsMount)]) {
    args.push(`--mount=${mount}`)
  }
  for (const tag of cfg.positiveTags) {
    args.push(`--positive-tags=${tag}`)
  }
  // Use --set-env (NOT -e/--env) so the value lands in the worker pod's
  // PodSpec env. rlaunch's -e flag silently drops everything in detached
  // mode (`rlaunch -d`); only interactive/attached mode forwards it.
  // Verified empirically against `brainctl describe process` — -e produces
  // an empty Env block, --set-env produces the expected entries.
  // Env injection happens before predictOnly fast-return so predict and
  // detached spawn share identical args (predict surfaces env-related
  // failures fail-fast before the real worker burns scheduling time).
  for (const [key, value] of Object.entries(cfg.env)) {
    args.push(`--set-env=${key}=${value}`)
  }
  if (input.predictOnly) {
    args.push('--predict-only=true', '--', 'bash')
    return args
  }
  if (input.detach) {
    args.unshift('-d')
  }
  args.push(
    `--comment=lightclaw-runtime-${cfg.canonicalUser}-${cfg.deploymentHash}`,
    '--',
    'bash',
    '-c',
    'sleep infinity',
  )
  return args
}

export function isBrainppWorkerLostExecFailure(result: ExecResult): boolean {
  if (result.exitCode === 0) return false
  // POSIX shell "command not found" is exit 127. The 'not found' substring
  // below would otherwise trip on `bash: line 1: rg: command not found`
  // (rlaunch ml-base image ships without ripgrep, jq, yq, etc.) and respawn
  // the worker once per Glob/Grep call. 127 is unique to in-shell command
  // resolution; brainctl control-plane / kubelet faults surface as non-127
  // exits (typically 1, or 137 on SIGKILL).
  if (result.exitCode === 127) return false
  // Scope the substring scan to brainctl/k8s error envelopes only. Whole-output
  // scans false-positive on user-program text containing "not found".
  const envelopeLines = result.stderr
    .split('\n')
    .filter(line => /^(error:|Error from server)/i.test(line))
    .join('\n')
    .toLowerCase()
  return (
    envelopeLines.includes('not found') ||
    envelopeLines.includes('connection refused') ||
    envelopeLines.includes('unable to upgrade connection') ||
    envelopeLines.includes('unavailable process') ||
    envelopeLines.includes('cannot exec into a container')
  )
}

export function isBrainppNotFoundOrForbidden(result: ExecResult): boolean {
  const msg = `${result.stderr}\n${result.stdout}`.toLowerCase()
  return msg.includes('notfound') ||
    msg.includes('not found') ||
    msg.includes('forbidden')
}

export function parseWorkerName(output: string): string | null {
  const lines = output
    .split('\n')
    .map(line => line.trim().replace(/\x1b\[[0-9;]*m/g, ''))
    .filter(Boolean)
  for (const line of lines.reverse()) {
    if (/^ws-[a-z0-9-]+-worker-[a-z0-9]+$/.test(line) || /^worker-[a-z0-9-]+$/.test(line)) {
      return line
    }
  }
  return null
}

function normalizeProcessState(status: string | undefined): ProcessState {
  switch (status) {
    case 'running':
      return 'running'
    case 'starting':
    case 'containercreating':
      return 'starting'
    case 'pending':
    case 'queued':
      return 'pending'
    case 'stopped':
      return 'stopped'
    case 'failed':
    case 'error':
      return 'failed'
    default:
      return 'unknown'
  }
}

function isQuotaLike(raw: string): boolean {
  const text = raw.toLowerCase()
  return text.includes('quota') ||
    text.includes('资源不足') ||
    text.includes('无可用机器') ||
    text.includes('no machine is available')
}

function formatGcDuration(hours: number): string {
  if (hours < 1) {
    return `${Math.max(15, Math.round(hours * 60))}m`
  }
  return Number.isInteger(hours) ? `${hours}h` : `${Math.round(hours * 60)}m`
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// In-place retry pause between the first worker-lost-like brainctl error
// and the second attempt before deciding to respawn. 1s is empirically
// long enough for control-plane / websocket transients to clear without
// stalling real death-recovery noticeably (worker spawn itself takes 10s+).
// `let` not `const` so test fixtures can drop the wait to 1ms via
// `setWorkerLostRetryDelayMsForTests`; production code never reassigns.
let workerLostRetryDelayMs = 1000
export function setWorkerLostRetryDelayMsForTests(ms: number): void {
  workerLostRetryDelayMs = ms
}
export function getWorkerLostRetryDelayMsForTests(): number {
  return workerLostRetryDelayMs
}

function truncateForLog(s: string | undefined, cap = 200): string {
  if (!s) return '<empty>'
  const trimmed = s.trim()
  if (trimmed.length <= cap) return trimmed
  return `${trimmed.slice(0, cap)}…(+${trimmed.length - cap}B)`
}

/** Extract the exit code from a `LIGHTCLAW_EXIT:<n>` line emitted by the
 *  capture-mode exec wrapper. Returns null when no marker is present — the
 *  signal that the wrapped script never ran (brainctl-level failure), so the
 *  caller should fall back to the raw brainctl result. */
export function parseExitMarker(stdout: string): number | null {
  const matches = stdout.match(/^LIGHTCLAW_EXIT:(-?\d+)\r?$/gm)
  if (!matches || matches.length === 0) {
    return null
  }
  const last = matches[matches.length - 1]
  const n = Number(last.replace(/^LIGHTCLAW_EXIT:/, '').trim())
  return Number.isFinite(n) ? n : null
}

/** Read a capture file host-side, decoding as UTF-8 and trimming to `cap`
 *  bytes. A missing file decodes to empty: a command that produced no output
 *  still creates its redirection target, but a script-level failure may
 *  skip it. */
async function readCappedFile(
  hostPath: string,
  cap: number,
): Promise<{ text: string; truncated: boolean }> {
  let buf: Buffer
  try {
    buf = await fsp.readFile(hostPath)
  } catch {
    return { text: '', truncated: false }
  }
  if (buf.length > cap) {
    return { text: buf.subarray(0, cap).toString('utf8'), truncated: true }
  }
  return { text: buf.toString('utf8'), truncated: false }
}
