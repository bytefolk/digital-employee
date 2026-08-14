#!/usr/bin/env node

import path from "node:path"
import { closeSync, fstatSync, lstatSync, readSync } from "node:fs"

import {
  createSealedEmployeePackageSnapshot,
  inspectEmployeePackage,
} from "../employee-package.js"
import { runEmployeePackage } from "../agent-run.js"
import {
  acceptsHttpMessageInputSchema,
  completedHttpAnswer,
  createHttpServer,
} from "../../server/server.js"
import { loadConfigSnapshotFromPath } from "./config.js"
import type { DeployConfig } from "./config.js"

interface RuntimeArguments {
  statePath: string
  launchId: string
  activationFence: string
  packageName: string
  packageVersion: string
  packageDigest: string
  engine: string
  runtime: "agent-native"
  botName: string
  host: "127.0.0.1"
  port: number
  askPath: "/v1/ask"
  healthPath: "/health"
  lockNonce: string
  lockDevice: number
  lockInode: number
  lockOwnerPid: number
}

const ACTIVATION_LEASE_FD = 4
const HTTP_RUNTIME_SHUTDOWN_TIMEOUT_MS = 15_000
const HTTP_RUNTIME_SNAPSHOT_CLEANUP_TIMEOUT_MS = 5_000

function readActivationLeaseRecord(size: number): Record<string, unknown> {
  if (!Number.isSafeInteger(size) || size < 2 || size > 4_096) {
    throw new TypeError("deploy_http_runtime_activation_lease_invalid")
  }
  const bytes = Buffer.alloc(size)
  const bytesRead = readSync(ACTIVATION_LEASE_FD, bytes, 0, size, 0)
  if (bytesRead !== size) {
    throw new TypeError("deploy_http_runtime_activation_lease_invalid")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown
  } catch {
    throw new TypeError("deploy_http_runtime_activation_lease_invalid")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("deploy_http_runtime_activation_lease_invalid")
  }
  return parsed as Record<string, unknown>
}

function requiredActivationLease(statePath: string): Pick<
  RuntimeArguments,
  "lockNonce" | "lockDevice" | "lockInode" | "lockOwnerPid"
> {
  const descriptor = fstatSync(ACTIVATION_LEASE_FD)
  const lockPath = path.join(path.dirname(statePath), ".deploy.lock")
  const published = lstatSync(lockPath)
  const record = readActivationLeaseRecord(descriptor.size)
  if (
    !descriptor.isFile() ||
    descriptor.isSymbolicLink() ||
    descriptor.nlink !== 1 ||
    (descriptor.mode & 0o777) !== 0o600 ||
    !published.isFile() ||
    published.isSymbolicLink() ||
    published.dev !== descriptor.dev ||
    published.ino !== descriptor.ino ||
    published.nlink !== 1 ||
    (published.mode & 0o777) !== 0o600 ||
    (typeof process.getuid === "function" &&
      (descriptor.uid !== process.getuid() || published.uid !== process.getuid())) ||
    record.schemaVersion !== "deploy-lock.v3" ||
    !Number.isSafeInteger(record.pid) ||
    record.pid !== process.ppid ||
    typeof record.nonce !== "string" ||
    !record.nonce.match(/^[a-f0-9]{32}$/)
  ) {
    throw new TypeError("deploy_http_runtime_activation_lease_invalid")
  }
  return {
    lockNonce: record.nonce,
    lockDevice: descriptor.dev,
    lockInode: descriptor.ino,
    lockOwnerPid: record.pid,
  }
}

function assertActivationLease(expected: RuntimeArguments): void {
  const current = requiredActivationLease(expected.statePath)
  if (
    current.lockNonce !== expected.lockNonce ||
    current.lockDevice !== expected.lockDevice ||
    current.lockInode !== expected.lockInode ||
    current.lockOwnerPid !== expected.lockOwnerPid
  ) {
    throw new TypeError("deploy_http_runtime_activation_lease_lost")
  }
}

