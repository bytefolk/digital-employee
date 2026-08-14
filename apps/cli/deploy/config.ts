/**
 * Secret-safe deploy state persistence.
 *
 * The ordinary state file contains only local package binding metadata and
 * secret references. Raw credentials are never accepted by this schema.
 */

import { constants as fsConstants, existsSync } from "node:fs"
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import {
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { createHash, randomBytes } from "node:crypto"
import { homedir } from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { getAvailableLocales } from "./i18n.js"
import type { SupportedLocale } from "./i18n.js"

export const DEPLOY_STATE_SCHEMA_VERSION = "deploy-state.v1" as const

export type DeployRuntime = "agent-native" | "standalone-v1"
export type DeployOutcome =
  | "ready"
  | "pending_external_action"
  | "unsupported"
  | "failed"

export interface DeployPackageBinding {
  name: string
  version: string
  digest: string
  /** Minimum restart-only local reference. Never emit this in normal output. */
  localReference: string
}

export interface DeployEndpoint {
  protocol: "http"
  host: "127.0.0.1"
  port: number
  askPath: "/v1/ask"
  healthPath: "/health"
}

export interface DeployProcessState {
  pid: number
  startedAt: string
  launchId: string
  activationFence: string
  activationState: "prepared" | "authorized"
}

export interface DeployProviderScope {
  kind: "dingtalk-provider-scope.v1"
  digest: `sha256:${string}`
}

export interface DeployProviderState {
  kind: "dingtalk-app"
  resourceId: string
  scope: DeployProviderScope
}

export interface DeployProviderOperation {
  kind: "dingtalk-app-create"
  operationId: string
  name: string
  attemptedAt: string
  scope: DeployProviderScope
}

export interface DeployConfig {
  schemaVersion?: typeof DEPLOY_STATE_SCHEMA_VERSION
  locale?: SupportedLocale
  channel?: string
  botName?: string
  engine?: string
  runtime?: DeployRuntime
  package?: DeployPackageBinding
  outcome?: DeployOutcome
  endpoint?: DeployEndpoint
  process?: DeployProcessState
  provider?: DeployProviderState
  providerOperation?: DeployProviderOperation
  secretReferences?: {
    httpTokenEnv?: "DIGITAL_EMPLOYEE_HTTP_TOKEN"
    openaiApiKeyEnv?: "OPENAI_API_KEY"
  }
  code?: string
  deployedAt?: string
  updatedAt?: string
}

export type DeployConfigFingerprint =
  | { kind: "missing" }
  | {
      kind: "present"
      device: number
      inode: number
      size: number
      modifiedAtMs: number
      changedAtMs: number
      digest: string
    }

export interface DeployConfigSnapshot {
  config: DeployConfig
  fingerprint: DeployConfigFingerprint
}

export interface DeployConfigReadHooks {
  /** Internal deterministic race-test barrier; production callers omit it. */
  afterHandleRead?: () => void | Promise<void>
}

function configDir(): string {
  return path.join(homedir(), ".digital-employee")
}

export function getConfigDir(): string {
  return configDir()
}

export function getConfigPath(): string {
  return path.join(configDir(), "config.json")
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
  )
}

function optionalString(value: unknown, maxLength = 2_000): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : undefined
}

function invalidConfig(code: string): never {
  throw new TypeError(code)
}

function assertKnownConfigKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue
    if (/secret|token|password|credential|api.?key/i.test(key)) {
      invalidConfig(`deploy_config_secret_field_forbidden:${label}.${key}`)
    }
    invalidConfig(`deploy_config_unknown_field:${label}.${key}`)
  }
}

function strictOptionalString(
  value: unknown,
  label: string,
  maxLength = 2_000,
): string | undefined {
  if (value === undefined) return undefined
  const result = optionalString(value, maxLength)
  if (!result) invalidConfig(`deploy_config_invalid_field:${label}`)
  return result
}

function strictIsoDate(value: unknown, label: string): string | undefined {
  const result = strictOptionalString(value, label, 64)
  if (!result) return undefined
  const timestamp = Date.parse(result)
  if (
    Number.isNaN(timestamp) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result) ||
    new Date(timestamp).toISOString() !== result
  ) {
    invalidConfig(`deploy_config_invalid_field:${label}`)
  }
  return result
}

function sanitizeProviderScope(
  value: unknown,
  label: string,
): DeployProviderScope {
  if (value === undefined) {
    invalidConfig("deploy_config_provider_scope_missing")
  }
  if (!isPlainObject(value)) {
    invalidConfig(`deploy_config_invalid_field:${label}`)
  }
  assertKnownConfigKeys(value, ["kind", "digest"], label)
  const digest = strictOptionalString(value.digest, `${label}.digest`, 71)
  if (
    value.kind !== "dingtalk-provider-scope.v1" ||
    !digest?.match(/^sha256:[a-f0-9]{64}$/)
  ) {
    invalidConfig(`deploy_config_invalid_field:${label}`)
  }
  return {
    kind: "dingtalk-provider-scope.v1",
    digest: digest as `sha256:${string}`,
  }
}

