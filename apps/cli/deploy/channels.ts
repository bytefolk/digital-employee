/** Channel-specific deploy orchestration with observable outcome evidence. */

import { execFile, spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { readFile } from "node:fs/promises"
import { get as httpGet, request as httpRequest } from "node:http"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"

import { t } from "./i18n.js"
import { getConfigPath } from "./config.js"
import { reconcileDingTalkApplication } from "./dingtalk-provider.js"
import type {
  DeployConfig,
  DeployEndpoint,
  DeployOutcome,
  DeployProcessState,
  DeployProviderOperation,
  DeployProviderState,
} from "./config.js"

export type ChannelId = "dingtalk" | "lark" | "wecom" | "console" | "http"

export interface ChannelDeployResult {
  outcome: DeployOutcome
  steps: string[]
  code?: string
  guidance?: string
  endpoint?: DeployEndpoint
  process?: DeployProcessState
  provider?: DeployProviderState
  /** Do not rewrite the latest durable state for this outcome. */
  preserveState?: true
  /** In-memory ownership handle; never persisted or rendered. */
  cleanup?: () => Promise<boolean>
  /** Completes the parent-coupled activation only after final publication gates. */
  finalize?: (stateDigest: string) => Promise<boolean>
  /** Releases the inherited lock lease only after the persisted Ready readback. */
  release?: (stateDigest: string) => Promise<HttpReleaseResult>
}

export interface HttpReleaseResult {
  /** The release message crossed the irreversible parent-to-child boundary. */
  sent: boolean
  /** The parent observed the child's exact acknowledgement. */
  acknowledged: boolean
}

export interface HttpActivationLease {
  fileDescriptor: number
  nonce: string
  device: number
  inode: number
  ownerPid: number
}

export interface ChannelDeployContext {
  signal?: AbortSignal
  readinessTimeoutMs?: number
  onProcessStarted?: (process: DeployProcessState) => string | Promise<string>
  allowProviderWrite?: boolean
  confirmProviderWrite?: () => boolean | Promise<boolean>
  onProviderVerified?: (provider: DeployProviderState) => void | Promise<void>
  onProviderOperation?: (
    operation: DeployProviderOperation,
  ) => void | Promise<void>
  assertLockOwned?: () => void | Promise<void>
  activationLease?: HttpActivationLease
}

function outcome(
  value: DeployOutcome,
  code: string,
  guidance: string,
): ChannelDeployResult {
  return { outcome: value, steps: [], code, guidance }
}

export async function deployDingTalk(
  config: DeployConfig,
  context: ChannelDeployContext = {},
): Promise<ChannelDeployResult> {
  if (!config.botName) {
    return outcome(
      "failed",
      "dingtalk_provider_state_invalid",
      t("deploy.error_state_invalid"),
    )
  }
  const result = await reconcileDingTalkApplication(
    { name: config.botName, existing: config.provider },
    {
      signal: context.signal,
      allowWrite: context.allowProviderWrite,
      confirmWrite: context.confirmProviderWrite,
      beforeBoundary: context.assertLockOwned,
      existingOperation: config.providerOperation,
      onCreateAttempt: context.onProviderOperation,
      onProviderIdentified: context.onProviderVerified,
    },
  )
  if (
    result.code === "deploy_interrupted" &&
    result.status !== "indeterminate"
  ) {
    return {
      ...outcome("failed", result.code, t("deploy.error_interrupted")),
      ...(result.preserveState ? { preserveState: true as const } : {}),
    }
  }
  if (result.status === "verified") {
    if (!result.provider) {
      return outcome(
        "failed",
        "dingtalk_provider_identity_missing",
        t("deploy.error_dingtalk_provider"),
      )
    }
    return {
      outcome: "pending_external_action",
      steps: [t("deploy.step_dingtalk_app_verified")],
      code: "dingtalk_app_verified_pending_setup",
      guidance: t("deploy.guidance_dingtalk_pending"),
      provider: result.provider,
    }
  }
  if (result.status === "indeterminate") {
    return {
      ...outcome(
        "pending_external_action",
        result.code,
        t("deploy.guidance_dingtalk_pending"),
      ),
      ...(result.provider ? { provider: result.provider } : {}),
      ...(result.preserveState ? { preserveState: true as const } : {}),
    }
  }
  if (result.status === "confirmation_required") {
    return outcome(
      "pending_external_action",
      result.code,
      t("deploy.guidance_dingtalk_confirmation"),
    )
  }
  return {
    ...outcome("failed", result.code, t("deploy.error_dingtalk_provider")),
    ...(result.provider ? { provider: result.provider } : {}),
    ...(result.preserveState ? { preserveState: true as const } : {}),
  }
}

export async function deployLark(
  _config: DeployConfig,
): Promise<ChannelDeployResult> {
  return outcome(
    "unsupported",
    "lark_live_deploy_unsupported",
    t("deploy.guidance_lark_unsupported"),
  )
}

export async function deployWeCom(
  _config: DeployConfig,
): Promise<ChannelDeployResult> {
  return outcome(
    "unsupported",
    "wecom_live_deploy_unsupported",
    t("deploy.guidance_wecom_unsupported"),
  )
}

/** Console requires an attached foreground terminal; no detached no-op exists. */
export async function deployConsole(
  _config: DeployConfig,
): Promise<ChannelDeployResult> {
  return outcome(
    "pending_external_action",
    "console_foreground_start_required",
    t("deploy.guidance_console_pending"),
  )
}

interface HttpReadiness {
  schemaVersion?: unknown
  status?: unknown
  inputContract?: unknown
  pid?: unknown
  launchId?: unknown
  activationFence?: unknown
  endpoint?: {
    host?: unknown
    port?: unknown
    askPath?: unknown
    healthPath?: unknown
  }
  package?: {
    name?: unknown
    version?: unknown
    digest?: unknown
    runtime?: unknown
    engine?: unknown
  }
}

async function readHttpReadiness(
  endpoint: DeployEndpoint,
  timeoutMs: number,
): Promise<HttpReadiness | undefined> {
  return new Promise((resolve) => {
    const request = httpGet(
      {
        host: endpoint.host,
        port: endpoint.port,
        path: endpoint.healthPath,
        timeout: timeoutMs,
        headers: { accept: "application/json" },
      },
      (response) => {
        const chunks: Buffer[] = []
        let bytes = 0
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          bytes += buffer.length
          if (bytes <= 64 * 1024) chunks.push(buffer)
          else request.destroy()
        })
        response.on("end", () => {
          if (response.statusCode !== 200 || bytes > 64 * 1024) {
            resolve(undefined)
            return
          }
          try {
            resolve(
              JSON.parse(Buffer.concat(chunks).toString("utf8")) as HttpReadiness,
            )
          } catch {
            resolve(undefined)
          }
        })
      },
    )
    request.once("timeout", () => request.destroy())
    request.once("error", () => resolve(undefined))
  })
}

