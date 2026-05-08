import { spawn } from 'node:child_process'

export type ImageReadinessState = 'not-attempted' | 'pulling' | 'ready' | 'failed'

export type ImageReadinessSnapshot = {
  state: ImageReadinessState
  image?: string
  lastError?: string
  pullStartedAt?: number
  pullDurationMs?: number
}

const IMAGE_MISSING_PATTERNS = [
  /unable to find image/i,
  /pull access denied/i,
  /no such image/i,
  /image not known/i,
  /image .* not found/i,
  /manifest unknown/i,
  /repository .* not found/i,
]

// Transient network blips during the GHCR auth probe / blob fetch that a
// single retry typically clears. The 2026-05-08 incident: dockerd caches
// auth tokens per image:tag, so the first pull of a fresh tag does an
// extra `GET /v2/` probe; if that hits a network blip we get
// `Get "https://ghcr.io/v2/": EOF` while the same image:tag pulls clean
// 1.4s later. Permanent failures (manifest unknown, unauthorized,
// proxy misconfig) are excluded so we don't burn time retrying them.
const TRANSIENT_PULL_PATTERNS = [
  /:\s*EOF\s*$/i,
  /TLS handshake timeout/i,
  /i\/o timeout/i,
  /connection reset by peer/i,
  /temporarily unavailable/i,
]

export function isImageMissingError(message: string): boolean {
  return IMAGE_MISSING_PATTERNS.some(pattern => pattern.test(message))
}

export function isTransientPullError(message: string): boolean {
  if (isImageMissingError(message)) return false
  if (/unauthorized|denied|requires authentication/i.test(message)) return false
  return TRANSIENT_PULL_PATTERNS.some(pattern => pattern.test(message))
}

export function formatPullError(message: string): string {
  const trimmed = message.trim()
  if (/manifest unknown|not found|repository .* not found|image .* not found/i.test(trimmed)) {
    return [
      '镜像不存在。如果你刚升级 LightClaw，可能 GHCR 上还没有对应版本；',
      '可在 config 里设 runtime.docker.imageOverride: "ghcr.io/rowitzou/lightclaw-sandbox:latest"',
      '或本地 docker build -t lightclaw-sandbox:dev <repo> 后将其作为 imageOverride。',
      '如果是本地 build，确认 docker image ls 能看到对应 tag。',
      `原始错误：${trimmed}`,
    ].join('\n')
  }
  if (/unauthorized|denied|requires authentication/i.test(trimmed)) {
    return [
      'GHCR package 当前为 private 或凭证错误。fork 部署请先 docker login ghcr.io，',
      '或把 image visibility 设为 public（GitHub repo → Packages → Package settings）。',
      `原始错误：${trimmed}`,
    ].join('\n')
  }
  if (/proxyconnect tcp|connection refused|i\/o timeout|EOF/i.test(trimmed)) {
    return [
      'Docker daemon 拉镜像走代理失败。确认 /etc/systemd/system/docker.service.d/http-proxy.conf',
      '配置正确，并 systemctl daemon-reload && systemctl restart docker。',
      `原始错误：${trimmed}`,
    ].join('\n')
  }
  if (/dial tcp.*lookup|no such host/i.test(trimmed)) {
    return [
      'DNS 解析失败，docker daemon 可能没接到代理。docker info 应能看到 HTTP Proxy 配置。',
      `原始错误：${trimmed}`,
    ].join('\n')
  }
  return trimmed
}

async function dockerImageInspect(image: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['image', 'inspect', image], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: process.env,
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) {
        resolve(true)
        return
      }
      // exit !=0 with "No such image" / "Error: No such object" → image absent (not an error)
      if (/no such (image|object)/i.test(stderr)) {
        resolve(false)
        return
      }
      // Distinguish "absent" from "daemon down" — daemon down is a hard failure
      if (/cannot connect to the docker daemon|is the docker daemon running/i.test(stderr)) {
        reject(new Error(`docker daemon unreachable: ${stderr.trim()}`))
        return
      }
      // Default: treat any non-zero exit as "not present" so we attempt pull;
      // pull will surface the real error if the daemon is healthy.
      resolve(false)
    })
  })
}

async function dockerPullStreaming(image: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['pull', image], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`docker pull ${image} exited with code ${code ?? 'unknown'}`))
      }
    })
  })
}

export class ImageReadinessTracker {
  private _state: ImageReadinessState = 'not-attempted'
  private _image?: string
  private _lastError?: string
  private _pullStartedAt?: number
  private _pullCompletedAt?: number
  private _pullPromise?: Promise<void>
  // Dedup admin push: key = `${channelId}::${image}::${state}`
  private notifiedAdmins = new Set<string>()
  // Listeners (stderr banner + admin push). Triggered when state changes.
  private listeners = new Set<(snapshot: ImageReadinessSnapshot) => void>()

  get state(): ImageReadinessState {
    return this._state
  }

  get image(): string | undefined {
    return this._image
  }

  snapshot(): ImageReadinessSnapshot {
    const now = Date.now()
    return {
      state: this._state,
      ...(this._image ? { image: this._image } : {}),
      ...(this._lastError ? { lastError: this._lastError } : {}),
      ...(this._pullStartedAt ? { pullStartedAt: this._pullStartedAt } : {}),
      ...(this._pullStartedAt
        ? {
            pullDurationMs: this._pullCompletedAt
              ? this._pullCompletedAt - this._pullStartedAt
              : now - this._pullStartedAt,
          }
        : {}),
    }
  }

