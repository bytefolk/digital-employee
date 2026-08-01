export const DEFAULT_STREAM_WATCHDOG_INTERVAL_MS = 30_000
export const DEFAULT_STREAM_STALE_AFTER_MS = 3 * 60_000
export const DEFAULT_STREAM_WAKE_DRIFT_MS = 60_000
export const DEFAULT_STREAM_CONNECT_TIMEOUT_MS = 20_000
export const DEFAULT_STREAM_RECONNECT_ATTEMPTS = 3
export const DEFAULT_STREAM_RECONNECT_BACKOFF_MS = 5_000

interface DingTalkConnectionErrorOptions extends ErrorOptions {
  code?: string
  attempts?: number | null
}

export interface DingTalkStreamClient {
  connect: () => unknown | Promise<unknown>
  disconnect?: () => unknown | Promise<unknown>
  connected?: boolean
  heartbeat?: (...args: unknown[]) => unknown
  onDownStream?: (...args: unknown[]) => unknown
}

type StreamLogger = Record<string, ((event: string, details?: unknown) => void) | undefined>

interface StreamSupervisorOptions {
  now?: () => number
  sleep?: (ms: number) => Promise<unknown>
  logger?: StreamLogger
  onError?: (error: unknown, context: { stage: string }) => void
  startTimer?: boolean
  watchdogIntervalMs?: number
  staleAfterMs?: number
  wakeDriftMs?: number
  connectTimeoutMs?: number
  reconnectAttempts?: number
  reconnectBackoffMs?: number
  setIntervalImpl?: typeof setInterval
  clearIntervalImpl?: typeof clearInterval
}

export interface DingTalkStreamSupervisor {
  start: () => Promise<void>
  stop: () => Promise<void>
  connect: () => Promise<void>
  forceReconnect: (trigger?: string) => Promise<boolean>
  watchdogTick: () => Promise<boolean>
  markAlive: () => void
  readonly state: "stopped" | "reconnecting" | "running" | "idle"
  readonly lastAliveAt: number
}

export class DingTalkConnectionError extends Error {
  code: string
  attempts: number | null

  constructor(message: string, options: DingTalkConnectionErrorOptions = {}) {
    super(message, options)
    this.name = "DingTalkConnectionError"
    this.code = options.code ?? "DINGTALK_CONNECTION_ERROR"
    this.attempts = options.attempts ?? null
  }
}

/**
 * Add lifecycle, activity tracking, timeout, and bounded reconnect behavior to
 * an injected dingtalk-stream client without importing SDK internals.
 */
