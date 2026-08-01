import { CoreError, ValidationError } from "./contracts.js"

const DEFAULTS = {
  maxConcurrent: 2,
  maxQueueSize: 50,
  queueTimeoutMs: 30_000,
  cooldownMs: 0,
  dedupeWindowMs: 5 * 60_000,
  maxSeenJobs: 1_000,
  maxTrackedActors: 1_000,
}

function positiveInteger(
  value: unknown,
  name: string,
  { allowZero = false }: { allowZero?: boolean } = {},
): number {
  const minimum = allowZero ? 0 : 1
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    throw new ValidationError(
      `${name} must be an integer greater than or equal to ${minimum}`,
    )
  }
  return value
}

interface JobIdentity { actorId: string; jobId?: string }
interface JobRunnerOptions {
  maxConcurrent?: number
  maxQueueSize?: number
  queueTimeoutMs?: number
  cooldownMs?: number
  dedupeWindowMs?: number
  maxSeenJobs?: number
  maxTrackedActors?: number
  clock?: () => number
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (timer: unknown) => void
}
interface QueueEntry {
  identity: JobIdentity
  task: () => unknown | Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
  timer: unknown | null
}

export class JobRunner {
  #maxConcurrent
  #maxQueueSize
  #queueTimeoutMs
  #cooldownMs
  #dedupeWindowMs
  #maxSeenJobs
  #maxTrackedActors
  #clock
  #setTimer
  #clearTimer
  #running = 0
  #runningActors = new Set<string>()
  #queuedActors = new Set<string>()
  #queue: QueueEntry[] = []
  #seenJobs = new Map<string, number>()
  #lastStartedByActor = new Map<string, number>()
  #closed = false