/** Validates every persisted byte; unknown or malformed fields fail closed. */
function sanitizeConfig(value: unknown): DeployConfig {
  if (!isPlainObject(value)) invalidConfig("deploy_config_root_must_be_object")
  if (Object.keys(value).length === 0) return {}
  if (value.schemaVersion === undefined) {
    assertKnownConfigKeys(value, ["locale"], "root")
    const locale = strictOptionalString(value.locale, "locale", 256)
    if (locale && !getAvailableLocales().includes(locale)) {
      invalidConfig("deploy_config_locale_unsupported")
    }
    return locale ? { locale } : {}
  }
  if (value.schemaVersion !== DEPLOY_STATE_SCHEMA_VERSION) {
    invalidConfig("deploy_config_schema_unsupported")
  }
  assertKnownConfigKeys(
    value,
    [
      "schemaVersion",
      "locale",
      "channel",
      "botName",
      "engine",
      "runtime",
      "package",
      "outcome",
      "endpoint",
      "process",
      "provider",
      "providerOperation",
      "secretReferences",
      "code",
      "deployedAt",
      "updatedAt",
    ],
    "root",
  )
  const result: DeployConfig = {}
  result.schemaVersion = DEPLOY_STATE_SCHEMA_VERSION
  for (const key of ["locale", "channel", "botName", "engine"] as const) {
    const field = strictOptionalString(value[key], key, 256)
    if (field) result[key] = field
  }
  if (value.runtime === "agent-native" || value.runtime === "standalone-v1") {
    result.runtime = value.runtime
  } else if (value.runtime !== undefined) {
    invalidConfig("deploy_config_invalid_field:runtime")
  }
  if (
    value.outcome === "ready" ||
    value.outcome === "pending_external_action" ||
    value.outcome === "unsupported" ||
    value.outcome === "failed"
  ) {
    result.outcome = value.outcome
  } else if (value.outcome !== undefined) {
    invalidConfig("deploy_config_invalid_field:outcome")
  }
  if (value.package !== undefined) {
    if (!isPlainObject(value.package)) {
      invalidConfig("deploy_config_invalid_field:package")
    }
    assertKnownConfigKeys(
      value.package,
      ["name", "version", "digest", "localReference"],
      "package",
    )
    const name = strictOptionalString(value.package.name, "package.name", 128)
    const version = strictOptionalString(value.package.version, "package.version", 128)
    const digest = strictOptionalString(value.package.digest, "package.digest", 80)
    const localReference = strictOptionalString(
      value.package.localReference,
      "package.localReference",
      4_096,
    )
    if (
      !name ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
      !version ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version) ||
      !digest?.match(/^sha256:[a-f0-9]{64}$/) ||
      !localReference ||
      !path.isAbsolute(localReference) ||
      /[\u0000-\u001f\u007f]/.test(localReference)
    ) {
      invalidConfig("deploy_config_invalid_field:package")
    }
    result.package = { name, version, digest, localReference }
  }
  if (value.endpoint !== undefined) {
    if (!isPlainObject(value.endpoint)) {
      invalidConfig("deploy_config_invalid_field:endpoint")
    }
    assertKnownConfigKeys(
      value.endpoint,
      ["protocol", "host", "port", "askPath", "healthPath"],
      "endpoint",
    )
    const port = value.endpoint.port
    if (
      value.endpoint.protocol === "http" &&
      value.endpoint.host === "127.0.0.1" &&
      Number.isInteger(port) &&
      Number(port) >= 1 &&
      Number(port) <= 65_535 &&
      value.endpoint.askPath === "/v1/ask" &&
      value.endpoint.healthPath === "/health"
    ) {
      result.endpoint = {
        protocol: "http",
        host: "127.0.0.1",
        port: Number(port),
        askPath: "/v1/ask",
        healthPath: "/health",
      }
    } else {
      invalidConfig("deploy_config_invalid_field:endpoint")
    }
  }
  if (value.process !== undefined) {
    if (!isPlainObject(value.process)) {
      invalidConfig("deploy_config_invalid_field:process")
    }
    assertKnownConfigKeys(
      value.process,
      ["pid", "startedAt", "launchId", "activationFence", "activationState"],
      "process",
    )
    const pid = value.process.pid
    const startedAt = strictIsoDate(value.process.startedAt, "process.startedAt")
    const launchId = strictOptionalString(
      value.process.launchId,
      "process.launchId",
      32,
    )
    const activationFence = strictOptionalString(
      value.process.activationFence,
      "process.activationFence",
      32,
    )
    if (
      !Number.isSafeInteger(pid) ||
      Number(pid) <= 0 ||
      !startedAt ||
      !launchId?.match(/^[a-f0-9]{32}$/) ||
      !activationFence?.match(/^[a-f0-9]{32}$/) ||
      (value.process.activationState !== "prepared" &&
        value.process.activationState !== "authorized")
    ) {
      invalidConfig("deploy_config_invalid_field:process")
    }
    result.process = {
      pid: Number(pid),
      startedAt,
      launchId,
      activationFence,
      activationState: value.process.activationState,
    }
  }
  if (value.provider !== undefined) {
    if (!isPlainObject(value.provider)) {
      invalidConfig("deploy_config_invalid_field:provider")
    }
    assertKnownConfigKeys(
      value.provider,
      ["kind", "resourceId", "scope"],
      "provider",
    )
    const resourceId = strictOptionalString(
      value.provider.resourceId,
      "provider.resourceId",
      256,
    )
    if (
      value.provider.kind !== "dingtalk-app" ||
      !resourceId ||
      /[\u0000-\u001f\u007f]/.test(resourceId)
    ) {
      invalidConfig("deploy_config_invalid_field:provider")
    }
    result.provider = {
      kind: "dingtalk-app",
      resourceId,
      scope: sanitizeProviderScope(value.provider.scope, "provider.scope"),
    }
  }
  if (value.providerOperation !== undefined) {
    if (!isPlainObject(value.providerOperation)) {
      invalidConfig("deploy_config_invalid_field:providerOperation")
    }
    assertKnownConfigKeys(
      value.providerOperation,
      ["kind", "operationId", "name", "attemptedAt", "scope"],
      "providerOperation",
    )
    const operationId = strictOptionalString(
      value.providerOperation.operationId,
      "providerOperation.operationId",
      32,
    )
    const name = strictOptionalString(
      value.providerOperation.name,
      "providerOperation.name",
      128,
    )
    const attemptedAt = strictIsoDate(
      value.providerOperation.attemptedAt,
      "providerOperation.attemptedAt",
    )
    if (
      value.providerOperation.kind !== "dingtalk-app-create" ||
      !operationId?.match(/^[a-f0-9]{32}$/) ||
      !name ||
      !attemptedAt
    ) {
      invalidConfig("deploy_config_invalid_field:providerOperation")
    }
    result.providerOperation = {
      kind: "dingtalk-app-create",
      operationId,
      name,
      attemptedAt,
      scope: sanitizeProviderScope(
        value.providerOperation.scope,
        "providerOperation.scope",
      ),
    }
  }
  if (value.secretReferences !== undefined) {
    if (!isPlainObject(value.secretReferences)) {
      invalidConfig("deploy_config_invalid_field:secretReferences")
    }
    assertKnownConfigKeys(
      value.secretReferences,
      ["httpTokenEnv", "openaiApiKeyEnv"],
      "secretReferences",
    )
    const secretReferences: NonNullable<DeployConfig["secretReferences"]> = {}
    if (value.secretReferences.httpTokenEnv === "DIGITAL_EMPLOYEE_HTTP_TOKEN") {
      secretReferences.httpTokenEnv = "DIGITAL_EMPLOYEE_HTTP_TOKEN"
    }
    if (value.secretReferences.openaiApiKeyEnv === "OPENAI_API_KEY") {
      secretReferences.openaiApiKeyEnv = "OPENAI_API_KEY"
    }
    if (
      value.secretReferences.httpTokenEnv !== undefined &&
      value.secretReferences.httpTokenEnv !== "DIGITAL_EMPLOYEE_HTTP_TOKEN"
    ) {
      invalidConfig("deploy_config_invalid_field:secretReferences.httpTokenEnv")
    }
    if (
      value.secretReferences.openaiApiKeyEnv !== undefined &&
      value.secretReferences.openaiApiKeyEnv !== "OPENAI_API_KEY"
    ) {
      invalidConfig("deploy_config_invalid_field:secretReferences.openaiApiKeyEnv")
    }
    if (Object.keys(secretReferences).length > 0) {
      result.secretReferences = secretReferences
    }
  }
  const code = strictOptionalString(value.code, "code", 128)
  if (code && !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(code)) {
    invalidConfig("deploy_config_invalid_field:code")
  }
  if (code) result.code = code
  const deployedAt = strictIsoDate(value.deployedAt, "deployedAt")
  if (deployedAt) result.deployedAt = deployedAt
  const updatedAt = strictIsoDate(value.updatedAt, "updatedAt")
  if (updatedAt) result.updatedAt = updatedAt
  if (
    !result.locale ||
    !result.channel ||
    !result.botName ||
    !result.engine ||
    !result.runtime ||
    !result.package ||
    !result.outcome ||
    !result.updatedAt
  ) {
    invalidConfig("deploy_config_incomplete")
  }
  const channels = ["dingtalk", "lark", "wecom", "console", "http"]
  const agentEngines = ["claude-code", "qoder", "qwen-code", "codebuddy"]
  if (!channels.includes(result.channel)) {
    invalidConfig("deploy_config_channel_unsupported")
  }
  if (result.runtime !== "agent-native") {
    invalidConfig("deploy_config_runtime_unsupported")
  }
  if (!agentEngines.includes(result.engine)) {
    invalidConfig("deploy_config_engine_unsupported")
  }
  if (!getAvailableLocales().includes(result.locale)) {
    invalidConfig("deploy_config_locale_unsupported")
  }
  if (
    result.botName.length > 128 ||
    result.botName.trim() !== result.botName ||
    /[\u0000-\u001f\u007f]/.test(result.botName)
  ) {
    invalidConfig("deploy_config_bot_name_invalid")
  }
  if ((result.channel === "http") !== Boolean(result.endpoint)) {
    invalidConfig("deploy_config_endpoint_channel_mismatch")
  }
  if (result.process && result.channel !== "http") {
    invalidConfig("deploy_config_process_channel_mismatch")
  }
  if (result.provider && result.channel !== "dingtalk") {
    invalidConfig("deploy_config_provider_channel_mismatch")
  }
  if (
    result.providerOperation &&
    (
      result.channel !== "dingtalk" ||
      result.providerOperation.name !== result.botName ||
      result.provider
    )
  ) {
    invalidConfig("deploy_config_provider_operation_mismatch")
  }
  const allowedOutcomes = result.channel === "http"
    ? ["pending_external_action", "ready", "failed"]
    : result.channel === "lark" || result.channel === "wecom"
      ? ["unsupported", "failed"]
      : ["pending_external_action", "failed"]
  if (!allowedOutcomes.includes(result.outcome)) {
    invalidConfig("deploy_config_outcome_channel_mismatch")
  }
  if (result.outcome === "ready" && !result.process) {
    invalidConfig("deploy_config_ready_process_missing")
  }
  if (
    result.outcome === "ready" &&
    result.process?.activationState !== "authorized"
  ) {
    invalidConfig("deploy_config_ready_process_not_authorized")
  }
  if (
    result.process &&
    result.outcome !== "ready" &&
    result.outcome !== "pending_external_action"
  ) {
    invalidConfig("deploy_config_process_outcome_mismatch")
  }
  if ((result.outcome === "ready") !== Boolean(result.deployedAt)) {
    invalidConfig("deploy_config_deployed_at_outcome_mismatch")
  }
  if (result.secretReferences?.httpTokenEnv && result.channel !== "http") {
    invalidConfig("deploy_config_http_secret_channel_mismatch")
  }
  if (result.secretReferences?.openaiApiKeyEnv) {
    invalidConfig("deploy_config_openai_reference_unsupported")
  }
  return result
}

function fileErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined
}

async function validatePrivateConfigDirectory(
  directory: string,
  allowMissing: boolean,
): Promise<boolean> {
  let parent
  try {
    parent = await lstat(directory)
  } catch (error) {
    if (allowMissing && fileErrorCode(error) === "ENOENT") return false
    throw new TypeError(
      `deploy_config_directory_invalid:${fileErrorCode(error) ?? "unknown"}`,
    )
  }
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new TypeError("deploy_config_directory_must_be_private_directory")
  }
  if ((parent.mode & 0o777) !== 0o700) {
    throw new TypeError("deploy_config_directory_permissions_unsafe")
  }
  if (typeof process.getuid === "function" && parent.uid !== process.getuid()) {
    throw new TypeError("deploy_config_directory_owner_mismatch")
  }
  return true
}

export async function loadConfigSnapshotFromPath(
  configPath: string,
  hooks: DeployConfigReadHooks = {},
): Promise<DeployConfigSnapshot> {
  let before
  try {
    before = await lstat(configPath)
  } catch (error) {
    if (fileErrorCode(error) === "ENOENT") {
      await validatePrivateConfigDirectory(path.dirname(configPath), true)
      return { config: {}, fingerprint: { kind: "missing" } }
    }
    throw new TypeError(`deploy_config_read_failed:${fileErrorCode(error) ?? "unknown"}`)
  }
  if (before.isSymbolicLink()) {
    throw new TypeError("deploy_config_symlink_not_allowed")
  }
  if (!before.isFile()) throw new TypeError("deploy_config_must_be_regular_file")
  if (before.size > 1024 * 1024) {
    throw new TypeError("deploy_config_too_large")
  }
  if ((before.mode & 0o777) !== 0o600) {
    throw new TypeError("deploy_config_permissions_unsafe")
  }
  if (typeof process.getuid === "function" && before.uid !== process.getuid()) {
    throw new TypeError("deploy_config_owner_mismatch")
  }
  await validatePrivateConfigDirectory(path.dirname(configPath), false)

  let handle: FileHandle | undefined
  try {
    handle = await open(
      configPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    )
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeMs !== before.mtimeMs ||
      opened.ctimeMs !== before.ctimeMs
    ) {
      throw new TypeError("deploy_config_changed_during_read")
    }
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (
      bytes.length !== opened.size ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    ) {
      throw new TypeError("deploy_config_changed_during_read")
    }
    await hooks.afterHandleRead?.()
    let parsed: unknown
    try {
      parsed = JSON.parse(bytes.toString("utf8")) as unknown
    } catch {
      throw new TypeError("deploy_config_malformed_json")
    }
    const config = sanitizeConfig(parsed)
    let published
    try {
      published = await lstat(configPath)
    } catch {
      throw new TypeError("deploy_config_changed_during_read")
    }
    if (
      published.isSymbolicLink() ||
      !published.isFile() ||
      published.dev !== after.dev ||
      published.ino !== after.ino ||
      published.size !== after.size ||
      published.mtimeMs !== after.mtimeMs ||
      published.ctimeMs !== after.ctimeMs ||
      (published.mode & 0o777) !== (after.mode & 0o777) ||
      (typeof process.getuid === "function" && published.uid !== after.uid)
    ) {
      throw new TypeError("deploy_config_changed_during_read")
    }
    return {
      config,
      fingerprint: {
        kind: "present",
        device: after.dev,
        inode: after.ino,
        size: after.size,
        modifiedAtMs: after.mtimeMs,
        changedAtMs: after.ctimeMs,
        digest: createHash("sha256").update(bytes).digest("hex"),
      },
    }
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith("deploy_config_")) {
      throw error
    }
    throw new TypeError(`deploy_config_read_failed:${fileErrorCode(error) ?? "unknown"}`)
  } finally {
    await handle?.close()
  }
}

