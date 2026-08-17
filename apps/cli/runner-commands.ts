/**
 * Runner CLI commands: init, doctor, status, start, deploy.
 *
 * The runner is an outbound-only worker process. It polls the platform for
 * tasks, executes them against locally deployed employee packages, and
 * submits signed receipts. Task input never appears on argv or in logs.
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto"
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import { CoreError } from "../../packages/core/src/contracts.js"
import { deriveDeviceKeyId } from "../../packages/core/src/runner-device.js"
import { FileDeviceKeyStore } from "../../packages/core/src/runner-file-device-key-store.js"
import { HttpRunnerTransport } from "../../packages/core/src/runner-http-transport.js"
import {
  runnerDoctor,
  runnerInit,
  runnerStart,
  runnerStatus,
} from "../../packages/core/src/runner-lifecycle.js"
import type {
  DoctorReport,
  RunnerConfig,
  RunnerLocalPackageRequest,
  RunnerProcess,
  RunnerStatus,
} from "../../packages/core/src/runner-lifecycle.js"
import { SqliteDurableStore } from "../../packages/core/src/runner-sqlite-store.js"
import type { RunnerLockHolder } from "../../packages/core/src/runner-sqlite-store.js"
import type { RunnerDeploymentRecord } from "../../packages/core/src/runner-durable-store.js"
import { createBuiltInAgentHostRegistry } from "./agent-host-registry.js"
import {
  computeEmployeePackageDirectoryDigest,
  inspectEmployeePackage,
} from "./employee-package.js"
import { executeOneShotRunnerTask } from "./runner-executor.js"

export const RUNNER_HOME_ENV = "DIGITAL_EMPLOYEE_RUNNER_HOME"

export interface RunnerHomeLayout {
  home: string
  configFile: string
  stateFile: string
  keysDir: string
  packagesDir: string
  receiptKeyFile: string
}

export function defaultRunnerHome(): string {
  return (
    process.env[RUNNER_HOME_ENV] ??
    path.join(homedir(), ".digital-employee", "runner")
  )
}

export function runnerHomeLayout(home: string): RunnerHomeLayout {
  return {
    home,
    configFile: path.join(home, "runner.json"),
    stateFile: path.join(home, "state.db"),
    keysDir: path.join(home, "keys"),
    packagesDir: path.join(home, "packages"),
    receiptKeyFile: path.join(home, "receipt-key.pem"),
  }
}

function ensureHome(layout: RunnerHomeLayout): void {
  mkdirSync(layout.home, { recursive: true, mode: 0o700 })
}

export function readRunnerConfig(home: string): RunnerConfig {
  const layout = runnerHomeLayout(home)
  if (!existsSync(layout.configFile)) {
    throw new CoreError(
      "RUNNER_NOT_INITIALIZED",
      "Runner not initialized; run `digital-employee runner init`",
      { retryable: false },
    )
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(layout.configFile, "utf8")) as unknown
  } catch {
    throw new CoreError(
      "RUNNER_CONFIG_INVALID",
      "Runner config is not valid JSON",
      { retryable: false },
    )
  }
  const config = raw as Partial<RunnerConfig>
  if (
    !config ||
    typeof config !== "object" ||
    config.version !== "runner-lifecycle.v1" ||
    typeof config.runnerId !== "string" ||
    typeof config.sellerId !== "string" ||
    typeof config.platformEndpoint !== "string" ||
    typeof config.createdAt !== "string"
  ) {
    throw new CoreError(
      "RUNNER_CONFIG_INVALID",
      "Runner config is malformed; re-run `digital-employee runner init`",
      { retryable: false },
    )
  }
  return config as RunnerConfig
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

export interface RunnerCommandInitOptions {
  home: string
  runnerId: string
  sellerId: string
  platformEndpoint: string
  clock?: () => Date
}

export function runnerCommandInit(options: RunnerCommandInitOptions): {
  config: RunnerConfig
  created: boolean
} {
  const layout = runnerHomeLayout(options.home)
  ensureHome(layout)
  const existing = existsSync(layout.configFile)
    ? readRunnerConfig(options.home)
    : null
  const result = runnerInit(
    {
      runnerId: options.runnerId,
      sellerId: options.sellerId,
      platformEndpoint: options.platformEndpoint,
      clock: options.clock,
    },
    existing,
  )
  if (!existsSync(layout.receiptKeyFile)) {
    const { privateKey } = generateKeyPairSync("ed25519")
    writeFileSync(
      layout.receiptKeyFile,
      privateKey.export({ type: "pkcs8", format: "pem" }),
      { mode: 0o600 },
    )
  }
  writeFileSync(
    layout.configFile,
    `${JSON.stringify(result.config, null, 2)}\n`,
    { mode: 0o600 },
  )
  return result
}

// ---------------------------------------------------------------------------
// doctor / status
// ---------------------------------------------------------------------------

export async function runnerCommandDoctor(
  home: string,
  clock?: () => Date,
): Promise<DoctorReport> {
  const layout = runnerHomeLayout(home)
  const config = existsSync(layout.configFile) ? readRunnerConfig(home) : null
  const store = new SqliteDurableStore(layout.stateFile)
  try {
    return await runnerDoctor({
      config,
      deviceKeyStore: new FileDeviceKeyStore(layout.keysDir),
      durableStore: store,
      ...(config ? { transport: new HttpRunnerTransport({ endpoint: config.platformEndpoint }) } : {}),
      clock,
    })
  } finally {
    store.close()
  }
}

export async function runnerCommandStatus(
  home: string,
  runningProcess?: RunnerProcess,
  clock?: () => Date,
): Promise<RunnerStatus> {
  const layout = runnerHomeLayout(home)
  const config = existsSync(layout.configFile) ? readRunnerConfig(home) : null
  const store = new SqliteDurableStore(layout.stateFile)
  try {
    return await runnerStatus({
      config,
      deviceKeyStore: new FileDeviceKeyStore(layout.keysDir),
      durableStore: store,
      runningProcess,
      clock,
    })
  } finally {
    store.close()
  }
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

export interface RunnerCommandStartOptions {
  home: string
  once?: boolean
  signal?: AbortSignal
  clock?: () => Date
  onStatusChange?: (status: RunnerStatus) => void
}

export interface RunnerCommandStartHandle {
  process: RunnerProcess
  close: () => void
}

export function runnerCommandStart(
  options: RunnerCommandStartOptions,
): RunnerCommandStartHandle {
  const config = readRunnerConfig(options.home)
  const layout = runnerHomeLayout(options.home)
  if (!existsSync(layout.receiptKeyFile)) {
    throw new CoreError(
      "RUNNER_NOT_INITIALIZED",
      "Runner receipt key missing; run `digital-employee runner init`",
      { retryable: false },
    )
  }
  let receiptPrivateKey: KeyObject
  try {
    receiptPrivateKey = createPrivateKey(readFileSync(layout.receiptKeyFile, "utf8"))
  } catch {
    throw new CoreError(
      "RUNNER_CONFIG_INVALID",
      "Runner receipt key is unreadable; re-run `digital-employee runner init`",
      { retryable: false },
    )
  }
  const receiptKeyId = deriveDeviceKeyId(createPublicKey(receiptPrivateKey))
  const store = new SqliteDurableStore(layout.stateFile)
  const lockHolder: RunnerLockHolder = {
    pid: process.pid,
    startedAt: (options.clock ?? (() => new Date()))().toISOString(),
  }
  const lock = store.acquireRunnerLock(lockHolder)
  if (!lock.acquired) {
    store.close()
    throw new CoreError(
      "RUNNER_ALREADY_RUNNING",
      `Runner already running (pid ${lock.holder.pid}, started at ${lock.holder.startedAt}); ` +
        "stop the running runner before starting another",
      { retryable: false },
    )
  }
  try {
    const transport = new HttpRunnerTransport({ endpoint: config.platformEndpoint, signal: options.signal })
    const deviceKeyStore = new FileDeviceKeyStore(layout.keysDir)
    const hostRegistry = createBuiltInAgentHostRegistry()

    const process = runnerStart({
      config,
      deviceKeyStore,
      durableStore: store,
      transport,
      resolvePlatformPublicKey: (keyId) => transport.platformKey(keyId),
      resolveLocalPackage: (request) =>
        resolveDeployedPackage(store, request),
      hostRegistry,
      receiptKeyId,
      receiptPrivateKey,
      executeTask: (execution) => executeOneShotRunnerTask(execution),
      once: options.once,
      signal: options.signal,
      clock: options.clock,
      onStatusChange: options.onStatusChange,
    })
    return {
      process,
      close: () => {
        store.releaseRunnerLock(lockHolder)
        store.close()
      },
    }
  } catch (error) {
    store.releaseRunnerLock(lockHolder)
    store.close()
    throw error
  }
}

async function resolveDeployedPackage(
  store: SqliteDurableStore,
  request: RunnerLocalPackageRequest,
): Promise<string> {
  const deployment = await store.getDeployment(
    request.employeeId,
    request.employeeVersion,
  )
  if (!deployment) {
    throw new CoreError(
      "RUNNER_LOCAL_PACKAGE_UNAVAILABLE",
      `No local deployment for ${request.employeeId}@${request.employeeVersion}; ` +
        "run `digital-employee runner deploy` first",
      { retryable: false },
    )
  }
  if (deployment.packageDigest !== request.packageDigest) {
    throw new CoreError(
      "RUNNER_LOCAL_PACKAGE_UNAVAILABLE",
      `Package digest mismatch for ${request.employeeId}@${request.employeeVersion}; ` +
        "re-deploy the matching package version",
      { retryable: false },
    )
  }
  return deployment.localPackageRef
}

// ---------------------------------------------------------------------------
// deploy
// ---------------------------------------------------------------------------

export interface RunnerCommandDeployOptions {
  home: string
  employeeDirectory: string
  agentHostId?: string
  clock?: () => Date
}

export async function runnerCommandDeploy(
  options: RunnerCommandDeployOptions,
): Promise<RunnerDeploymentRecord> {
  readRunnerConfig(options.home)
  const layout = runnerHomeLayout(options.home)
  ensureHome(layout)
  const inspection = await inspectEmployeePackage(options.employeeDirectory)
  const packageDigest = await computeEmployeePackageDirectoryDigest(
    options.employeeDirectory,
  )
  const localPackageRef = path.join(
    layout.packagesDir,
    `${inspection.manifest.name}@${inspection.manifest.version}`,
  )
  rmSync(localPackageRef, { recursive: true, force: true })
  cpSync(inspection.directory, localPackageRef, { recursive: true })
  const record: RunnerDeploymentRecord = {
    employeeId: inspection.manifest.name,
    employeeVersion: inspection.manifest.version,
    packageDigest,
    localPackageRef,
    agentHostId: options.agentHostId ?? "any",
    registeredAt: (options.clock ?? (() => new Date()))().toISOString(),
  }
  const store = new SqliteDurableStore(layout.stateFile)
  try {
    store.putDeployment(record)
  } finally {
    store.close()
  }
  return record
}