async function hasExactHttpAuthorizationBinding(
  config: DeployConfig,
  timeoutMs: number,
): Promise<boolean> {
  if (!config.endpoint) return false
  const tokenReference = config.secretReferences?.httpTokenEnv
  const token = tokenReference ? process.env[tokenReference]?.trim() : undefined
  if (tokenReference && !token) return false
  const body = '{"requestId":"deployment-auth-binding-probe"}'
  return new Promise((resolve) => {
    const request = httpRequest(
      {
        host: config.endpoint!.host,
        port: config.endpoint!.port,
        path: config.endpoint!.askPath,
        method: "POST",
        timeout: timeoutMs,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token ?? "deployment-no-token-probe"}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        let bytes = 0
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          bytes += buffer.length
          if (bytes <= 64 * 1024) chunks.push(buffer)
          else request.destroy()
        })
        response.on("end", () => {
          if (response.statusCode !== 400 || bytes > 64 * 1024) {
            resolve(false)
            return
          }
          try {
            const parsed = JSON.parse(
              Buffer.concat(chunks).toString("utf8"),
            ) as Record<string, unknown>
            resolve(
              Object.keys(parsed).length === 1 &&
              parsed.error === "client_identity_fields_not_allowed",
            )
          } catch {
            resolve(false)
          }
        })
      },
    )
    request.once("timeout", () => request.destroy())
    request.once("error", () => resolve(false))
    request.end(body)
  })
}

