export type WorkerReadinessState =
  | 'not-attempted'
  | 'scheduling'
  | 'ready'
  | 'failed'
  | 'quota-denied'

export type WorkerReadinessSnapshot = {
  state: WorkerReadinessState
  scheduleStartedAtMs?: number
  scheduleDurationMs?: number
  lastError?: string
  image?: string
  canonicalUser: string
}

export class WorkerReadinessTracker {
  private _state: WorkerReadinessState = 'not-attempted'
  private scheduleStartedAtMs?: number
  private lastError?: string
  private image?: string

  constructor(public readonly canonicalUser: string) {}

  get state(): WorkerReadinessState {
    return this._state
  }

  startSchedule(image: string): void {
    this._state = 'scheduling'
    this.scheduleStartedAtMs = Date.now()
    this.image = image
    this.lastError = undefined
  }

  markReady(): void {
    this._state = 'ready'
    this.lastError = undefined
  }

  markFailed(error: string): void {
    this._state = 'failed'
    this.lastError = error
  }

  markQuotaDenied(error: string): void {
    this._state = 'quota-denied'
    this.lastError = error
  }

  snapshot(): WorkerReadinessSnapshot {
    return {
      state: this._state,
      scheduleStartedAtMs: this.scheduleStartedAtMs,
      scheduleDurationMs: this.scheduleStartedAtMs
        ? Date.now() - this.scheduleStartedAtMs
        : undefined,
      lastError: this.lastError,
      image: this.image,
      canonicalUser: this.canonicalUser,
    }
  }
}