export async function loadConfigFromPath(configPath: string): Promise<DeployConfig> {
  return (await loadConfigSnapshotFromPath(configPath)).config
}

export function loadConfigSnapshot(): Promise<DeployConfigSnapshot> {
  return loadConfigSnapshotFromPath(getConfigPath())
}

export function loadConfig(): Promise<DeployConfig> {
  return loadConfigFromPath(getConfigPath())
}

async function ensurePrivateConfigDirectory(directory: string): Promise<void> {
  if (!await validatePrivateConfigDirectory(directory, true)) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await validatePrivateConfigDirectory(directory, false)
  }
}

interface LockRecord {
  schemaVersion: "deploy-lock.v3"
  pid: number
  nonce: string
  ownerStartedAt: string
  createdAt: string
}

export interface DeploymentLock {
  contended: boolean
  readonly fileDescriptor: number
  readonly nonce: string
  readonly device: number
  readonly inode: number
  assertOwned(): Promise<void>
  release(): Promise<void>
}

export interface DeploymentLockHooks {
  afterKernelAcquire?: () => void | Promise<void>
  /** Internal deterministic process-supervision fault injection. */
  lockUtilityInvocation?: (
    timeoutMs: number,
    nonBlocking: boolean,
  ) => { command: string; args: string[] } | undefined
  /** Internal test-only cap; production always uses the fixed probe watchdog. */
  probeWatchdogTimeoutMs?: number
  /** Internal deterministic observation point after one helper is supervised. */
  onLockUtilitySpawn?: (context: {
    attempt: number
    decisionDeadline: number
    fileDescriptor: number
    pid: number | undefined
    remainingMs: number
    watchdogMs: number
  }) => unknown
}