function readinessMatches(
  readiness: HttpReadiness | undefined,
  config: DeployConfig,
  expected: { pid: number; launchId: string; activationFence: string },
): boolean {
  return Boolean(
    readiness?.schemaVersion === "deploy-readiness.v1" &&
      readiness.status === "ok" &&
      readiness.inputContract === "message.v1" &&
      readiness.pid === expected.pid &&
      readiness.launchId === expected.launchId &&
      readiness.activationFence === expected.activationFence &&
      readiness.endpoint?.host === config.endpoint?.host &&
      readiness.endpoint?.port === config.endpoint?.port &&
      readiness.endpoint?.askPath === "/v1/ask" &&
      readiness.endpoint?.healthPath === "/health" &&
      readiness.package?.name === config.package?.name &&
      readiness.package?.version === config.package?.version &&
      readiness.package?.digest === config.package?.digest &&
      readiness.package?.runtime === config.runtime &&
      readiness.package?.engine === config.engine,
  )
}

function httpRuntimeEntry(): string {
  const sourceMode = import.meta.url.endsWith(".ts")
  return fileURLToPath(
    new URL(sourceMode ? "./http-runtime.ts" : "./http-runtime.js", import.meta.url),
  )
}

function httpRuntimeInvocation(
  launchId: string,
  activationFence: string,
  config: DeployConfig,
): { command: string; args: string[] } {
  const sourceMode = import.meta.url.endsWith(".ts")
  const entry = httpRuntimeEntry()
  return {
    command: process.execPath,
    args: [
      ...(sourceMode ? ["--import", "tsx"] : []),
      entry,
      `--state=${getConfigPath()}`,
      `--launch-id=${launchId}`,
      `--package-digest=${config.package?.digest ?? ""}`,
      `--port=${config.endpoint?.port ?? ""}`,
      `--package-name=${config.package?.name ?? ""}`,
      `--package-version=${config.package?.version ?? ""}`,
      `--engine=${config.engine ?? ""}`,
      `--runtime=${config.runtime ?? ""}`,
      `--bot-name=${config.botName ?? ""}`,
      `--host=${config.endpoint?.host ?? ""}`,
      `--ask-path=${config.endpoint?.askPath ?? ""}`,
      `--health-path=${config.endpoint?.healthPath ?? ""}`,
      `--activation-fence=${activationFence}`,
    ],
  }
}

/** @internal Builds the exact detached-runtime environment for tests/audits. */
export function buildHttpRuntimeEnvironment(
  config: DeployConfig,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  const common = [
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "NO_COLOR",
    "TERM",
    "TZ",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
  ] as const
  const engineVariables: Record<string, readonly string[]> = {
    "claude-code": ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"],
    qoder: ["QODER_PERSONAL_ACCESS_TOKEN"],
    "qwen-code": ["OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_BASE_URL"],
    codebuddy: [
      "CODEBUDDY_API_KEY",
      "CODEBUDDY_MODEL",
      "CODEBUDDY_BASE_URL",
      "CODEBUDDY_INTERNET_ENVIRONMENT",
    ],
  }
  const selected = config.engine ? engineVariables[config.engine] : undefined
  if (!selected) throw new TypeError("http_runtime_engine_invalid")
  const tokenVariable = config.secretReferences?.httpTokenEnv ===
      "DIGITAL_EMPLOYEE_HTTP_TOKEN"
    ? ["DIGITAL_EMPLOYEE_HTTP_TOKEN"]
    : []
  for (const key of [...common, ...selected, ...tokenVariable]) {
    if (source[key] !== undefined) environment[key] = source[key]
  }
  return environment
}

function signalOwnedProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (!pid || pid === process.pid) return
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // The process already exited.
    }
  }
}

async function terminateSpawnedProcess(child: ChildProcess): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  signalOwnedProcess(child, "SIGTERM")
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    delay(2_000).then(() => false),
  ])
  if (exited || child.exitCode !== null || child.signalCode !== null) return true
  signalOwnedProcess(child, "SIGKILL")
  const killed = await Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    delay(2_000).then(() => false),
  ])
  return killed || child.exitCode !== null || child.signalCode !== null
}

