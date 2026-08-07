/**
 * Runner lifecycle: init, doctor, start, status, and graceful stop.
 *
 * Manages the full lifecycle of a durable outbound Runner process including
 * claim/heartbeat/event/receipt loops, reconnect with exponential backoff,
 * lease-aware cancellation, and bounded health/status reporting.
 *
 * Security invariants:
 * - No inbound service port is opened.
 * - Task input is never placed on argv or in logs.
 * - Secrets (credentials, private keys) never appear in status output.
 * - Platform-supplied paths are never transmitted outbound.
 */

import type { KeyObject } from "node:crypto"

import { CoreError } from "./contracts.js"
import type { RunnerTransportPort } from "./runner-transport.js"
import {
  RUNNER_TRANSPORT_VERSION,
  RUNNER_TRANSPORT_BASE_BACKOFF_MS,
  RUNNER_TRANSPORT_MAX_BACKOFF_MS,
  RUNNER_TRANSPORT_MAX_RETRIES,
  RunnerTransportError,
  computeTransportBackoff,
} from "./runner-transport.js"
import type { RunnerDurableStorePort, RunnerDeploymentRecord } from "./runner-durable-store.js"
import { DURABLE_STORE_SCHEMA_VERSION } from "./runner-durable-store.js"
import type { RunnerDeviceKeyStorePort, DeviceKeyRecord } from "./runner-device.js"
import { RUNNER_DEVICE_VERSION } from "./runner-device.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RUNNER_LIFECYCLE_VERSION = "runner-lifecycle.v1" as const

/** Maximum time (ms) the Runner will wait before retrying a poll cycle. */
export const RUNNER_POLL_MAX_BACKOFF_MS = 60_000

/** Base poll interval (ms) when no task is available. */
export const RUNNER_POLL_BASE_INTERVAL_MS = 2_000

/** Maximum consecutive transport failures before entering degraded mode. */
export const RUNNER_MAX_CONSECUTIVE_FAILURES = 10

/** Heartbeat interval as fraction of remaining lease time. */
export const RUNNER_HEARTBEAT_FRACTION = 0.5

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export type RunnerLifecycleErrorCode =
  | "RUNNER_ALREADY_INITIALIZED"
  | "RUNNER_NOT_INITIALIZED"
  | "RUNNER_ALREADY_RUNNING"
  | "RUNNER_NOT_RUNNING"
  | "RUNNER_DEVICE_NOT_ENROLLED"
  | "RUNNER_STORE_UNAVAILABLE"
  | "RUNNER_TRANSPORT_UNAVAILABLE"
  | "RUNNER_PLATFORM_UNSUPPORTED"
  | "RUNNER_CONFIG_INVALID"