type LockHolderAttempt =
  | { outcome: "acquired" }
  | { outcome: "contended"; conflictCode: 1 | 75 }
  | { outcome: "watchdog" }

const LOCK_PROBE_WATCHDOG_MS = 4_000
const LOCK_RETRY_DELAY_MS = 100
const LOCK_UTILITY_TERMINATION_GRACE_MS = 1_000

function getLockPath(): string {
  return path.join(configDir(), ".deploy.lock")
}

function lockUtilityInvocation(
  timeoutMs: number,
  nonBlocking: boolean,
): { command: string; args: string[] } {
  const seconds = String(Math.max(1, Math.ceil(timeoutMs / 1_000)))
  if (process.platform === "linux") {
    return {
      command: existsSync("/usr/bin/flock") ? "/usr/bin/flock" : "/bin/flock",
      args: [
        ...(nonBlocking ? ["-n"] : ["-w", seconds]),
        "3",
      ],
    }
  }
  if (["darwin", "freebsd", "openbsd"].includes(process.platform)) {
    return {
      command: "/usr/bin/lockf",
      args: [
        "-s",
        "-t",
        nonBlocking ? "0" : seconds,
        "3",
      ],
    }
  }
  throw new Error("deploy_lock_primitive_unavailable")
}

function acquireFileDescriptorLock(
  fileDescriptor: number,
  watchdogMs: number,
  nonBlocking: boolean,
  signal: AbortSignal | undefined,
  context: {
    attempt: number
    decisionDeadline: number
    remainingMs: number
  },
  hooks: Pick<
    DeploymentLockHooks,
    "lockUtilityInvocation" | "onLockUtilitySpawn"
  > = {},
): Promise<LockHolderAttempt> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("deploy_lock_interrupted"))
      return
    }
    let invocation
    try {
      invocation = hooks.lockUtilityInvocation?.(watchdogMs, nonBlocking) ??
        lockUtilityInvocation(watchdogMs, nonBlocking)
    } catch (error) {
      reject(new Error(
        signal?.aborted
          ? "deploy_lock_interrupted"
          : error instanceof Error &&
              error.message === "deploy_lock_primitive_unavailable"
          ? "deploy_lock_primitive_unavailable"
          : "deploy_lock_primitive_failed",
      ))
      return
    }
    if (signal?.aborted) {
      reject(new Error("deploy_lock_interrupted"))
      return
    }
    const remainingAfterInvocation = Math.floor(
      context.decisionDeadline - performance.now(),
    )
    if (remainingAfterInvocation <= 0) {
      reject(new Error("deploy_lock_timeout"))
      return
    }
    const effectiveWatchdogMs = Math.min(watchdogMs, remainingAfterInvocation)
    let child: ChildProcess
    try {
      child = spawn(invocation.command, invocation.args, {
        stdio: ["ignore", "ignore", "ignore", fileDescriptor],
        windowsHide: true,
      })
    } catch {
      reject(new Error("deploy_lock_primitive_unavailable"))
      return
    }
    let settled = false
    let terminationReason: "abort" | "watchdog" | "hook" | undefined
    let spawnFailureCode: string | undefined
    let hookSettlement: Promise<void> | undefined
    let watchdogCheck: ReturnType<typeof setImmediate> | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let termAttempted = false
    let killAttempted = false
    const stopUtility = (reason: NonNullable<typeof terminationReason>) => {
      if (settled) return
      if (reason === "abort") {
        terminationReason = "abort"
      } else if (terminationReason) {
        return
      } else if (reason === "hook") {
        terminationReason = "hook"
      }

      if (child.exitCode !== null || child.signalCode !== null) {
        // The exit status is already observable. Await `close`, which is the
        // only point at which Node has also settled the child lifecycle.
        return
      }
      if (!termAttempted) {
        termAttempted = true
        let signalSent = false
        try {
          signalSent = child.kill("SIGTERM")
        } catch {
          // A terminal helper's real close status remains authoritative.
        }
        if (reason === "watchdog" && signalSent && !terminationReason) {
          terminationReason = "watchdog"
        }
      }
      if (child.exitCode !== null || child.signalCode !== null || killTimer) return
      killTimer = setTimeout(() => {
        if (settled || killAttempted) return
        if (child.exitCode !== null || child.signalCode !== null) return
        killAttempted = true
        let signalSent = false
        try {
          signalSent = child.kill("SIGKILL")
        } catch {
          // The helper became terminal during the fixed cleanup grace.
        }
        if (signalSent && !terminationReason) {
          terminationReason = "watchdog"
        }
      }, LOCK_UTILITY_TERMINATION_GRACE_MS)
      killTimer.unref()
    }
    const timer = setTimeout(() => {
      // Give an already-terminal child a complete poll/check handoff so its
      // real exit/close status wins even when the event loop was delayed.
      watchdogCheck = setImmediate(() => {
        watchdogCheck = setImmediate(() => stopUtility("watchdog"))
      })
    }, effectiveWatchdogMs)
    timer.unref()

    function abort(): void {
      stopUtility("abort")
    }
    function cleanup(): void {
      clearTimeout(timer)
      if (watchdogCheck) clearImmediate(watchdogCheck)
      if (killTimer) clearTimeout(killTimer)
      signal?.removeEventListener("abort", abort)
      child.removeListener("error", handleError)
      child.removeListener("close", handleClose)
    }
    function handleError(error: Error): void {
      spawnFailureCode = fileErrorCode(error)
    }
    async function handleClose(code: number | null): Promise<void> {
      if (settled) return
      settled = true
      cleanup()
      if (hookSettlement) await hookSettlement
      if (signal?.aborted || terminationReason === "abort") {
        reject(new Error("deploy_lock_interrupted"))
        return
      }
      if (context.decisionDeadline - performance.now() <= 0) {
        reject(new Error("deploy_lock_timeout"))
        return
      }
      if (spawnFailureCode) {
        reject(new Error(
          spawnFailureCode === "ENOENT"
            ? "deploy_lock_primitive_unavailable"
            : "deploy_lock_primitive_failed",
        ))
        return
      }
      if (terminationReason === "hook") {
        reject(new Error("deploy_lock_primitive_failed"))
        return
      }
      if (terminationReason === "watchdog") {
        if (!nonBlocking) {
          reject(new Error("deploy_lock_timeout"))
          return
        }
        resolve({ outcome: "watchdog" })
        return
      }
      if (code === 0) {
        resolve({ outcome: "acquired" })
        return
      }
      if (code === 1 || code === 75) {
        resolve({ outcome: "contended", conflictCode: code })
      } else {
        reject(new Error("deploy_lock_primitive_failed"))
      }
    }
    signal?.addEventListener("abort", abort, { once: true })
    child.once("error", handleError)
    child.once("close", handleClose)
    try {
      const hookResult = hooks.onLockUtilitySpawn?.({
        attempt: context.attempt,
        decisionDeadline: context.decisionDeadline,
        fileDescriptor,
        pid: child.pid,
        remainingMs: remainingAfterInvocation,
        watchdogMs: effectiveWatchdogMs,
      })
      if (
        hookResult &&
        (typeof hookResult === "object" || typeof hookResult === "function") &&
        "then" in hookResult
      ) {
        hookSettlement = Promise.resolve(hookResult).then(
          () => undefined,
          () => undefined,
        )
        stopUtility("hook")
      }
    } catch {
      stopUtility("hook")
    }
    if (signal?.aborted) stopUtility("abort")
  })
}