function waitForRuntimeMessage(
  child: ChildProcess,
  accepts: (message: Record<string, unknown>) => boolean,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ready: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener("message", onMessage)
      child.removeListener("exit", onExit)
      child.removeListener("disconnect", onDisconnect)
      signal?.removeEventListener("abort", onAbort)
      resolve(ready)
    }
    const onMessage = (message: unknown) => {
      if (
        message &&
        typeof message === "object" &&
        !Array.isArray(message) &&
        accepts(message as Record<string, unknown>)
      ) {
        finish(true)
      }
    }
    const onExit = () => finish(false)
    const onDisconnect = () => finish(false)
    const onAbort = () => finish(false)
    const timer = setTimeout(() => finish(false), 10_000)
    timer.unref()
    child.on("message", onMessage)
    child.once("exit", onExit)
    child.once("disconnect", onDisconnect)
    signal?.addEventListener("abort", onAbort, { once: true })
    if (signal?.aborted) finish(false)
  })
}

function sendRuntimeMessage(
  child: ChildProcess,
  message: Record<string, unknown>,
): Promise<boolean> {
  if (!child.send || !child.connected) return Promise.resolve(false)
  return new Promise((resolve) => {
    child.send?.(message, (error) => resolve(!error))
  })
}

function runtimeActivationTuple(
  config: DeployConfig,
  launchId: string,
  activationFence: string,
  lease: HttpActivationLease,
): Record<string, unknown> {
  return {
    statePath: getConfigPath(),
    launchId,
    activationFence,
    botName: config.botName,
    engine: config.engine,
    runtime: config.runtime,
    packageName: config.package?.name,
    packageVersion: config.package?.version,
    packageDigest: config.package?.digest,
    host: config.endpoint?.host,
    port: config.endpoint?.port,
    askPath: config.endpoint?.askPath,
    healthPath: config.endpoint?.healthPath,
    lockNonce: lease.nonce,
    lockDevice: lease.device,
    lockInode: lease.inode,
    lockOwnerPid: lease.ownerPid,
  }
}

function exactActivationAck(
  message: Record<string, unknown>,
  phase: string,
  stateDigest: string,
  tuple: Record<string, unknown>,
): boolean {
  const expected = {
    type: "deploy-http-runtime-activation-ack",
    phase,
    stateDigest,
    ...tuple,
  }
  return exactRuntimeMessage(message, expected)
}

function exactRuntimeMessage(
  message: Record<string, unknown>,
  expected: Record<string, unknown>,
): boolean {
  const keys = Object.keys(expected)
  return Object.keys(message).length === keys.length &&
    keys.every((key) => message[key] === expected[key])
}

function processExists(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String(error.code)
      : undefined
    if (code === "ESRCH") return false
    if (code === "EPERM") return true
    return undefined
  }
}

async function processArguments(pid: number): Promise<string[] | undefined> {
  if (process.platform === "linux") {
    try {
      const bytes = await readFile(`/proc/${pid}/cmdline`)
      if (bytes.length === 0 || bytes.length > 64 * 1024) return undefined
      const values = bytes.toString("utf8").split("\0")
      if (values.at(-1) === "") values.pop()
      return values.length > 0 ? values : undefined
    } catch {
      return undefined
    }
  }
  if (!["darwin", "freebsd", "openbsd"].includes(process.platform)) {
    return undefined
  }
  return new Promise((resolve) => {
    execFile(
      "/bin/ps",
      ["-ww", "-p", String(pid), "-o", "command="],
      { timeout: 1_000, maxBuffer: 64 * 1024, encoding: "utf8" },
      (error, stdout) => {
        if (error) {
          resolve(undefined)
          return
        }
        const command = stdout.trim()
        resolve(command ? [command] : undefined)
      },
    )
  })
}

async function trackedProcessArgvMatches(config: DeployConfig): Promise<boolean> {
  const processState = config.process
  if (!processState?.launchId) return false
  const invocation = httpRuntimeInvocation(
    processState.launchId,
    processState.activationFence,
    config,
  )
  const expected = [invocation.command, ...invocation.args]
  const observed = await processArguments(processState.pid)
  if (!observed) return false
  if (process.platform === "linux") {
    return observed.length === expected.length &&
      observed.every((value, index) => value === expected[index])
  }
  return observed.length === 1 && observed[0] === expected.join(" ")
}