export function createDingTalkStreamSupervisor(
  client: DingTalkStreamClient,
  options: StreamSupervisorOptions = {},
): DingTalkStreamSupervisor {
  if (!client || typeof client.connect !== "function") {
    throw new TypeError("client.connect must be a function")
  }

  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const logger = options.logger
  const onError = options.onError
  const startTimer = options.startTimer !== false
  const watchdogIntervalMs =
    options.watchdogIntervalMs ?? DEFAULT_STREAM_WATCHDOG_INTERVAL_MS
  const staleAfterMs =
    options.staleAfterMs ?? DEFAULT_STREAM_STALE_AFTER_MS
  const wakeDriftMs =
    options.wakeDriftMs ?? DEFAULT_STREAM_WAKE_DRIFT_MS
  const connectTimeoutMs =
    options.connectTimeoutMs ?? DEFAULT_STREAM_CONNECT_TIMEOUT_MS
  const reconnectAttempts =
    options.reconnectAttempts ?? DEFAULT_STREAM_RECONNECT_ATTEMPTS
  const reconnectBackoffMs =
    options.reconnectBackoffMs ?? DEFAULT_STREAM_RECONNECT_BACKOFF_MS
  const setIntervalImpl = options.setIntervalImpl ?? setInterval
  const clearIntervalImpl = options.clearIntervalImpl ?? clearInterval

  if (typeof now !== "function") throw new TypeError("now must be a function")
  if (typeof sleep !== "function") throw new TypeError("sleep must be a function")
  requirePositiveInteger(watchdogIntervalMs, "watchdogIntervalMs")
  requirePositiveInteger(staleAfterMs, "staleAfterMs")
  requireNonNegativeInteger(wakeDriftMs, "wakeDriftMs")
  requirePositiveInteger(connectTimeoutMs, "connectTimeoutMs")
  requirePositiveInteger(reconnectAttempts, "reconnectAttempts")
  requireNonNegativeInteger(reconnectBackoffMs, "reconnectBackoffMs")

  let stopped = false
  let started = false
  let timer: ReturnType<typeof setInterval> | null = null
  let reconnectPromise: Promise<boolean> | null = null
  let connectPromise: Promise<void> | null = null
  let generation = 0
  let lastAliveAt = now()
  let lastTickAt = lastAliveAt
  const restorers: Array<() => void> = []

  wrapActivityMethod("heartbeat")
  wrapActivityMethod("onDownStream")

  function markAlive(): void {
    if (!stopped) lastAliveAt = now()
  }

  async function connectOnce(): Promise<void> {
    if (stopped) {
      throw new DingTalkConnectionError("DingTalk Stream supervisor is stopped", {
        code: "DINGTALK_STREAM_STOPPED",
      })
    }
    if (connectPromise) return connectPromise

    const currentGeneration = generation
    connectPromise = (async () => {
      await withTimeout(
        Promise.resolve().then(() => client.connect()),
        connectTimeoutMs,
      )
      if (stopped || generation !== currentGeneration) {
        safeDisconnect(client)
        throw new DingTalkConnectionError(
          "DingTalk Stream connection was superseded",
          { code: "DINGTALK_CONNECT_SUPERSEDED" },
        )
      }
      if (typeof client.connected === "boolean" && !client.connected) {
        throw new DingTalkConnectionError(
          "DingTalk Stream client did not become connected",
          { code: "DINGTALK_CONNECT_UNCONFIRMED" },
        )
      }
      markAlive()
      lastTickAt = now()
    })()

    try {
      return await connectPromise
    } catch (error) {
      if (error instanceof DingTalkConnectionError) throw error
      const errorCode = safeErrorCode(error)
      throw new DingTalkConnectionError("DingTalk Stream connect failed", {
        code: errorCode === "DINGTALK_CONNECT_TIMEOUT"
          ? errorCode
          : "DINGTALK_CONNECT_FAILED",
        cause: error,
      })
    } finally {
      connectPromise = null
    }
  }

  async function start(): Promise<void> {
    if (started && !stopped) return
    if (stopped) {
      throw new DingTalkConnectionError(
        "A stopped DingTalk Stream supervisor cannot be restarted",
        { code: "DINGTALK_STREAM_STOPPED" },
      )
    }

    await connectOnce()
    started = true
    if (startTimer && timer === null) {
      timer = setIntervalImpl(() => {
        void watchdogTick().catch((error) => reportError(error, "watchdog"))
      }, watchdogIntervalMs)
      timer?.unref?.()
    }
    safeLog(logger, "info", "dingtalk.stream.connected")
  }

  async function forceReconnect(trigger = "manual"): Promise<boolean> {
    if (stopped) return false
    if (reconnectPromise) return reconnectPromise

    reconnectPromise = (async () => {
      generation++
      safeDisconnect(client)
      safeLog(logger, "warn", "dingtalk.stream.reconnecting", { trigger })

      let lastError: unknown = null
      for (let attempt = 1; attempt <= reconnectAttempts; attempt++) {
        if (stopped) return false
        try {
          await connectOnce()
          safeLog(logger, "info", "dingtalk.stream.reconnected", { attempt })
          return true
        } catch (error) {
          lastError = error
          safeLog(logger, "warn", "dingtalk.stream.reconnect_failed", {
            attempt,
            errorCode: safeErrorCode(error),
          })
          safeDisconnect(client)
          if (attempt < reconnectAttempts && reconnectBackoffMs > 0) {
            await sleep(reconnectBackoffMs)
          }
        }
      }

      throw new DingTalkConnectionError(
        "DingTalk Stream reconnect attempts were exhausted",
        {
          code: "DINGTALK_RECONNECT_EXHAUSTED",
          attempts: reconnectAttempts,
          cause: lastError,
        },
      )
    })()

    try {
      return await reconnectPromise
    } finally {
      reconnectPromise = null
    }
  }

  async function watchdogTick(): Promise<boolean> {
    if (stopped || reconnectPromise) return false
    const timestamp = now()
    const drift = timestamp - lastTickAt - watchdogIntervalMs
    const staleFor = timestamp - lastAliveAt
    lastTickAt = timestamp

    if (typeof client.connected === "boolean" && !client.connected) {
      return forceReconnect("disconnected")
    }
    if (drift > wakeDriftMs) {
      return forceReconnect("wake-drift")
    }
    if (staleFor > staleAfterMs) {
      return forceReconnect("activity-timeout")
    }
    return false
  }

  async function stop(): Promise<void> {
    if (stopped) return
    stopped = true
    generation++
    if (timer !== null) {
      clearIntervalImpl(timer)
      timer = null
    }
    for (const restore of restorers.splice(0)) restore()
    safeDisconnect(client)
    safeLog(logger, "info", "dingtalk.stream.stopped")
  }

  function wrapActivityMethod(name: "heartbeat" | "onDownStream"): void {
    if (typeof client[name] !== "function") return
    const original = client[name] as (...args: unknown[]) => unknown
    const wrapped = function wrappedActivityMethod(
      this: unknown,
      ...args: unknown[]
    ): unknown {
      markAlive()
      return Reflect.apply(original, this, args)
    }
    client[name] = wrapped
    restorers.push(() => {
      if (client[name] === wrapped) client[name] = original
    })
  }

  function reportError(error: unknown, stage: string): void {
    safeLog(logger, "error", "dingtalk.stream.error", {
      stage,
      errorCode: safeErrorCode(error),
    })
    try {
      onError?.(error, { stage })
    } catch {}
  }

  return {
    start,
    stop,
    connect: connectOnce,
    forceReconnect,
    watchdogTick,
    markAlive,
    get state() {
      if (stopped) return "stopped"
      if (reconnectPromise) return "reconnecting"
      if (started) return "running"
      return "idle"
    },
    get lastAliveAt() {
      return lastAliveAt
    },
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new DingTalkConnectionError(
        `DingTalk Stream connect timed out after ${timeoutMs}ms`,
        { code: "DINGTALK_CONNECT_TIMEOUT" },
      ))
    }, timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function safeDisconnect(client: DingTalkStreamClient): unknown {
  try {
    const result = client.disconnect?.()
    if (
      result &&
      (typeof result === "object" || typeof result === "function") &&
      "catch" in result &&
      typeof result.catch === "function"
    ) {
      result.catch(() => undefined)
    }
    return result
  } catch {
    return undefined
  }
}

function safeErrorCode(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.length > 0
  ) {
    return error.code
  }
  return "DINGTALK_UNKNOWN_ERROR"
}

function safeLog(
  logger: StreamLogger | undefined,
  level: string,
  event: string,
  details?: unknown,
): void {
  try {
    logger?.[level]?.(event, details)
  } catch {}
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`)
  }
}

function requireNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`)
  }
}