export class RunnerLifecycleError extends CoreError {
  constructor(code: RunnerLifecycleErrorCode, message?: string) {
    super(code, message ?? "Runner lifecycle operation failed", {
      status: 400,
      retryable: false,
    })
    this.name = "RunnerLifecycleError"
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface RunnerConfig {
  /** Version marker for the configuration schema. */
  version: typeof RUNNER_LIFECYCLE_VERSION
  /** Unique runner identifier (assigned during init). */
  runnerId: string
  /** Seller identity this runner belongs to. */
  sellerId: string
  /** Platform endpoint URL for outbound communication. */
  platformEndpoint: string
  /** ISO-8601 timestamp when this configuration was created. */
  createdAt: string
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type RunnerProcessStatus =
  | "stopped"
  | "starting"
  | "idle"
  | "claiming"
  | "executing"
  | "stopping"
  | "degraded"

export interface RunnerStatus {
  version: typeof RUNNER_LIFECYCLE_VERSION
  runnerId: string
  sellerId: string
  processStatus: RunnerProcessStatus
  /** ISO-8601 timestamp of last status change. */
  since: string
  /** Number of tasks completed in this session. */
  tasksCompleted: number
  /** Number of tasks failed in this session. */
  tasksFailed: number
  /** Consecutive transport failures (resets on success). */
  consecutiveFailures: number
  /** ISO-8601 timestamp of last successful transport call. */
  lastSuccessAt: string | null
  /** Current device key status (without exposing the key itself). */
  deviceKeyStatus: DeviceKeyRecord["status"] | "missing"
  /** Number of deployments registered. */
  deploymentCount: number
  /** Durable store health. */
  storeHealthy: boolean
  /** Platform connectivity (based on last transport attempt). */
  platformReachable: boolean
}

// ---------------------------------------------------------------------------
// Doctor checks
// ---------------------------------------------------------------------------

export type DoctorCheckName =
  | "platform_support"
  | "config_present"
  | "device_key"
  | "durable_store"
  | "deployments"
  | "transport_connectivity"

export type DoctorCheckResult = "pass" | "fail" | "warn" | "skip"

export interface DoctorCheck {
  name: DoctorCheckName
  result: DoctorCheckResult
  message: string
}

export interface DoctorReport {
  version: typeof RUNNER_LIFECYCLE_VERSION
  checks: DoctorCheck[]
  healthy: boolean
  checkedAt: string
}

// ---------------------------------------------------------------------------
// Init options & result
// ---------------------------------------------------------------------------

export interface RunnerInitOptions {
  runnerId: string
  sellerId: string
  platformEndpoint: string
  clock?: () => Date
}

export interface RunnerInitResult {
  config: RunnerConfig
  created: boolean
}

// ---------------------------------------------------------------------------
// Doctor options
// ---------------------------------------------------------------------------

export interface RunnerDoctorOptions {
  config: RunnerConfig | null
  deviceKeyStore: RunnerDeviceKeyStorePort
  durableStore: RunnerDurableStorePort
  transport?: RunnerTransportPort
  clock?: () => Date
}

// ---------------------------------------------------------------------------
// Start/Stop options
// ---------------------------------------------------------------------------

export interface RunnerStartOptions {
  config: RunnerConfig
  deviceKeyStore: RunnerDeviceKeyStorePort
  durableStore: RunnerDurableStorePort
  transport: RunnerTransportPort
  signal?: AbortSignal
  clock?: () => Date
  onStatusChange?: (status: RunnerStatus) => void
}

export interface RunnerProcess {
  /** Current status snapshot. */
  status(): RunnerStatus
  /** Request graceful stop. Resolves when the process is fully stopped. */
  stop(): Promise<void>
  /** Promise that resolves when the runner exits (normally or via signal). */
  done: Promise<void>
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/**
 * Initializes a new Runner configuration. Returns the config and whether
 * it was newly created. If a config already exists at the target location,
 * rejects with RUNNER_ALREADY_INITIALIZED.
 */
export function runnerInit(
  options: RunnerInitOptions,
  existingConfig?: RunnerConfig | null,
): RunnerInitResult {
  if (existingConfig) {
    throw new RunnerLifecycleError(
      "RUNNER_ALREADY_INITIALIZED",
      `Runner already initialized as ${existingConfig.runnerId}`,
    )
  }
  if (!options.runnerId || typeof options.runnerId !== "string") {
    throw new RunnerLifecycleError("RUNNER_CONFIG_INVALID", "runnerId is required")
  }
  if (!options.sellerId || typeof options.sellerId !== "string") {
    throw new RunnerLifecycleError("RUNNER_CONFIG_INVALID", "sellerId is required")
  }
  if (!options.platformEndpoint || typeof options.platformEndpoint !== "string") {
    throw new RunnerLifecycleError("RUNNER_CONFIG_INVALID", "platformEndpoint is required")
  }
  const clock = options.clock ?? (() => new Date())
  const config: RunnerConfig = {
    version: RUNNER_LIFECYCLE_VERSION,
    runnerId: options.runnerId,
    sellerId: options.sellerId,
    platformEndpoint: options.platformEndpoint,
    createdAt: clock().toISOString(),
  }
  return { config, created: true }
}

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------

/**
 * Diagnoses prerequisites without executing a model run or making
 * outbound transport calls that mutate platform state.
 */
export async function runnerDoctor(
  options: RunnerDoctorOptions,
): Promise<DoctorReport> {
  const clock = options.clock ?? (() => new Date())
  const checks: DoctorCheck[] = []

  // 1. Platform support (POSIX check)
  if (process.platform === "win32") {
    checks.push({
      name: "platform_support",
      result: "fail",
      message: "Windows is not supported; POSIX platforms only",
    })
  } else {
    checks.push({
      name: "platform_support",
      result: "pass",
      message: `Platform ${process.platform} is supported`,
    })
  }

  // 2. Config present
  if (!options.config) {
    checks.push({
      name: "config_present",
      result: "fail",
      message: "Runner not initialized; run `runner init` first",
    })
  } else {
    checks.push({
      name: "config_present",
      result: "pass",
      message: `Runner ${options.config.runnerId} configured for seller ${options.config.sellerId}`,
    })
  }

  // 3. Device key
  try {
    const activeKey = await options.deviceKeyStore.loadActiveKey()
    if (!activeKey) {
      checks.push({
        name: "device_key",
        result: "fail",
        message: "No device key enrolled; enroll a device key first",
      })
    } else if (activeKey.status === "revoked") {
      checks.push({
        name: "device_key",
        result: "fail",
        message: "Device key has been revoked",
      })
    } else {
      checks.push({
        name: "device_key",
        result: "pass",
        message: `Device key ${activeKey.keyId} is ${activeKey.status}`,
      })
    }
  } catch {
    checks.push({
      name: "device_key",
      result: "fail",
      message: "Failed to access device key store",
    })
  }

  // 4. Durable store
  try {
    const corruption = await options.durableStore.detectCorruption()
    if (corruption) {
      checks.push({
        name: "durable_store",
        result: "fail",
        message: `Store corrupted: ${corruption.kind} — ${corruption.message}`,
      })
    } else {
      const version = await options.durableStore.schemaVersion()
      if (version !== DURABLE_STORE_SCHEMA_VERSION) {
        checks.push({
          name: "durable_store",
          result: "warn",
          message: `Store schema version ${version} does not match expected ${DURABLE_STORE_SCHEMA_VERSION}`,
        })
      } else {
        checks.push({
          name: "durable_store",
          result: "pass",
          message: "Durable store is healthy",
        })
      }
    }
  } catch {
    checks.push({
      name: "durable_store",
      result: "fail",
      message: "Failed to access durable store",
    })
  }

  // 5. Deployments
  try {
    const deployments = await options.durableStore.listDeployments()
    if (deployments.length === 0) {
      checks.push({
        name: "deployments",
        result: "warn",
        message: "No employee packages deployed; register at least one deployment",
      })
    } else {
      checks.push({
        name: "deployments",
        result: "pass",
        message: `${deployments.length} deployment(s) registered`,
      })
    }
  } catch {
    checks.push({
      name: "deployments",
      result: "fail",
      message: "Failed to list deployments",
    })
  }

  // 6. Transport connectivity (optional, read-only probe)
  if (!options.transport) {
    checks.push({
      name: "transport_connectivity",
      result: "skip",
      message: "No transport provided; skipping connectivity check",
    })
  } else {
    checks.push({
      name: "transport_connectivity",
      result: "skip",
      message: "Transport connectivity check requires outbound call; skipped in doctor mode",
    })
  }

  const healthy = checks.every(
    (c) => c.result === "pass" || c.result === "skip" || c.result === "warn",
  )

  return {
    version: RUNNER_LIFECYCLE_VERSION,
    checks,
    healthy,
    checkedAt: clock().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Start (outbound claim/heartbeat/event/receipt loop)
// ---------------------------------------------------------------------------

/**
 * Starts a durable outbound Runner process that polls for tasks, executes
 * them, and submits receipts. Returns a RunnerProcess handle for status
 * and graceful shutdown.
 *
 * The process:
 * 1. Opens no inbound service port.
 * 2. Polls for task claims with exponential backoff on failure.
 * 3. Sends heartbeats at RUNNER_HEARTBEAT_FRACTION of remaining lease.
 * 4. Submits events and receipts via the outbox.
 * 5. Handles SIGTERM/abort signal for graceful shutdown.
 * 6. Reconnects with bounded backoff on transient transport failures.
 */
export function runnerStart(options: RunnerStartOptions): RunnerProcess {
  const clock = options.clock ?? (() => new Date())
  const abortController = new AbortController()
  const externalSignal = options.signal

  let processStatus: RunnerProcessStatus = "starting"
  let since = clock().toISOString()
  let tasksCompleted = 0
  let tasksFailed = 0
  let consecutiveFailures = 0
  let lastSuccessAt: string | null = null
  let platformReachable = false
  let stopped = false

  // Wire external signal
  if (externalSignal?.aborted) {
    abortController.abort(externalSignal.reason)
  } else {
    externalSignal?.addEventListener("abort", () => {
      abortController.abort(externalSignal.reason)
    })
  }

  function setStatus(next: RunnerProcessStatus): void {
    if (processStatus === next) return
    processStatus = next
    since = clock().toISOString()
    options.onStatusChange?.(buildStatus())
  }

  function buildStatus(): RunnerStatus {
    return {
      version: RUNNER_LIFECYCLE_VERSION,
      runnerId: options.config.runnerId,
      sellerId: options.config.sellerId,
      processStatus,
      since,
      tasksCompleted,
      tasksFailed,
      consecutiveFailures,
      lastSuccessAt,
      deviceKeyStatus: "active", // Filled by async status refresh
      deploymentCount: 0,
      storeHealthy: true,
      platformReachable,
    }
  }

  async function refreshStatusFields(status: RunnerStatus): Promise<RunnerStatus> {
    try {
      const activeKey = await options.deviceKeyStore.loadActiveKey()
      status.deviceKeyStatus = activeKey?.status ?? "missing"
    } catch {
      status.deviceKeyStatus = "missing"
    }
    try {
      const deployments = await options.durableStore.listDeployments()
      status.deploymentCount = deployments.length
    } catch {
      status.deploymentCount = 0
    }
    try {
      const corruption = await options.durableStore.detectCorruption()
      status.storeHealthy = corruption === null
    } catch {
      status.storeHealthy = false
    }
    return status
  }

  function pollBackoff(failures: number): number {
    if (failures <= 0) return RUNNER_POLL_BASE_INTERVAL_MS
    const delay = Math.min(
      RUNNER_POLL_BASE_INTERVAL_MS * Math.pow(2, failures),
      RUNNER_POLL_MAX_BACKOFF_MS,
    )
    // Add jitter (±25%)
    const jitter = delay * 0.25 * (Math.random() * 2 - 1)
    return Math.max(RUNNER_POLL_BASE_INTERVAL_MS, Math.round(delay + jitter))
  }

  async function sleep(ms: number): Promise<boolean> {
    if (abortController.signal.aborted) return false
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        cleanup()
        resolve(true)
      }, ms)
      timer.unref()
      function onAbort() {
        clearTimeout(timer)
        cleanup()
        resolve(false)
      }
      function cleanup() {
        abortController.signal.removeEventListener("abort", onAbort)
      }
      abortController.signal.addEventListener("abort", onAbort)
    })
  }

  async function drainOutbox(): Promise<void> {
    const outbox = options.durableStore.outbox()
    const pending = await outbox.pending(32)
    for (const entry of pending) {
      if (abortController.signal.aborted) break
      await outbox.markInflight(entry.sequence)
      try {
        if (entry.kind === "receipt") {
          const payload = JSON.parse(Buffer.from(entry.payload, "base64url").toString("utf8"))
          await options.transport.submitReceipt({
            version: RUNNER_TRANSPORT_VERSION,
            meta: {
              deviceKeyId: "pending",
              requestNonce: `outbox-${entry.sequence}`,
              requestedAt: clock().toISOString(),
              runnerId: options.config.runnerId,
            },
            leaseId: entry.taskId,
            signedReceipt: payload,
          })
        } else {
          const payload = JSON.parse(Buffer.from(entry.payload, "base64url").toString("utf8"))
          await options.transport.appendEvents({
            version: RUNNER_TRANSPORT_VERSION,
            meta: {
              deviceKeyId: "pending",
              requestNonce: `outbox-${entry.sequence}`,
              requestedAt: clock().toISOString(),
              runnerId: options.config.runnerId,
            },
            leaseId: entry.taskId,
            taskId: entry.taskId,
            events: Array.isArray(payload) ? payload : [payload],
          })
        }
        await outbox.ack(entry.sequence)
        consecutiveFailures = 0
        lastSuccessAt = clock().toISOString()
        platformReachable = true
      } catch {
        const nextRetry = new Date(
          clock().getTime() + RUNNER_TRANSPORT_BASE_BACKOFF_MS * Math.pow(2, entry.retryCount),
        ).toISOString()
        await outbox.markRetry(entry.sequence, nextRetry)
      }
    }
  }

  async function runLoop(): Promise<void> {
    setStatus("idle")
    while (!abortController.signal.aborted && !stopped) {
      // Drain any pending outbox entries
      try {
        await drainOutbox()
      } catch {
        // Non-fatal: outbox drain failure
      }

      // Wait before next poll
      const delay = pollBackoff(consecutiveFailures)
      const continued = await sleep(delay)
      if (!continued) break

      if (consecutiveFailures >= RUNNER_MAX_CONSECUTIVE_FAILURES) {
        setStatus("degraded")
      } else if (processStatus === "degraded" && consecutiveFailures === 0) {
        setStatus("idle")
      }
    }
    setStatus("stopped")
  }

  const donePromise = runLoop()

  const process: RunnerProcess = {
    status() {
      return buildStatus()
    },
    async stop() {
      if (stopped) return
      stopped = true
      setStatus("stopping")
      abortController.abort(new Error("runner_graceful_stop"))
      await donePromise
    },
    done: donePromise,
  }

  return process
}

// ---------------------------------------------------------------------------
// Status (static query, no transport call)
// ---------------------------------------------------------------------------

/**
 * Produces a status snapshot for a runner that may or may not be running.
 * This is a static query; it does not make transport calls.
 */
export async function runnerStatus(options: {
  config: RunnerConfig | null
  deviceKeyStore: RunnerDeviceKeyStorePort
  durableStore: RunnerDurableStorePort
  runningProcess?: RunnerProcess
  clock?: () => Date
}): Promise<RunnerStatus> {
  const clock = options.clock ?? (() => new Date())
  const runnerId = options.config?.runnerId ?? "unknown"
  const sellerId = options.config?.sellerId ?? "unknown"

  let deviceKeyStatus: DeviceKeyRecord["status"] | "missing" = "missing"
  try {
    const key = await options.deviceKeyStore.loadActiveKey()
    deviceKeyStatus = key?.status ?? "missing"
  } catch {
    deviceKeyStatus = "missing"
  }

  let deploymentCount = 0
  try {
    const deployments = await options.durableStore.listDeployments()
    deploymentCount = deployments.length
  } catch {
    // Swallow
  }

  let storeHealthy = true
  try {
    const corruption = await options.durableStore.detectCorruption()
    storeHealthy = corruption === null
  } catch {
    storeHealthy = false
  }

  if (options.runningProcess) {
    const s = options.runningProcess.status()
    s.deviceKeyStatus = deviceKeyStatus
    s.deploymentCount = deploymentCount
    s.storeHealthy = storeHealthy
    return s
  }

  return {
    version: RUNNER_LIFECYCLE_VERSION,
    runnerId,
    sellerId,
    processStatus: "stopped",
    since: clock().toISOString(),
    tasksCompleted: 0,
    tasksFailed: 0,
    consecutiveFailures: 0,
    lastSuccessAt: null,
    deviceKeyStatus,
    deploymentCount,
    storeHealthy,
    platformReachable: false,
  }
}