export async function inspectHttpDeployment(
  config: DeployConfig,
): Promise<"ready" | "starting" | "stale" | "absent" | "unverified"> {
  if (!config.endpoint || !config.process?.launchId) {
    return config.process && processExists(config.process.pid) !== false
      ? "unverified"
      : "absent"
  }
  if (config.process.activationState !== "authorized") return "unverified"
  const exists = processExists(config.process.pid)
  if (exists === false) return "absent"
  if (exists === undefined || !await trackedProcessArgvMatches(config)) {
    return "unverified"
  }
  const [readiness, authorizationBound] = await Promise.all([
    readHttpReadiness(config.endpoint, 500),
    hasExactHttpAuthorizationBinding(config, 500),
  ])
  return authorizationBound && readinessMatches(readiness, config, {
    pid: config.process.pid,
    launchId: config.process.launchId,
    activationFence: config.process.activationFence,
  })
    ? "ready"
    : Date.now() - Date.parse(config.process.startedAt) <= 15_000
      ? "starting"
      : "stale"
}

export async function readbackHttpDeployment(
  config: DeployConfig,
): Promise<boolean> {
  return await inspectHttpDeployment(config) === "ready"
}

export async function deployHttp(
  config: DeployConfig,
  {
    signal,
    readinessTimeoutMs = 8_000,
    onProcessStarted,
    assertLockOwned,
    activationLease,
  }: ChannelDeployContext = {},
): Promise<ChannelDeployResult> {
  if (!config.endpoint || !config.package || !config.engine || !config.runtime) {
    return outcome("failed", "http_deploy_state_invalid", t("deploy.error_state_invalid"))
  }
  if (config.runtime !== "agent-native") {
    return outcome(
      "unsupported",
      "http_standalone_runtime_not_available",
      t("deploy.guidance_standalone_unsupported"),
    )
  }
  const tokenReference = config.secretReferences?.httpTokenEnv
  const httpToken = tokenReference === "DIGITAL_EMPLOYEE_HTTP_TOKEN"
    ? process.env[tokenReference]?.trim()
    : undefined
  if (
    !httpToken ||
    httpToken.length > 8_192 ||
    /[\u0000-\u001f\u007f]/.test(httpToken)
  ) {
    return outcome(
      "failed",
      "http_token_required",
      t("deploy.error_state_invalid"),
    )
  }
  if (signal?.aborted) {
    return outcome("failed", "deploy_interrupted", t("deploy.error_interrupted"))
  }
  if (
    !activationLease ||
    !Number.isInteger(activationLease.fileDescriptor) ||
    activationLease.fileDescriptor < 0 ||
    !activationLease.nonce.match(/^[a-f0-9]{32}$/) ||
    !Number.isSafeInteger(activationLease.device) ||
    !Number.isSafeInteger(activationLease.inode) ||
    activationLease.ownerPid !== process.pid
  ) {
    return outcome("failed", "deploy_lock_lease_invalid", t("deploy.error_state_invalid"))
  }
  try {
    await assertLockOwned?.()
  } catch {
    return outcome("failed", "deploy_lock_not_owned", t("deploy.error_state_invalid"))
  }

  const launchId = randomBytes(16).toString("hex")
  const activationFence = randomBytes(16).toString("hex")
  const activationTuple = runtimeActivationTuple(
    config,
    launchId,
    activationFence,
    activationLease,
  )
  const invocation = httpRuntimeInvocation(launchId, activationFence, config)
  let child: ChildProcess
  try {
    child = spawn(invocation.command, invocation.args, {
      detached: true,
      env: buildHttpRuntimeEnvironment(config),
      stdio: [
        "ignore",
        "ignore",
        "ignore",
        "ipc",
        activationLease.fileDescriptor,
      ],
      windowsHide: true,
    })
  } catch {
    return outcome("failed", "http_process_start_failed", t("deploy.error_process_start"))
  }
  if (!child.pid) {
    try {
      await assertLockOwned?.()
      await terminateSpawnedProcess(child)
    } catch {
      // Without lock ownership the process boundary is fail-closed.
    }
    return outcome("failed", "http_process_start_failed", t("deploy.error_process_start"))
  }

  const startedAt = new Date().toISOString()
  let processState: DeployProcessState = {
    pid: child.pid,
    startedAt,
    launchId,
    activationFence,
    activationState: "prepared",
  }
  let exited = false
  child.once("exit", () => {
    exited = true
  })
  const activationRequest = waitForRuntimeMessage(
    child,
    (message) => exactRuntimeMessage(message, {
      type: "deploy-http-runtime-awaiting-activation",
      ...activationTuple,
    }),
    signal,
  )
  let termination: Promise<boolean> | undefined
  let authorizedDigest: string | undefined
  let finalization: Promise<boolean> | undefined
  let leaseRelease: Promise<HttpReleaseResult> | undefined
  let releaseSent = false
  const cleanup = () => {
    // Once release was enqueued, the child may already have validated durable
    // Ready, closed fd4, and become autonomous even if its ACK is lost. The
    // parent must never signal across that irreversible boundary.
    if (releaseSent) return Promise.resolve(false)
    termination ??= (async () => {
      try {
        await assertLockOwned?.()
      } catch {
        return false
      }
      return terminateSpawnedProcess(child)
    })()
    return termination
  }
  const cleanupUnverified = (): ChannelDeployResult => ({
    outcome: "pending_external_action",
    steps: [],
    code: "http_cleanup_unverified",
    guidance: t("deploy.error_http_readiness"),
    endpoint: config.endpoint,
    process: processState,
    cleanup,
  })
  const abort = () => {
    void cleanup()
  }
  signal?.addEventListener("abort", abort, { once: true })
  try {
    try {
      const preparedDigest = await onProcessStarted?.(processState)
      if (!preparedDigest?.match(/^[a-f0-9]{64}$/)) {
        throw new TypeError("http_process_state_generation_missing")
      }
      if (!await activationRequest || signal?.aborted) {
        if (!await cleanup()) return cleanupUnverified()
        return outcome(
          "failed",
          signal?.aborted ? "deploy_interrupted" : "http_process_activation_failed",
          signal?.aborted
            ? t("deploy.error_interrupted")
            : t("deploy.error_process_start"),
        )
      }
      await assertLockOwned?.()
      const preparedAck = waitForRuntimeMessage(
        child,
        (message) => exactActivationAck(
          message,
          "prepared",
          preparedDigest,
          activationTuple,
        ),
        signal,
      )
      if (!await sendRuntimeMessage(child, {
        type: "deploy-http-runtime-activation",
        phase: "prepare",
        stateDigest: preparedDigest,
        ...activationTuple,
      }) || !await preparedAck || signal?.aborted) {
        throw new TypeError("http_process_prepare_ack_failed")
      }

      processState = { ...processState, activationState: "authorized" }
      authorizedDigest = await onProcessStarted?.(processState)
      if (!authorizedDigest?.match(/^[a-f0-9]{64}$/)) {
        throw new TypeError("http_process_state_generation_missing")
      }
      const committedDigest = authorizedDigest
      await assertLockOwned?.()
      const authorizedAck = waitForRuntimeMessage(
        child,
        (message) => exactActivationAck(
          message,
          "authorized",
          committedDigest,
          activationTuple,
        ),
        signal,
      )
      if (!await sendRuntimeMessage(child, {
        type: "deploy-http-runtime-activation",
        phase: "commit",
        stateDigest: committedDigest,
        ...activationTuple,
      }) || !await authorizedAck || signal?.aborted) {
        throw new TypeError("http_process_authorized_ack_failed")
      }
      await assertLockOwned?.()
      const readyToListenAck = waitForRuntimeMessage(
        child,
        (message) => exactActivationAck(
          message,
          "ready-to-listen",
          committedDigest,
          activationTuple,
        ),
        signal,
      )
      if (!await sendRuntimeMessage(child, {
        type: "deploy-http-runtime-activation",
        phase: "activate",
        stateDigest: committedDigest,
        ...activationTuple,
      }) || !await readyToListenAck || signal?.aborted) {
        throw new TypeError("http_process_ready_to_listen_ack_failed")
      }
      await assertLockOwned?.()
      const listeningAck = waitForRuntimeMessage(
        child,
        (message) => exactActivationAck(
          message,
          "listening",
          committedDigest,
          activationTuple,
        ),
        signal,
      )
      if (!await sendRuntimeMessage(child, {
        type: "deploy-http-runtime-activation",
        phase: "listen",
        stateDigest: committedDigest,
        ...activationTuple,
      }) || !await listeningAck || signal?.aborted) {
        throw new TypeError("http_process_listening_ack_failed")
      }
      await assertLockOwned?.()
    } catch (error) {
      if (!await cleanup()) return cleanupUnverified()
      // A missing listening ack means the runtime child never bound the
      // endpoint — most often because the requested port is already in use.
      // Tell the user that instead of the misleading state-write sentence.
      const listenFailed = error instanceof TypeError &&
        error.message === "http_process_listening_ack_failed"
      return outcome(
        "failed",
        "http_process_state_write_failed",
        listenFailed
          ? t("deploy.error_http_listen_failed")
          : t("deploy.error_state_write", { code: "http_process_state_write_failed" }),
      )
    }
    const finalize = (stateDigest: string): Promise<boolean> => {
      finalization ??= (async () => {
        if (!stateDigest.match(/^[a-f0-9]{64}$/) || signal?.aborted) return false
        try {
          await assertLockOwned?.()
        } catch {
          return false
        }
        const detachedAck = waitForRuntimeMessage(
          child,
          (message) => exactActivationAck(
            message,
            "detached",
            stateDigest,
            activationTuple,
          ),
          signal,
        )
        if (!await sendRuntimeMessage(child, {
          type: "deploy-http-runtime-activation",
          phase: "detach",
          stateDigest,
          ...activationTuple,
        }) || !await detachedAck || signal?.aborted) {
          return false
        }
        try {
          await assertLockOwned?.()
          return true
        } catch {
          return false
        }
      })()
      return finalization
    }
    const release = (stateDigest: string): Promise<HttpReleaseResult> => {
      leaseRelease ??= (async () => {
        const notSent = { sent: false, acknowledged: false }
        if (!stateDigest.match(/^[a-f0-9]{64}$/) || signal?.aborted) {
          return notSent
        }
        try {
          await assertLockOwned?.()
          const releasedAck = waitForRuntimeMessage(
            child,
            (message) => exactActivationAck(
              message,
              "released",
              stateDigest,
              activationTuple,
            ),
            signal,
          )
          const sent = await sendRuntimeMessage(child, {
            type: "deploy-http-runtime-activation",
            phase: "release",
            stateDigest,
            ...activationTuple,
          })
          if (!sent) return notSent
          releaseSent = true
          child.unref()
          const acknowledged = await releasedAck
          if (!acknowledged || signal?.aborted) {
            return { sent: true, acknowledged: false }
          }
          await assertLockOwned?.()
          return { sent: true, acknowledged: true }
        } catch {
          return releaseSent
            ? { sent: true, acknowledged: false }
            : notSent
        }
      })()
      return leaseRelease
    }
    const deadline = Date.now() + readinessTimeoutMs
    while (!exited && !signal?.aborted && Date.now() < deadline) {
      let readiness: Awaited<ReturnType<typeof readHttpReadiness>>
      try {
        await assertLockOwned?.()
        const observation = await Promise.all([
          readHttpReadiness(config.endpoint, 400),
          hasExactHttpAuthorizationBinding(config, 400),
        ])
        readiness = observation[0]
        await assertLockOwned?.()
        if (!observation[1]) {
          await delay(100, undefined, { signal }).catch(() => undefined)
          continue
        }
      } catch {
        break
      }
      if (readinessMatches(readiness, config, {
        pid: child.pid,
        launchId,
        activationFence,
      })) {
        return {
          outcome: "ready",
          steps: [t("deploy.step_http_ready", { port: String(config.endpoint.port) })],
          endpoint: config.endpoint,
          process: processState,
          cleanup,
          finalize,
          release,
        }
      }
      await delay(100, undefined, { signal }).catch(() => undefined)
    }
  } finally {
    signal?.removeEventListener("abort", abort)
  }
  if (!await cleanup()) return cleanupUnverified()
  return outcome(
    "failed",
    signal?.aborted ? "deploy_interrupted" : "http_readiness_failed",
    signal?.aborted
      ? t("deploy.error_interrupted")
      : t("deploy.error_http_readiness"),
  )
}

export function endpointUrl(endpoint: DeployEndpoint): string {
  return `http://${endpoint.host}:${endpoint.port}${endpoint.askPath}`
}