function argument(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`
  const matches = argv.filter((value) => value.startsWith(prefix))
  return matches.length === 1 ? matches[0]!.slice(prefix.length) : undefined
}

function requiredRuntimeArguments(argv: string[]): RuntimeArguments {
  if (argv.length !== 13) {
    throw new TypeError("deploy_http_runtime_requires_exact_activation_tuple")
  }
  const statePath = argument(argv, "state")
  const launchId = argument(argv, "launch-id")
  const activationFence = argument(argv, "activation-fence")
  const packageName = argument(argv, "package-name")
  const packageVersion = argument(argv, "package-version")
  const packageDigest = argument(argv, "package-digest")
  const engine = argument(argv, "engine")
  const runtime = argument(argv, "runtime")
  const botName = argument(argv, "bot-name")
  const host = argument(argv, "host")
  const portText = argument(argv, "port")
  const askPath = argument(argv, "ask-path")
  const healthPath = argument(argv, "health-path")
  const port = portText && /^\d+$/.test(portText) ? Number(portText) : 0
  if (
    !statePath ||
    !path.isAbsolute(statePath) ||
    !launchId?.match(/^[a-f0-9]{32}$/) ||
    !activationFence?.match(/^[a-f0-9]{32}$/) ||
    !packageName?.match(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) ||
    !packageVersion ||
    packageVersion.length > 128 ||
    !packageDigest?.match(/^sha256:[a-f0-9]{64}$/) ||
    !engine ||
    engine.length > 128 ||
    runtime !== "agent-native" ||
    !botName ||
    botName.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(botName) ||
    host !== "127.0.0.1" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    askPath !== "/v1/ask" ||
    healthPath !== "/health"
  ) {
    throw new TypeError("deploy_http_runtime_requires_exact_activation_tuple")
  }
  return {
    statePath,
    launchId,
    activationFence,
    packageName,
    packageVersion,
    packageDigest,
    engine,
    runtime,
    botName,
    host,
    port,
    askPath,
    healthPath,
    ...requiredActivationLease(statePath),
  }
}

function tupleMatches(
  value: Record<string, unknown>,
  expected: RuntimeArguments,
): boolean {
  const allowedKeys = new Set([
    "type",
    "phase",
    "stateDigest",
    "statePath",
    "launchId",
    "activationFence",
    "botName",
    "engine",
    "runtime",
    "packageName",
    "packageVersion",
    "packageDigest",
    "host",
    "port",
    "askPath",
    "healthPath",
    "lockNonce",
    "lockDevice",
    "lockInode",
    "lockOwnerPid",
  ])
  return (
    Object.keys(value).length === allowedKeys.size &&
    Object.keys(value).every((key) => allowedKeys.has(key)) &&
    value.statePath === expected.statePath &&
    value.launchId === expected.launchId &&
    value.activationFence === expected.activationFence &&
    value.botName === expected.botName &&
    value.engine === expected.engine &&
    value.runtime === expected.runtime &&
    value.packageName === expected.packageName &&
    value.packageVersion === expected.packageVersion &&
    value.packageDigest === expected.packageDigest &&
    value.host === expected.host &&
    value.port === expected.port &&
    value.askPath === expected.askPath &&
    value.healthPath === expected.healthPath
    && value.lockNonce === expected.lockNonce
    && value.lockDevice === expected.lockDevice
    && value.lockInode === expected.lockInode
    && value.lockOwnerPid === expected.lockOwnerPid
  )
}

function activationTuple(expected: RuntimeArguments): Record<string, unknown> {
  return {
    statePath: expected.statePath,
    launchId: expected.launchId,
    activationFence: expected.activationFence,
    botName: expected.botName,
    engine: expected.engine,
    runtime: expected.runtime,
    packageName: expected.packageName,
    packageVersion: expected.packageVersion,
    packageDigest: expected.packageDigest,
    host: expected.host,
    port: expected.port,
    askPath: expected.askPath,
    healthPath: expected.healthPath,
    lockNonce: expected.lockNonce,
    lockDevice: expected.lockDevice,
    lockInode: expected.lockInode,
    lockOwnerPid: expected.lockOwnerPid,
  }
}

function waitForProtocolMessage(
  expectedPhase: "prepare" | "commit" | "activate" | "listen" | "detach" | "release",
  expected: RuntimeArguments,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (!process.send || !process.connected) {
      reject(new TypeError("deploy_http_runtime_activation_parent_lost"))
      return
    }
    let settled = false
    const finish = (message?: Record<string, unknown>, error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.removeListener("message", onMessage)
      process.removeListener("disconnect", onDisconnect)
      if (error) reject(error)
      else resolve(message!)
    }
    const onMessage = (message: unknown) => {
      if (
        message &&
        typeof message === "object" &&
        !Array.isArray(message) &&
        (message as Record<string, unknown>).type ===
          "deploy-http-runtime-activation" &&
        (message as Record<string, unknown>).phase === expectedPhase &&
        typeof (message as Record<string, unknown>).stateDigest === "string" &&
        ((message as Record<string, unknown>).stateDigest as string).match(
          /^[a-f0-9]{64}$/,
        ) &&
        tupleMatches(message as Record<string, unknown>, expected)
      ) {
        finish(message as Record<string, unknown>)
      } else {
        finish(
          undefined,
          new TypeError("deploy_http_runtime_activation_protocol_invalid"),
        )
      }
    }
    const onDisconnect = () => finish(
      undefined,
      new TypeError("deploy_http_runtime_activation_parent_lost"),
    )
    const timer = setTimeout(() => finish(
      undefined,
      new TypeError("deploy_http_runtime_activation_timeout"),
    ), 10_000)
    timer.unref()
    process.on("message", onMessage)
    process.once("disconnect", onDisconnect)
  })
}

function sendProtocolMessage(message: Record<string, unknown>): Promise<void> {
  if (!process.send || !process.connected) {
    return Promise.reject(
      new TypeError("deploy_http_runtime_activation_parent_lost"),
    )
  }
  return new Promise((resolve, reject) => {
    process.send?.(message, (error: Error | null) => {
      if (error || !process.connected) {
        reject(error ?? new TypeError("deploy_http_runtime_activation_parent_lost"))
      } else {
        resolve()
      }
    })
  })
}

async function activatedConfig(
  expected: RuntimeArguments,
  stateDigest: string,
  activationState: "prepared" | "authorized",
  expectedOutcome: "pending_external_action" | "ready" = "pending_external_action",
): Promise<DeployConfig> {
  assertActivationLease(expected)
  const snapshot = await loadConfigSnapshotFromPath(expected.statePath)
  const config = snapshot.config
  if (
    snapshot.fingerprint.kind !== "present" ||
    snapshot.fingerprint.digest !== stateDigest ||
    config.schemaVersion !== "deploy-state.v1" ||
    config.channel !== "http" ||
    config.botName !== expected.botName ||
    config.engine !== expected.engine ||
    config.runtime !== expected.runtime ||
    config.outcome !== expectedOutcome ||
    config.package?.name !== expected.packageName ||
    config.package.version !== expected.packageVersion ||
    config.package.digest !== expected.packageDigest ||
    config.endpoint?.host !== expected.host ||
    config.endpoint.port !== expected.port ||
    config.endpoint.askPath !== expected.askPath ||
    config.endpoint.healthPath !== expected.healthPath ||
    config.process?.pid !== process.pid ||
    config.process.launchId !== expected.launchId ||
    config.process.activationFence !== expected.activationFence ||
    config.process.activationState !== activationState ||
    config.secretReferences?.httpTokenEnv !== "DIGITAL_EMPLOYEE_HTTP_TOKEN"
  ) {
    throw new TypeError("deploy_http_runtime_activation_state_invalid")
  }
  assertActivationLease(expected)
  return config
}

async function waitForActivation(
  expected: RuntimeArguments,
): Promise<{ config: DeployConfig; stateDigest: string }> {
  if (!process.send || !process.connected) {
    throw new TypeError("deploy_http_runtime_activation_channel_required")
  }
  assertActivationLease(expected)
  await sendProtocolMessage({
    type: "deploy-http-runtime-awaiting-activation",
    ...activationTuple(expected),
  })
  const prepared = await waitForProtocolMessage("prepare", expected)
  const preparedDigest = prepared.stateDigest as string
  await activatedConfig(expected, preparedDigest, "prepared")
  assertActivationLease(expected)
  await sendProtocolMessage({
    type: "deploy-http-runtime-activation-ack",
    phase: "prepared",
    stateDigest: preparedDigest,
    ...activationTuple(expected),
  })
  const committed = await waitForProtocolMessage("commit", expected)
  const committedDigest = committed.stateDigest as string
  const config = await activatedConfig(expected, committedDigest, "authorized")
  assertActivationLease(expected)
  await sendProtocolMessage({
    type: "deploy-http-runtime-activation-ack",
    phase: "authorized",
    stateDigest: committedDigest,
    ...activationTuple(expected),
  })
  return { config, stateDigest: committedDigest }
}

export async function runHttpDeploymentRuntime(
  runtimeArguments: RuntimeArguments,
): Promise<void> {
  let parentLost = false
  let acceptsRequests = false
  let server: ReturnType<typeof createHttpServer> | undefined
  let packageSnapshot: Awaited<
    ReturnType<typeof createSealedEmployeePackageSnapshot>
  > | undefined
  let packageSnapshotPromise: Promise<
    Awaited<ReturnType<typeof createSealedEmployeePackageSnapshot>>
  > | undefined
  let snapshotCleanup: Promise<boolean> | undefined
  let stopping: Promise<boolean> | undefined

  const cleanupSnapshot = async (): Promise<boolean> => {
    snapshotCleanup ??= (async () => {
      try {
        const snapshot = packageSnapshot ?? await packageSnapshotPromise
        if (!snapshot) return true
        await snapshot.cleanup()
        return true
      } catch {
        return false
      }
    })()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        snapshotCleanup,
        new Promise<boolean>((resolve) => {
          timer = setTimeout(
            () => resolve(false),
            HTTP_RUNTIME_SNAPSHOT_CLEANUP_TIMEOUT_MS,
          )
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  const stopRuntime = (): Promise<boolean> => {
    stopping ??= (async () => {
      acceptsRequests = false
      const serverClean = server
        ? await server.shutdown({
            timeoutMs: HTTP_RUNTIME_SHUTDOWN_TIMEOUT_MS,
          }).catch(() => false)
        : true
      const snapshotClean = await cleanupSnapshot()
      return serverClean && snapshotClean
    })()
    return stopping
  }
  const stop = () => {
    parentLost = true
    if (process.connected) process.disconnect?.()
    void stopRuntime().then(
      (clean) => process.exit(clean ? 0 : 1),
      () => process.exit(1),
    )
  }
  const onParentLost = () => {
    parentLost = true
  }
  process.once("disconnect", onParentLost)
  // These handlers precede snapshot creation. If a signal lands while the
  // copy is in progress, stopRuntime waits for that promise and removes it.
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  const activationDeadline = setTimeout(() => {
    parentLost = true
    if (process.connected) process.disconnect?.()
  }, 30_000)
  activationDeadline.unref()
  const activated = await waitForActivation(runtimeArguments)
  const { config, stateDigest } = activated
  const endpoint = config.endpoint!
  const activate = await waitForProtocolMessage("activate", runtimeArguments)
  if (activate.stateDigest !== stateDigest) {
    throw new TypeError("deploy_http_runtime_activation_state_invalid")
  }
  await activatedConfig(runtimeArguments, stateDigest, "authorized")
  assertActivationLease(runtimeArguments)
  const tokenReference = config.secretReferences?.httpTokenEnv
  const httpToken = tokenReference === "DIGITAL_EMPLOYEE_HTTP_TOKEN"
    ? process.env[tokenReference]?.trim()
    : undefined
  if (
    !httpToken ||
    httpToken.length > 8_192 ||
    /[\u0000-\u001f\u007f]/.test(httpToken)
  ) {
    throw new TypeError("deploy_http_runtime_token_required")
  }
  packageSnapshotPromise = createSealedEmployeePackageSnapshot(
    config.package!.localReference,
  )
  packageSnapshot = await packageSnapshotPromise
  if (parentLost || !process.connected) {
    await stopRuntime()
    throw new TypeError("deploy_http_runtime_activation_parent_lost")
  }
  if (
    packageSnapshot.digest !== config.package!.digest ||
    packageSnapshot.manifest.name !== config.package!.name ||
    packageSnapshot.manifest.version !== config.package!.version
  ) {
    await cleanupSnapshot()
    throw new TypeError("deploy_http_runtime_package_digest_mismatch")
  }
  let packageInspection: Awaited<ReturnType<typeof inspectEmployeePackage>>
  try {
    packageInspection = await inspectEmployeePackage(packageSnapshot.directory)
  } catch (error) {
    await cleanupSnapshot()
    throw error
  }
  if (!acceptsHttpMessageInputSchema(packageInspection.artifacts.inputSchema)) {
    await cleanupSnapshot()
    throw new TypeError("deploy_http_runtime_message_input_incompatible")
  }
  try {
    assertActivationLease(runtimeArguments)
    if (parentLost || !process.connected) {
      throw new TypeError("deploy_http_runtime_activation_parent_lost")
    }
    await sendProtocolMessage({
      type: "deploy-http-runtime-activation-ack",
      phase: "ready-to-listen",
      stateDigest,
      ...activationTuple(runtimeArguments),
    })
    const listen = await waitForProtocolMessage("listen", runtimeArguments)
    if (listen.stateDigest !== stateDigest) {
      throw new TypeError("deploy_http_runtime_activation_state_invalid")
    }
    await activatedConfig(runtimeArguments, stateDigest, "authorized")
    assertActivationLease(runtimeArguments)
    if (parentLost || !process.connected) {
      throw new TypeError("deploy_http_runtime_activation_parent_lost")
    }
  } catch (error) {
    await cleanupSnapshot()
    throw error
  }

  const binding = {
    name: config.package!.name,
    version: config.package!.version,
    digest: config.package!.digest,
    runtime: config.runtime!,
    engine: config.engine!,
  }
  let activationLeaseClosed = false
  try {
    server = createHttpServer({
    token: httpToken,
    requireToken: true,
    employee: {
      async answer(input) {
        if (!acceptsRequests || input.signal.aborted) {
          return {
            status: "rejected",
            error: {
              code: "http_runtime_activation_incomplete",
              retryable: true,
            },
          }
        }
        try {
          const result = await runEmployeePackage({
            directory: packageSnapshot.directory,
            engine: config.engine!,
            input: { message: input.message },
            expectedPackageDigest: config.package!.digest,
            signal: input.signal,
            waitForPreflightCleanupOnAbort: true,
          })
          if (result.status === "failed") {
            return {
              status: "rejected",
              error: {
                code: result.error.code,
                retryable: result.error.retryable,
              },
            }
          }
          return completedHttpAnswer(result.output)
        } catch {
          return {
            status: "rejected",
            error: {
              code: "employee_package_snapshot_failed",
              retryable: false,
            },
          }
        }
      },
    },
    health: () => ({
      schemaVersion: "deploy-readiness.v1",
      status: "ok",
      inputContract: "message.v1",
      pid: process.pid,
      launchId: runtimeArguments.launchId,
      activationFence: runtimeArguments.activationFence,
      endpoint: {
        host: endpoint.host,
        port: endpoint.port,
        askPath: endpoint.askPath,
        healthPath: endpoint.healthPath,
      },
      package: binding,
      workload: server?.workload(),
    }),
    })
  } catch (error) {
    await cleanupSnapshot()
    throw error
  }

  const becomeAutonomous = () => {
    process.removeListener("disconnect", onParentLost)
    clearTimeout(activationDeadline)
    if (!activationLeaseClosed) {
      closeSync(ACTIVATION_LEASE_FD)
      activationLeaseClosed = true
    }
    acceptsRequests = true
  }
  try {
    assertActivationLease(runtimeArguments)
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        process.removeListener("disconnect", onDisconnect)
        server.removeListener("error", onError)
        if (error) reject(error)
        else resolve()
      }
      const onError = (error: Error) => finish(error)
      const onDisconnect = () => {
        server.close()
        finish(new TypeError("deploy_http_runtime_activation_parent_lost"))
      }
      server.once("error", onError)
      process.once("disconnect", onDisconnect)
      server.listen(endpoint.port, endpoint.host, () => {
        finish()
      })
    })
    await activatedConfig(runtimeArguments, stateDigest, "authorized")
    assertActivationLease(runtimeArguments)
    if (parentLost || !process.connected) {
      throw new TypeError("deploy_http_runtime_activation_parent_lost")
    }
    await sendProtocolMessage({
      type: "deploy-http-runtime-activation-ack",
      phase: "listening",
      stateDigest,
      ...activationTuple(runtimeArguments),
    })
    const detach = await waitForProtocolMessage("detach", runtimeArguments)
    const detachStateDigest = detach.stateDigest as string
    await activatedConfig(runtimeArguments, detachStateDigest, "authorized")
    assertActivationLease(runtimeArguments)
    if (parentLost || !process.connected) {
      throw new TypeError("deploy_http_runtime_activation_parent_lost")
    }
    await sendProtocolMessage({
      type: "deploy-http-runtime-activation-ack",
      phase: "detached",
      stateDigest: detachStateDigest,
      ...activationTuple(runtimeArguments),
    })
    const release = await waitForProtocolMessage("release", runtimeArguments)
    const releaseStateDigest = release.stateDigest as string
    await activatedConfig(
      runtimeArguments,
      releaseStateDigest,
      "authorized",
      "ready",
    )
    assertActivationLease(runtimeArguments)
    if (parentLost || !process.connected) {
      throw new TypeError("deploy_http_runtime_activation_parent_lost")
    }
    becomeAutonomous()
    try {
      await sendProtocolMessage({
        type: "deploy-http-runtime-activation-ack",
        phase: "released",
        stateDigest: releaseStateDigest,
        ...activationTuple(runtimeArguments),
      })
    } catch {
      // The child has already validated the durable Ready commit and lease.
    }
    if (process.connected) process.disconnect?.()
  } catch (error) {
    await stopRuntime()
    throw error
  }

}

const runtimeArguments = requiredRuntimeArguments(process.argv.slice(2))
runHttpDeploymentRuntime(runtimeArguments).catch(() => {
  if (process.connected) process.disconnect?.()
  process.exitCode = 1
})