  onChange(listener: (snapshot: ImageReadinessSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Fire-and-forget. Idempotent: re-calling with the same image while pulling
   * or already ready is a no-op. If image changes, reset and re-pull.
   *
   * `inspectOnly: true` (autoPull=false) skips the docker pull step; if the
   * image isn't present locally the tracker lands in 'failed' with a marker
   * lastError so isAvailable() can render the autoPull-disabled UX.
   */
  startPrefetch(image: string, options: { inspectOnly?: boolean } = {}): void {
    if (this._image && this._image !== image) {
      this.reset()
    }
    this._image = image
    if (this._state === 'pulling' || this._state === 'ready') {
      return
    }
    this._pullPromise = this.runPrefetch(image, options.inspectOnly ?? false).catch(() => {
      /* runPrefetch records state itself; swallow rejection from outer promise */
    })
  }

  /**
   * Quick-check (timeoutMs=0) or short wait. Returns true iff state is 'ready'.
   * Does not trigger a pull on its own — call startPrefetch first.
   */
  async waitReady(timeoutMs = 0): Promise<boolean> {
    if (this._state === 'ready') return true
    if (this._state === 'failed' || this._state === 'not-attempted') return false
    if (timeoutMs <= 0) return false
    const promise = this._pullPromise
    if (!promise) return false
    return Promise.race([
      promise.then(() => this._state === 'ready'),
      new Promise<boolean>(r => setTimeout(() => r(this._state === 'ready'), timeoutMs)),
    ])
  }

  /**
   * Called from query.ts/channels when user message arrives. If state is
   * 'failed' or 'not-attempted', clears state and starts a fresh prefetch.
   * Pulling/ready states are left alone.
   */
  retryIfFailed(): void {
    if (this._state !== 'failed' && this._state !== 'not-attempted') return
    if (!this._image) return
    const image = this._image
    this._state = 'not-attempted'
    this._lastError = undefined
    this._pullStartedAt = undefined
    this._pullCompletedAt = undefined
    this._pullPromise = undefined
    this.startPrefetch(image)
  }

  /**
   * Called from DockerRuntime.createContainer when an image-missing error
   * surfaces despite the tracker thinking we're ready. Forces tracker back to
   * 'failed' so the next inbound message triggers retry.
   */
  markFailed(error: string): void {
    if (this._state === 'failed' && this._lastError === error) return
    this._state = 'failed'
    this._lastError = error
    this._pullCompletedAt = Date.now()
    this.notifiedAdmins.clear()
    this.emit()
  }

  /**
   * Returns true the first time admin should be notified for this
   * (channelId, image, state) tuple; false on subsequent calls (dedup).
   */
  markAdminNotified(channelId: string): boolean {
    if (!this._image) return false
    const key = `${channelId}::${this._image}::${this._state}`
    if (this.notifiedAdmins.has(key)) return false
    this.notifiedAdmins.add(key)
    return true
  }

  private reset(): void {
    this._state = 'not-attempted'
    this._image = undefined
    this._lastError = undefined
    this._pullStartedAt = undefined
    this._pullCompletedAt = undefined
    this._pullPromise = undefined
    this.notifiedAdmins.clear()
  }

  private emit(): void {
    const snap = this.snapshot()
    for (const listener of this.listeners) {
      try {
        listener(snap)
      } catch {
        /* listener errors must never derail the tracker */
      }
    }
  }

  private async runPrefetch(image: string, inspectOnly: boolean): Promise<void> {
    this._state = 'pulling'
    this._pullStartedAt = Date.now()
    this._pullCompletedAt = undefined
    this._lastError = undefined
    this.notifiedAdmins.clear()
    this.emit()

    try {
      const exists = await dockerImageInspect(image)
      if (exists) {
        this._state = 'ready'
        this._pullCompletedAt = Date.now()
        this.emit()
        return
      }
    } catch (err) {
      this._state = 'failed'
      this._lastError = formatPullError((err as Error).message)
      this._pullCompletedAt = Date.now()
      this.emit()
      return
    }

    if (inspectOnly) {
      // autoPull=false: don't attempt a pull. Mark failed with a sentinel
      // string DockerRuntime.isAvailable() can detect.
      this._state = 'failed'
      this._lastError = `AUTOPULL_DISABLED: image ${image} not present locally`
      this._pullCompletedAt = Date.now()
      this.emit()
      return
    }

    process.stderr.write(`🐳 sandbox: pulling ${image} ...\n`)

    let lastError: Error | undefined
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await dockerPullStreaming(image)
        this._state = 'ready'
        this._pullCompletedAt = Date.now()
        const tookSec = Math.round(
          (this._pullCompletedAt - (this._pullStartedAt ?? this._pullCompletedAt)) / 1000,
        )
        process.stderr.write(`✓ Sandbox image ready (${tookSec}s)\n`)
        this.emit()
        return
      } catch (err) {
        lastError = err as Error
        // One retry for transient auth-probe / blob-fetch blips. Skip retry
        // on permanent classes (manifest missing, auth, network misconfig).
        if (attempt === 0 && isTransientPullError(lastError.message)) {
          process.stderr.write(
            `⚠ Sandbox image pull transient error, retrying once: ${lastError.message.trim()}\n`,
          )
          await delay(2000)
          continue
        }
        break
      }
    }

    this._state = 'failed'
    this._lastError = formatPullError((lastError ?? new Error('unknown pull error')).message)
    this._pullCompletedAt = Date.now()
    process.stderr.write(`✗ Sandbox image pull failed: ${this._lastError}\n`)
    this.emit()
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