export async function acquireDeploymentLock({
  signal,
  timeoutMs = 20_000,
  hooks = {},
}: {
  signal?: AbortSignal
  timeoutMs?: number
  hooks?: DeploymentLockHooks
} = {}): Promise<DeploymentLock> {
  if (signal?.aborted) throw new Error("deploy_lock_interrupted")
  const acquisitionStartedAt = performance.now()
  const decisionBudgetMs = Number.isFinite(timeoutMs)
    ? Math.max(0, timeoutMs)
    : 0
  const decisionDeadline = acquisitionStartedAt + decisionBudgetMs
  const remainingDecisionMs = (): number => Math.max(
    0,
    decisionDeadline - performance.now(),
  )
  const assertDecisionOpen = (): void => {
    if (signal?.aborted) throw new Error("deploy_lock_interrupted")
    if (remainingDecisionMs() <= 0) throw new Error("deploy_lock_timeout")
  }
  const configuredProbeCap = hooks.probeWatchdogTimeoutMs
  const probeWatchdogCapMs = configuredProbeCap === undefined
    ? LOCK_PROBE_WATCHDOG_MS
    : Number.isFinite(configuredProbeCap) && configuredProbeCap > 0
      ? Math.max(1, Math.min(LOCK_PROBE_WATCHDOG_MS, configuredProbeCap))
      : LOCK_PROBE_WATCHDOG_MS
  const directory = getConfigDir()
  const lockPath = getLockPath()
  await ensurePrivateConfigDirectory(directory)
  assertDecisionOpen()
  const nonce = randomBytes(16).toString("hex")
  let handle: FileHandle | undefined
  try {
    handle = await open(
      lockPath,
      fsConstants.O_RDWR |
        fsConstants.O_CREAT |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    )
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.isSymbolicLink() ||
      opened.nlink !== 1 ||
      (opened.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === "function" && opened.uid !== process.getuid())
    ) {
      throw new Error("deploy_lock_file_unsafe")
    }
    const published = await lstat(lockPath)
    if (
      !published.isFile() ||
      published.isSymbolicLink() ||
      published.dev !== opened.dev ||
      published.ino !== opened.ino
    ) {
      throw new Error("deploy_lock_file_identity_changed")
    }

    let contended = false
    let attemptNumber = 0
    while (true) {
      if (signal?.aborted) throw new Error("deploy_lock_interrupted")
      const remainingBeforeProbe = Math.floor(remainingDecisionMs())
      if (remainingBeforeProbe <= 0) throw new Error("deploy_lock_timeout")
      attemptNumber += 1
      let attempt: LockHolderAttempt
      try {
        attempt = await acquireFileDescriptorLock(
          handle.fd,
          Math.min(probeWatchdogCapMs, remainingBeforeProbe),
          true,
          signal,
          {
            attempt: attemptNumber,
            decisionDeadline,
            remainingMs: remainingBeforeProbe,
          },
          hooks,
        )
      } catch (error) {
        if (signal?.aborted) throw new Error("deploy_lock_interrupted")
        if (remainingDecisionMs() <= 0) throw new Error("deploy_lock_timeout")
        throw error
      }
      if (signal?.aborted) throw new Error("deploy_lock_interrupted")
      if (attempt.outcome === "acquired") {
        if (remainingDecisionMs() <= 0) throw new Error("deploy_lock_timeout")
        break
      }
      if (attempt.outcome === "watchdog") continue
      contended = true
      const remainingBeforeDelay = Math.floor(remainingDecisionMs())
      if (remainingBeforeDelay <= 0) throw new Error("deploy_lock_timeout")
      try {
        await delay(
          Math.min(LOCK_RETRY_DELAY_MS, remainingBeforeDelay),
          undefined,
          { signal },
        )
      } catch {
        throw new Error("deploy_lock_interrupted")
      }
    }
    assertDecisionOpen()
    const lockedPath = await lstat(lockPath)
    if (
      !lockedPath.isFile() ||
      lockedPath.isSymbolicLink() ||
      lockedPath.dev !== opened.dev ||
      lockedPath.ino !== opened.ino ||
      lockedPath.nlink !== 1 ||
      (lockedPath.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === "function" &&
        lockedPath.uid !== process.getuid())
    ) {
      throw new Error("deploy_lock_file_identity_changed")
    }
    if (signal?.aborted) throw new Error("deploy_lock_interrupted")
    if (remainingDecisionMs() <= 0) throw new Error("deploy_lock_timeout")

    const record: LockRecord = {
      schemaVersion: "deploy-lock.v3",
      pid: process.pid,
      nonce,
      ownerStartedAt: new Date(performance.timeOrigin).toISOString(),
      createdAt: new Date().toISOString(),
    }
    assertDecisionOpen()
    await handle.truncate(0)
    assertDecisionOpen()
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8")
    assertDecisionOpen()
    await handle.sync()
    assertDecisionOpen()
    try {
      await hooks.afterKernelAcquire?.()
    } catch (error) {
      if (signal?.aborted) throw new Error("deploy_lock_interrupted")
      throw error
    }
    assertDecisionOpen()
    let released = false
    const assertOwned = async (): Promise<void> => {
      const activeHandle = handle
      if (released || !activeHandle) throw new Error("deploy_lock_not_owned")
      const current = await activeHandle.stat()
      const currentPath = await lstat(lockPath)
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.dev !== opened.dev ||
        current.ino !== opened.ino ||
        current.nlink !== 1 ||
        (current.mode & 0o777) !== 0o600 ||
        !currentPath.isFile() ||
        currentPath.isSymbolicLink() ||
        currentPath.dev !== opened.dev ||
        currentPath.ino !== opened.ino ||
        currentPath.nlink !== 1 ||
        (currentPath.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === "function" &&
          (current.uid !== process.getuid() ||
            currentPath.uid !== process.getuid()))
      ) {
        throw new Error("deploy_lock_not_owned")
      }
      if (current.size < 2 || current.size > 4_096) {
        throw new Error("deploy_lock_record_invalid")
      }
      const bytes = Buffer.alloc(current.size)
      const read = await activeHandle.read(bytes, 0, bytes.length, 0)
      if (read.bytesRead !== bytes.length) {
        throw new Error("deploy_lock_record_invalid")
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(bytes.toString("utf8")) as unknown
      } catch {
        throw new Error("deploy_lock_record_invalid")
      }
      if (
        !isPlainObject(parsed) ||
        parsed.schemaVersion !== "deploy-lock.v3" ||
        parsed.pid !== process.pid ||
        parsed.nonce !== nonce
      ) {
        throw new Error("deploy_lock_record_invalid")
      }
    }
    try {
      await assertOwned()
    } catch (error) {
      if (signal?.aborted) throw new Error("deploy_lock_interrupted")
      throw error
    }
    assertDecisionOpen()
    return {
      contended,
      fileDescriptor: handle.fd,
      nonce,
      device: opened.dev,
      inode: opened.ino,
      assertOwned,
      async release() {
        if (released) return
        released = true
        await handle?.close()
        handle = undefined
      },
    }
  } catch (error) {
    await handle?.close()
    throw error
  }
}