  constructor(options: JobRunnerOptions = {}) {
    this.#maxConcurrent = positiveInteger(
      options.maxConcurrent ?? DEFAULTS.maxConcurrent,
      "maxConcurrent",
    )
    this.#maxQueueSize = positiveInteger(
      options.maxQueueSize ?? DEFAULTS.maxQueueSize,
      "maxQueueSize",
      { allowZero: true },
    )
    this.#queueTimeoutMs = positiveInteger(
      options.queueTimeoutMs ?? DEFAULTS.queueTimeoutMs,
      "queueTimeoutMs",
    )
    this.#cooldownMs = positiveInteger(
      options.cooldownMs ?? DEFAULTS.cooldownMs,
      "cooldownMs",
      { allowZero: true },
    )
    this.#dedupeWindowMs = positiveInteger(
      options.dedupeWindowMs ?? DEFAULTS.dedupeWindowMs,
      "dedupeWindowMs",
      { allowZero: true },
    )
    this.#maxSeenJobs = positiveInteger(
      options.maxSeenJobs ?? DEFAULTS.maxSeenJobs,
      "maxSeenJobs",
    )
    this.#maxTrackedActors = positiveInteger(
      options.maxTrackedActors ?? DEFAULTS.maxTrackedActors,
      "maxTrackedActors",
    )
    this.#clock = options.clock ?? (() => Date.now())
    this.#setTimer = options.setTimer ?? ((callback, delayMs) =>
      setTimeout(callback, delayMs))
    this.#clearTimer = options.clearTimer ?? ((timer) =>
      clearTimeout(timer as ReturnType<typeof setTimeout>))
  }

  run<T>(identity: unknown, task: () => T | Promise<T>): Promise<T> {
    if (this.#closed) {
      return Promise.reject(
        new CoreError("RUNNER_CLOSED", "The job runner is closed.", {
          status: 503,
        }),
      )
    }
    if (typeof task !== "function") {
      return Promise.reject(
        new ValidationError("task must be a function", { field: "task" }),
      )
    }

    let normalized
    try {
      normalized = this.#validateIdentity(identity)
      this.#prune()
      this.#assertAccepted(normalized)
    } catch (error) {
      return Promise.reject(error)
    }

    if (this.#running < this.#maxConcurrent) {
      this.#recordJob(normalized.jobId)
      return this.#start(normalized, task)
    }
    if (this.#queue.length >= this.#maxQueueSize) {
      return Promise.reject(
        new CoreError("QUEUE_FULL", "The request queue is full.", {
          status: 503,
          retryable: true,
          details: { maxQueueSize: this.#maxQueueSize },
        }),
      )
    }
    this.#recordJob(normalized.jobId)
    return this.#enqueue(normalized, task) as Promise<T>
  }

  snapshot() {
    return {
      running: this.#running,
      queued: this.#queue.length,
      maxConcurrent: this.#maxConcurrent,
      maxQueueSize: this.#maxQueueSize,
      closed: this.#closed,
    }
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    for (const entry of this.#queue.splice(0)) {
      if (entry.timer) this.#clearTimer(entry.timer)
      this.#queuedActors.delete(entry.identity.actorId)
      entry.reject(
        new CoreError("RUNNER_CLOSED", "The job runner is closed.", {
          status: 503,
          retryable: false,
        }),
      )
    }
  }

  #validateIdentity(identity: unknown): JobIdentity {
    if (
      identity === null ||
      typeof identity !== "object" ||
      Array.isArray(identity)
    ) {
      throw new ValidationError("job identity must be an object")
    }
    const candidate = identity as Record<string, unknown>
    const actorId =
      typeof candidate.actorId === "string" && candidate.actorId.trim()
        ? candidate.actorId.trim()
        : "anonymous"
    const jobId =
      typeof candidate.jobId === "string" && candidate.jobId.trim()
        ? candidate.jobId.trim()
        : undefined
    return { actorId, jobId }
  }

  #assertAccepted({ actorId, jobId }: JobIdentity): void {
    const now = this.#clock()
    if (
      jobId &&
      this.#dedupeWindowMs > 0 &&
      this.#seenJobs.has(jobId) &&
      now - (this.#seenJobs.get(jobId) ?? now) < this.#dedupeWindowMs
    ) {
      throw new CoreError("DUPLICATE_REQUEST", "Duplicate request ignored.", {
        status: 409,
        retryable: false,
      })
    }
    if (
      this.#runningActors.has(actorId) ||
      this.#queuedActors.has(actorId)
    ) {
      throw new CoreError(
        "ACTOR_BUSY",
        "This actor already has a request in progress.",
        { status: 409, retryable: true },
      )
    }
    const lastStarted = this.#lastStartedByActor.get(actorId)
    if (
      this.#cooldownMs > 0 &&
      lastStarted !== undefined &&
      now - lastStarted < this.#cooldownMs
    ) {
      const retryAfterMs = this.#cooldownMs - (now - lastStarted)
      throw new CoreError(
        "RATE_LIMITED",
        "The actor is in a cooldown period.",
        {
          status: 429,
          retryable: true,
          details: { retryAfterMs },
        },
      )
    }
  }

  #enqueue(identity: JobIdentity, task: () => unknown | Promise<unknown>) {
    return new Promise<unknown>((resolve, reject) => {
      const entry: QueueEntry = { identity, task, resolve, reject, timer: null }
      entry.timer = this.#setTimer(() => {
        const index = this.#queue.indexOf(entry)
        if (index < 0) return
        this.#queue.splice(index, 1)
        this.#queuedActors.delete(identity.actorId)
        reject(
          new CoreError("QUEUE_TIMEOUT", "The queued request timed out.", {
            status: 503,
            retryable: true,
            details: { timeoutMs: this.#queueTimeoutMs },
          }),
        )
      }, this.#queueTimeoutMs)
      this.#queuedActors.add(identity.actorId)
      this.#queue.push(entry)
    })
  }

  async #start<T>(identity: JobIdentity, task: () => T | Promise<T>): Promise<T> {
    this.#running += 1
    this.#runningActors.add(identity.actorId)
    if (this.#cooldownMs > 0) {
      this.#setBounded(
        this.#lastStartedByActor,
        identity.actorId,
        this.#clock(),
        this.#maxTrackedActors,
      )
    }
    try {
      return await task()
    } finally {
      this.#running -= 1
      this.#runningActors.delete(identity.actorId)
      this.#drain()
    }
  }

  #drain() {
    while (
      !this.#closed &&
      this.#running < this.#maxConcurrent &&
      this.#queue.length > 0
    ) {
      const entry = this.#queue.shift()
      if (!entry) continue
      if (entry.timer) this.#clearTimer(entry.timer)
      this.#queuedActors.delete(entry.identity.actorId)
      this.#start(entry.identity, entry.task).then(
        entry.resolve,
        entry.reject,
      )
    }
  }

  #prune() {
    const now = this.#clock()
    for (const [jobId, seenAt] of this.#seenJobs) {
      if (now - seenAt >= this.#dedupeWindowMs) {
        this.#seenJobs.delete(jobId)
      }
    }
    for (const [actorId, startedAt] of this.#lastStartedByActor) {
      if (now - startedAt >= this.#cooldownMs) {
        this.#lastStartedByActor.delete(actorId)
      }
    }
  }

  #recordJob(jobId?: string): void {
    if (jobId && this.#dedupeWindowMs > 0) {
      this.#setBounded(
        this.#seenJobs,
        jobId,
        this.#clock(),
        this.#maxSeenJobs,
      )
    }
  }

  #setBounded(
    map: Map<string, number>,
    key: string,
    value: number,
    maximum: number,
  ): void {
    map.delete(key)
    map.set(key, value)
    while (map.size > maximum) {
      const oldest = map.keys().next().value
      if (oldest !== undefined) map.delete(oldest)
    }
  }
}
