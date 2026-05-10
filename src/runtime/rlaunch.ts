import { readFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
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
import { resolveDefaultHelperRoot } from './local.js'
import { runProcess, shellQuote } from './process.js'
import { formatRlaunchError, translateRlaunchError } from './rlaunch-errors.js'
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
  helperContainerPath: string
  /** Env injected at worker creation via `rlaunch -e KEY=VALUE`. */
  env: Readonly<Record<string, string>>
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
// Cap for stdin payloads inlined into the bash command body via base64. brainctl
// exec's stdin pipe is unreliable (silent drops + stdout suppression — see
// runBrainctlExec / wrapCommand for the full story), so RlaunchRuntime never
// uses it; instead the stdin payload rides inside the same `bash -c` command
// string the worker is already running.
//
// The bottleneck is NOT Linux's MAX_ARG_STRLEN (128 KB) but brainctl's own
// websocket frame limit. Empirical probing on this cluster: scripts up to
// ~56.6 KB total succeed; anything above returns `websocket: bad handshake`
// at the host before reaching the worker. base64 expansion is 4/3, so the raw
// payload ceiling is ~42 KB. We cap at 32 KB to leave headroom for env-var
// exports, long container paths, and any cluster-side tightening of that
// frame limit. fs.writeFile transparently chunks above this; helper-side
// stdin (websearch / webfetch / glob JSON) is < 1 KB so it never gets close.
const MAX_INLINE_STDIN_BYTES = 32 * 1024
// fs.writeFile chunk size for payloads above MAX_INLINE_STDIN_BYTES. Each
// chunk is one exec round-trip (truncate + N appends + stat). 32 KB chunks =
// 32 round-trips per MB; multi-MB writes are slow but correct. If perf ever
// matters here, write via the gpfs bind mount on the host instead.
const WRITE_FILE_CHUNK_BYTES = 32 * 1024
// fs.readFile single-hop stdout cap. Output is bounded by `runProcess`'s
// `maxBufferBytes` (a self-imposed cap, NOT a brainctl ws-frame limit — the
// frame limit only applies to the daemon→worker stdin direction). Picked at
// 256 MB so a 100 MB raw file (the tool-side cap for PDFs / images via
// `MAX_PDF_BYTES` / `MAX_IMAGE_BYTES`) → ~134 MB base64 stdout fits with
// headroom; daemon RAM (typically 16 GB+ on cluster dev nodes) is plenty.
//
// History: prior versions chunked at 512 KB raw via `dd skip=K count=1 |
// base64 -w 0` to stay under a 4 MB cap. The chunked path silently truncated
// occasional hops (~8 KB lost on a 4.5 MB PDF in 2026-05-10 dogfood) and
// surfaced as `byte mismatch (expected X, got Y)` from the post-loop stat
// guard. Single-hop `base64 -w 0 path` eliminates the chunking protocol
// entirely (no per-hop seek + concat = no chance to lose hops). For files
// > 192 MB raw, the cap throws loud rather than silently truncate.
const READ_FILE_BUFFER_BYTES = 256 * 1024 * 1024

export class RlaunchRuntime implements Runtime {
  readonly kind = 'rlaunch' as const
  readonly isolated = true
  readonly workspaceRoot: string
  readonly helperRoot: string
  readonly canonicalUser: string

  lastActivityMs = Date.now()

  private readonly cfg: RlaunchRuntimeConfig
  private readonly tracker: WorkerReadinessTracker
  private readonly mountTable: Array<[string, string]>
  private workerName: string | null = null
  private lastKnownState: ProcessState = 'unknown'
  private inflightStart: Promise<void> | null = null
  /** Memoizes successful helper staging per worker. Reset implicitly when
   *  workerName changes (worker restart / GC) so the next ensureRunning()
   *  re-stages into the fresh container. */
  private helpersStagedFor: string | null = null
  private inflightStaging: Promise<void> | null = null
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
    this.helperRoot = config.helperContainerPath
    this.mountTable = [[path.resolve(config.workspaceHostPath), config.workspaceContainerPath]]
  }

  get name(): string | null {
    return this.workerName
  }

  /** Snapshot of the per-user worker readiness tracker. Exposed so the
   *  /sandbox status admin command can render rlaunch-flavored health
   *  (worker state / cluster image / schedule duration / last error)
   *  instead of the docker-flavored ImageReadinessTracker that doesn't
   *  apply to this backend. */
  workerSnapshot(): WorkerReadinessSnapshot {
    return this.tracker.snapshot()
  }

  async start(triggerReason?: string): Promise<void> {
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
  }

  async isAvailable(): Promise<RuntimeAvailability> {
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
        userMessage:
          `集群正在准备你的工作环境（已 ${elapsed} 秒）。我现在不能执行命令、读写文件或抓取网页，` +
          '但可以继续聊天。',
        adminMessage:
          `RlaunchRuntime worker scheduling for ${this.cfg.canonicalUser} ` +
          `(image=${snap.image ?? this.cfg.image}, elapsed=${elapsed}s)`,
      }
    }
    if (snap.state === 'quota-denied') {
      return {
        ok: false,
        reason: 'worker-quota-denied',
        userMessage: '集群资源暂时不足，当前不能使用工具。已记录给管理员排查。',
        adminMessage: snap.lastError ??
          `RlaunchRuntime quota denied for ${this.cfg.canonicalUser}`,
      }
    }
    return {
      ok: false,
      reason: 'worker-failed',
      userMessage: '集群工作环境未就绪。已记录给管理员排查，目前我只能处理聊天类话题。',
      adminMessage: snap.lastError ?? `RlaunchRuntime worker failed for ${this.cfg.canonicalUser}`,
    }
  }

  async stop(): Promise<void> {
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
    await this.stop().catch(() => {})
    await deleteWorkerRecord(this.cfg.canonicalUser)
    this.workerName = null
  }

  isRunning(): boolean {
    return this.lastKnownState === 'running'
  }

  async exec(input: ExecInput): Promise<ExecResult> {
    this.lastActivityMs = Date.now()
    await this.ensureRunning()
    const result = await this.runBrainctlExec(input)
    if (!this.isWorkerLostError(result)) {
      return result
    }

    await deleteWorkerRecord(this.cfg.canonicalUser)
    this.workerName = null
    await this.start('worker-lost on exec, retrying')
    await this.waitUntilRunning()
    const retry = await this.runBrainctlExec(input)
    return {
      ...retry,
      stderr: `[runtime] worker restarted, container-local /tmp etc. lost\n${retry.stderr}`,
    }
  }

  fs: RuntimeFs = {
    readFile: async pathname =>
      readFileViaExec(input => this.exec(input), this.toContainerPath(pathname), pathname),
    writeFile: async (pathname, content) => {
      const containerPath = this.toContainerPath(pathname)
      const buffer = typeof content === 'string' ? Buffer.from(content) : content
      const expectedBytes = buffer.length
      // Single-hop fast path for payloads that fit under the inline cap.
      // Stream content via ExecInput.stdin; runBrainctlExec folds it into the
      // command body so brainctl's broken stdin pipe is never on the hot path.
      // stat on the same shell hop catches partial / mismatched writes as a
      // thrown error instead of silent success.
      if (buffer.length <= WRITE_FILE_CHUNK_BYTES) {
        const command =
          `mkdir -p "$(dirname ${shellQuote(containerPath)})" && ` +
          `cat > ${shellQuote(containerPath)} && ` +
          `stat -c %s ${shellQuote(containerPath)}`
        const result = await this.exec({
          command,
          stdin: buffer,
          maxBufferBytes: DEFAULT_MAX_BUFFER_BYTES,
        })
        if (result.exitCode !== 0) {
          throw new Error(`writeFile ${pathname}: ${result.stderr.trim() || result.stdout.trim()}`)
        }
        const actualBytes = Number(result.stdout.trim())
        if (!Number.isFinite(actualBytes) || actualBytes !== expectedBytes) {
          throw new Error(
            `writeFile ${pathname}: byte mismatch (expected ${expectedBytes}, ` +
              `wrote ${result.stdout.trim() || 'unknown'})`,
          )
        }
        return
      }

      // Chunked path for payloads above the per-arg ceiling. Each exec call
      // streams one chunk (≤ WRITE_FILE_CHUNK_BYTES raw → comfortably under
      // MAX_INLINE_STDIN_BYTES once base64-expanded). The first chunk truncates
      // (`cat >`); subsequent chunks append (`cat >>`). A final stat verifies
      // the assembled total size. We do NOT parallelize: appends must be
      // ordered to keep the file byte-identical.
      const firstChunk = buffer.subarray(0, WRITE_FILE_CHUNK_BYTES)
      const truncate = await this.exec({
        command:
          `mkdir -p "$(dirname ${shellQuote(containerPath)})" && ` +
          `cat > ${shellQuote(containerPath)}`,
        stdin: firstChunk,
        maxBufferBytes: DEFAULT_MAX_BUFFER_BYTES,
      })
      if (truncate.exitCode !== 0) {
        throw new Error(
          `writeFile ${pathname} (chunk 0): ${truncate.stderr.trim() || truncate.stdout.trim()}`,
        )
      }

      for (let offset = WRITE_FILE_CHUNK_BYTES; offset < buffer.length; offset += WRITE_FILE_CHUNK_BYTES) {
        const end = Math.min(offset + WRITE_FILE_CHUNK_BYTES, buffer.length)
        const chunk = buffer.subarray(offset, end)
        const append = await this.exec({
          command: `cat >> ${shellQuote(containerPath)}`,
          stdin: chunk,
          maxBufferBytes: DEFAULT_MAX_BUFFER_BYTES,
        })
        if (append.exitCode !== 0) {
          throw new Error(
            `writeFile ${pathname} (chunk @${offset}): ${append.stderr.trim() || append.stdout.trim()}`,
          )
        }
      }

      const stat = await this.exec({
        command: `stat -c %s ${shellQuote(containerPath)}`,
      })
      if (stat.exitCode !== 0) {
        throw new Error(
          `writeFile ${pathname} (final stat): ${stat.stderr.trim() || stat.stdout.trim()}`,
        )
      }
      const actualBytes = Number(stat.stdout.trim())
      if (!Number.isFinite(actualBytes) || actualBytes !== expectedBytes) {
        throw new Error(
          `writeFile ${pathname}: byte mismatch (expected ${expectedBytes}, ` +
            `wrote ${stat.stdout.trim() || 'unknown'})`,
        )
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
    if (!this.workerName) {
      await this.start()
    }
    await this.waitUntilRunning()
    await this.ensureHelpersStaged()
  }

  /**
   * Idempotently stage sandbox helpers + install Python deps in the worker.
   *
   * The rlaunch path uses a generic kubebrain image (no `/opt/lightclaw/`
   * baked in, no `markdownify` / `trafilatura` pre-installed), so the first
   * exec into a fresh worker has to seed both. Cost is one-time per worker
   * (~30s for pip), then memoized via `helpersStagedFor === workerName`.
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
      `test -f ${shellQuote(path.posix.join(this.helperRoot, 'webfetch.py'))} && ` +
      `test -f ${shellQuote(path.posix.join(this.helperRoot, 'websearch.py'))} && ` +
      `test -f ${shellQuote(path.posix.join(this.helperRoot, 'glob.py'))} && ` +
      // pdftotext / pdftoppm gate Read('foo.pdf') text and Read('foo.pdf', pages=...) visual respectively;
      // PIL / openpyxl / docx / pptx gate the office and image-resize paths.
      `command -v pdftotext >/dev/null 2>&1 && ` +
      `command -v pdftoppm >/dev/null 2>&1 && ` +
      `python3 -c "import trafilatura, markdownify, openpyxl, docx, pptx, PIL" 2>/dev/null`
    const probe = await this.runBrainctlExec({
      command: probeCmd,
      timeoutMs: 15_000,
    })
    if (probe.exitCode === 0) {
      this.helpersStagedFor = this.workerName
      return
    }

    const sourceDir = resolveDefaultHelperRoot()
    const filenames = ['webfetch.py', 'websearch.py', 'glob.py']
    for (const name of filenames) {
      const buf = readFileSync(path.join(sourceDir, name))
      await this.stageHelperFile(path.posix.join(this.helperRoot, name), buf)
    }

    // Apt deps: poppler-utils provides pdftotext + pdftoppm, used by the
    // Read tool's text and visual paths on PDFs. apt is best-effort: the kubebrain ml-base image
    // runs as root with a working corp mirror, but if either assumption fails
    // we surface the error clearly and let the PDF tools degrade with their
    // own "install poppler-utils" warnings.
    const apt = await this.runBrainctlExec({
      command:
        'command -v pdftotext >/dev/null 2>&1 && command -v pdftoppm >/dev/null 2>&1 || ' +
        'apt-get update -qq && apt-get install -y -qq --no-install-recommends poppler-utils',
      timeoutMs: 240_000,
      maxBufferBytes: 4 * 1024 * 1024,
    })
    if (apt.exitCode !== 0) {
      process.stderr.write(
        `[rlaunch] poppler-utils install failed (PDF tools will degrade): ${apt.stderr.trim() || apt.stdout.trim()}\n`,
      )
    }

    // Python deps. -i overrides the image's pre-configured internal mirror.
    // http_proxy is auto-injected by NetworkBridge when network.mode=host.
    // lxml_html_clean is required because justext (transitive of trafilatura)
    // imports `lxml.html.clean`, which was split out in lxml >=5. The kubebrain
    // ml-base image ships a recent lxml so the import fails without this dep.
    // Pillow / openpyxl / python-docx / python-pptx feed the resize gate +
    // office extractors; pin only minor floors to track upstream security
    // fixes without bumping major API breakage.
    const pip = await this.runBrainctlExec({
      command:
        'python3 -m pip install --quiet --no-warn-script-location ' +
        '--break-system-packages ' +
        '-i https://pypi.org/simple/ ' +
        'trafilatura==2.0.0 markdownify==1.2.2 lxml_html_clean==0.4.4 ' +
        '"Pillow>=10,<12" "openpyxl>=3.1,<4" "python-docx>=1.1,<2" "python-pptx>=1.0,<2"',
      timeoutMs: 240_000,
      maxBufferBytes: 4 * 1024 * 1024,
    })
    if (pip.exitCode !== 0) {
      throw new Error(
        `RlaunchRuntime helper staging: pip install failed: ` +
          `${pip.stderr.trim() || pip.stdout.trim()}`,
      )
    }

    this.helpersStagedFor = this.workerName
  }

  private async stageHelperFile(absPath: string, content: Buffer): Promise<void> {
    const expectedBytes = content.length
    // Same unified-stdin path as fs.writeFile, but routed through
    // runBrainctlExec directly: ensureRunning() → ensureHelpersStaged() →
    // stageHelpersOnce() → stageHelperFile(); going through this.exec() would
    // recurse via ensureRunning and deadlock on inflightStaging.
    const command =
      `mkdir -p "$(dirname ${shellQuote(absPath)})" && ` +
      `cat > ${shellQuote(absPath)} && ` +
      `chmod +x ${shellQuote(absPath)} && ` +
      `stat -c %s ${shellQuote(absPath)}`
    const result = await this.runBrainctlExec({
      command,
      stdin: content,
      timeoutMs: 30_000,
      maxBufferBytes: DEFAULT_MAX_BUFFER_BYTES,
    })
    if (result.exitCode !== 0) {
      throw new Error(
        `stageHelperFile ${absPath}: ${result.stderr.trim() || result.stdout.trim()}`,
      )
    }
    const actualBytes = Number(result.stdout.trim())
    if (!Number.isFinite(actualBytes) || actualBytes !== expectedBytes) {
      throw new Error(
        `stageHelperFile ${absPath}: byte mismatch (expected ${expectedBytes}, ` +
          `wrote ${result.stdout.trim() || 'unknown'})`,
      )
    }
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
    // We never pass `-i` to brainctl. The cluster's brainctl exec has two
    // related stdio bugs:
    //   (1) stdin payloads are silently dropped before the worker-side child
    //       reads them (~16% loss on writeFile, ~100% loss on small payloads
    //       like helper JSON). The child sees EOF on stdin and either errors
    //       (helper "invalid stdin json") or hangs.
    //   (2) brainctl exec -i with no real stdin (or a closed pipe) also
    //       suppresses the child's stdout, so even commands that don't read
    //       stdin lose their output.
    // Both are sidestepped by folding the stdin payload into the bash command
    // body (wrapCommand) and never opening brainctl's stdin pipe. stdout then
    // streams back reliably and stdin reaches the child via an in-shell pipe.
    const wrapped = this.wrapCommand(input)
    return runProcess('brainctl', [
      '-n', this.cfg.namespace,
      'exec', `process/${this.workerName}`,
      '--', 'bash', '-c', wrapped,
    ], {
      abortSignal: input.abortSignal,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBufferBytes: input.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
      limitMessage: 'rlaunch worker exec terminated',
    })
  }

  private wrapCommand(input: ExecInput): string {
    const cwd = input.cwd ? this.toContainerPath(input.cwd) : this.workspaceRoot
    return composeExecScript({
      command: input.command,
      env: input.env,
      cwd,
      stdin: input.stdin,
    })
  }

  private async spawnWorker(): Promise<string> {
    const args = this.launchArgs({ detach: true, predictOnly: false })
    const result = await runProcess('rlaunch', args, {
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
    return buildLaunchArgs(this.cfg, input)
  }

  private async processPhase(name: string): Promise<ProcessState> {
    const result = await runProcess('brainctl', [
      '-n',
      this.cfg.namespace,
      'get',
      'process',
      name,
      '--no-headers',
    ], {
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
    const result = await runProcess('brainctl', [
      '-n',
      this.cfg.namespace,
      'stop',
      `process/${name}`,
    ], {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxBufferBytes: DEFAULT_MAX_BUFFER_BYTES,
      limitMessage: 'brainctl stop process terminated',
    })
    if (result.exitCode !== 0 && !/current phase is Stopped|not found/i.test(`${result.stderr}\n${result.stdout}`)) {
      throw new Error(`brainctl stop process/${name} failed: ${result.stderr.trim() || result.stdout.trim()}`)
    }
  }

  private isWorkerLostError(result: ExecResult): boolean {
    if (result.exitCode === 0) return false
    const msg = `${result.stderr}\n${result.stdout}`.toLowerCase()
    return (
      msg.includes('not found') ||
      msg.includes('connection refused') ||
      msg.includes('unable to upgrade connection') ||
      msg.includes('unavailable process') ||
      msg.includes('cannot exec into a container')
    )
  }

  private isNotFoundOrForbidden(result: ExecResult): boolean {
    const msg = `${result.stderr}\n${result.stdout}`.toLowerCase()
    return msg.includes('notfound') ||
      msg.includes('not found') ||
      msg.includes('forbidden')
  }

  private toContainerPath(pathname: string): string {
    const normalizedContainerPath = path.posix.normalize(pathname)
    if (normalizedContainerPath === this.workspaceRoot ||
      normalizedContainerPath.startsWith(`${this.workspaceRoot}/`)) {
      return normalizedContainerPath
    }

    const resolved = path.resolve(pathname)
    for (const [hostPrefix, containerPrefix] of this.mountTable) {
      if (resolved === hostPrefix || resolved.startsWith(`${hostPrefix}${path.sep}`)) {
        return path.posix.join(containerPrefix, resolved.slice(hostPrefix.length))
      }
    }

    throw new Error(`Path is not within RlaunchRuntime workspace: ${pathname}`)
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
 * resolves cwd against the mount table and hands us an environment-side path.
 *
 * Output shape:
 *   <env exports> cd '<cwd>' && <body>
 * where <body> is either the raw command (no stdin) or a base64 inline pipe:
 *   { printf %s '<b64>' | base64 -d; } | { <command>; }
 *
 * The brace group around <command> is load-bearing: bash precedence makes `|`
 * bind tighter than `&&`, so `{b64} | mkdir && cat` would attach stdin to
 * mkdir only and leave `cat` reading EOF. Wrapping the user command in
 * `{ ...; }` makes the entire chain inherit the pipe.
 */
export function composeExecScript(input: {
  command: string
  env?: Record<string, string>
  cwd: string
  stdin?: string | Buffer
}): string {
  const envPart = input.env && Object.keys(input.env).length > 0
    ? `${Object.entries(input.env)
      .map(([key, value]) => `export ${key}=${shellQuote(value)};`)
      .join(' ')} `
    : ''
  if (input.stdin === undefined) {
    return `${envPart}cd ${shellQuote(input.cwd)} && ${input.command}`
  }
  const buffer = typeof input.stdin === 'string' ? Buffer.from(input.stdin) : input.stdin
  if (buffer.length > MAX_INLINE_STDIN_BYTES) {
    throw new Error(
      `RlaunchRuntime exec: stdin payload ${buffer.length} B exceeds inline limit ` +
        `(${MAX_INLINE_STDIN_BYTES} B). Stage via fs.writeFile + read from disk, ` +
        'or split the call into smaller chunks.',
    )
  }
  const b64 = buffer.toString('base64')
  return (
    `${envPart}cd ${shellQuote(input.cwd)} && ` +
    `{ printf %s ${shellQuote(b64)} | base64 -d; } | { ${input.command}; }`
  )
}

export function buildLaunchArgs(
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
    `--mount=${cfg.workspaceGpfsMount}`,
  ]
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

type ReadFileExec = (input: ExecInput) => Promise<ExecResult>

/**
 * Chunked fs.readFile for backends behind a frame-bounded exec channel
 * (brainctl ws). First hop runs `stat -c %s` to learn size; small files come
 * back via single-hop `base64 -w 0`, anything above READ_FILE_CHUNK_BYTES is
 * pulled chunk by chunk via `dd skip=K count=1 | base64 -w 0`. Sequential so
 * the byte order is preserved; final size is verified before returning.
 *
 * Exported for unit testing — production callers go through fs.readFile which
 * resolves the runtime path via toContainerPath first.
 */
export async function readFileViaExec(
  exec: ReadFileExec,
  containerPath: string,
  pathname: string,
): Promise<Buffer> {
  // Single-hop: stat to know expected size, then `base64 -w 0 path` to dump
  // the whole file. The trailing assertion catches any truncation / silent
  // brainctl stdout drop without falling back to a chunked retry (since
  // chunking is what introduced the byte-mismatch bug we replaced this for).
  const sizeRes = await exec({
    command: `stat -c %s ${shellQuote(containerPath)}`,
  })
  if (sizeRes.exitCode !== 0) {
    throw new Error(`readFile ${pathname}: ${sizeRes.stderr.trim() || sizeRes.stdout.trim()}`)
  }
  const totalBytes = Number(sizeRes.stdout.trim())
  if (!Number.isFinite(totalBytes) || totalBytes < 0) {
    throw new Error(`readFile ${pathname}: invalid stat size '${sizeRes.stdout.trim()}'`)
  }

  const result = await exec({
    command: `base64 -w 0 ${shellQuote(containerPath)}`,
    maxBufferBytes: READ_FILE_BUFFER_BYTES,
  })
  if (result.exitCode !== 0) {
    throw new Error(`readFile ${pathname}: ${result.stderr.trim() || result.stdout.trim()}`)
  }
  const buffer = Buffer.from(result.stdout.trim(), 'base64')
  if (buffer.length !== totalBytes) {
    throw new Error(
      `readFile ${pathname}: byte mismatch (expected ${totalBytes}, got ${buffer.length})`,
    )
  }
  return buffer
}

export const READ_FILE_BUFFER_BYTES_FOR_TESTS = READ_FILE_BUFFER_BYTES