function sameFingerprint(
  left: DeployConfigFingerprint,
  right: DeployConfigFingerprint,
): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === "missing" || right.kind === "missing") return true
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedAtMs === right.modifiedAtMs &&
    left.changedAtMs === right.changedAtMs &&
    left.digest === right.digest
  )
}

export async function saveConfig(
  config: DeployConfig,
  {
    expected,
    lock,
    currentReadHooks,
  }: {
    expected: DeployConfigFingerprint
    lock: Pick<DeploymentLock, "assertOwned">
    /** Internal deterministic race-test hook; production callers omit it. */
    currentReadHooks?: DeployConfigReadHooks
  },
): Promise<DeployConfigFingerprint> {
  const directory = getConfigDir()
  const configPath = getConfigPath()
  await lock.assertOwned()
  await ensurePrivateConfigDirectory(directory)
  const serialized = `${JSON.stringify(sanitizeConfig(config), null, 2)}\n`
  const temporaryPath = path.join(
    directory,
    `.config.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
  )
  let handle
  try {
    handle = await open(temporaryPath, "wx", 0o600)
    await handle.writeFile(serialized, { encoding: "utf8" })
    await handle.sync()
    await handle.close()
    handle = undefined
    await lock.assertOwned()
    const current = (
      await loadConfigSnapshotFromPath(configPath, currentReadHooks)
    ).fingerprint
    if (!sameFingerprint(current, expected)) {
      throw new TypeError("deploy_config_generation_changed")
    }
    await lock.assertOwned()
    await rename(temporaryPath, configPath)
    let directoryHandle: FileHandle | undefined
    try {
      directoryHandle = await open(directory, fsConstants.O_RDONLY)
      await directoryHandle.sync()
    } finally {
      await directoryHandle?.close()
    }
    const verified = await loadConfigSnapshotFromPath(configPath)
    const expectedDigest = createHash("sha256").update(serialized).digest("hex")
    if (
      verified.fingerprint.kind !== "present" ||
      verified.fingerprint.digest !== expectedDigest
    ) {
      throw new TypeError("deploy_config_publish_verification_failed")
    }
    await lock.assertOwned()
    return verified.fingerprint
  } catch (error) {
    try {
      await unlink(temporaryPath)
    } catch (cleanupError) {
      if (fileErrorCode(cleanupError) !== "ENOENT") throw cleanupError
    }
    throw error
  } finally {
    await handle?.close()
  }
}

export async function hasExistingDeployment(): Promise<boolean> {
  const config = await loadConfig()
  return Boolean(config.outcome || config.deployedAt)
}
