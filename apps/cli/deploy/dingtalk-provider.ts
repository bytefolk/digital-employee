/** Strict DingTalk application reconciliation through the current dws CLI. */

import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"

import type {
  DeployProviderOperation,
  DeployProviderState,
} from "./config.js"

const MAX_PROVIDER_OUTPUT_BYTES = 1024 * 1024
const PROVIDER_PAGE_SIZE = 20
const MAX_PROVIDER_PAGES = 20
const MAX_PROVIDER_APPS = PROVIDER_PAGE_SIZE * MAX_PROVIDER_PAGES
const DWS_SOURCE_MODE = import.meta.url.endsWith(".ts")
const DWS_SUPERVISOR_ENTRY = fileURLToPath(
  new URL(
    DWS_SOURCE_MODE ? "./dws-supervisor.ts" : "./dws-supervisor.js",
    import.meta.url,
  ),
)
const ALREADY_EXISTS_CODES = new Set([
  "already_exists",
  "app_already_exists",
  "dev_app_already_exists",
])

interface ProviderObject {
  [key: string]: unknown
}

interface ProviderApp {
  unifiedAppId: string
  name: string
}

export interface DingTalkProviderResult {
  status: "verified" | "confirmation_required" | "indeterminate" | "failed"
  code: string
  provider?: DeployProviderState
}

export interface DingTalkProviderOptions {
  signal?: AbortSignal
  allowWrite?: boolean
  confirmWrite?: () => boolean | Promise<boolean>
  beforeBoundary?: () => void | Promise<void>
  /** Internal fault-test override; production callers use the 30s default. */
  commandTimeoutMs?: number
  existingOperation?: DeployProviderOperation
  onCreateAttempt?: (
    operation: DeployProviderOperation,
  ) => void | Promise<void>
  onProviderIdentified?: (
    provider: DeployProviderState,
  ) => void | Promise<void>
}

interface CommandSuccess {
  ok: true
  value: unknown
}

interface CommandFailure {
  ok: false
  code: string
  explicitProviderCode?: string
  indeterminate?: boolean
}

function isIdentityReadUncertainty(failure: CommandFailure): boolean {
  return Boolean(
    failure.indeterminate ||
      failure.code === "dingtalk_provider_cli_unavailable" ||
      failure.explicitProviderCode?.toLowerCase() === "provider_unavailable",
  )
}

function isObject(value: unknown): value is ProviderObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "NO_COLOR",
    "DWS_CLIENT_ID",
    "DWS_CLIENT_SECRET",
    "DWS_CONFIG_DIR",
    "DWS_DISABLE_KEYCHAIN",
    "DWS_KEYCHAIN_DIR",
  ]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key]
  }
  return environment
}

function parseJson(value: string): unknown | undefined {
  if (!value.trim() || Buffer.byteLength(value) > MAX_PROVIDER_OUTPUT_BYTES) {
    return undefined
  }
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function providerCodeScan(value: unknown): {
  codes: Set<string>
  malformed: boolean
} {
  const codes = new Set<string>()
  let malformed = false
  if (!isObject(value)) return { codes, malformed }
  const error = isObject(value.error) ? value.error : undefined
  const add = (candidate: unknown, present: boolean) => {
    if (!present) return
    if (typeof candidate === "string") {
      if (/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(candidate)) {
        codes.add(candidate)
      } else {
        malformed = true
      }
    } else {
      malformed = true
    }
  }
  add(value.code, Object.hasOwn(value, "code"))
  add(value.errorCode, Object.hasOwn(value, "errorCode"))
  add(
    error?.server_error_code,
    Boolean(error && Object.hasOwn(error, "server_error_code")),
  )
  // Shipped DWS uses a numeric error.code for its process exit category. A
  // string value is a possible provider machine code and must be well formed.
  if (typeof error?.code === "string") add(error.code, true)
  if (typeof error?.message === "string") {
    const nested = parseJson(error.message)
    if (nested === undefined && error.message.trimStart().startsWith("{")) {
      malformed = true
    } else if (isObject(nested)) {
      add(nested.errorCode, Object.hasOwn(nested, "errorCode"))
    }
  }
  return { codes, malformed }
}

function providerCode(value: unknown): string | undefined {
  const scan = providerCodeScan(value)
  return !scan.malformed && scan.codes.size === 1
    ? [...scan.codes][0]
    : undefined
}

function actionableProviderFailureCode(value: unknown): string | undefined {
  const raw = providerCode(value)?.toLowerCase()
  if (!raw || raw.length > 96) return undefined
  return `dingtalk_provider_error_${raw}`
}

async function runDwsJson(
  args: string[],
  signal?: AbortSignal,
  beforeBoundary?: () => void | Promise<void>,
  timeoutMs = 30_000,
  effectMayHaveOccurred = false,
): Promise<CommandSuccess | CommandFailure> {
  try {
    await beforeBoundary?.()
  } catch {
    return { ok: false, code: "dingtalk_provider_fence_unavailable" }
  }
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(process.execPath, [
        ...(DWS_SOURCE_MODE ? ["--import", "tsx"] : []),
        DWS_SUPERVISOR_ENTRY,
        ...args,
      ], {
        env: safeEnvironment(),
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        detached: process.platform !== "win32",
        windowsHide: true,
      })
    } catch (error) {
      resolve({
        ok: false,
        code: fileErrorCode(error) === "ENOENT"
          ? "dingtalk_provider_cli_unavailable"
          : "dingtalk_provider_command_failed",
      })
      return
    }
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    let settled = false
    let spawnError: unknown
    let supervisedSpawnError: string | undefined
    let terminationReason: "abort" | "timeout" | "output" | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const killTree = (signalName: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) {
          process.kill(-child.pid, signalName)
        } else {
          child.kill(signalName)
        }
      } catch {
        // A close event will either already be queued or the child never started.
      }
    }
    const stop = (reason: typeof terminationReason) => {
      if (settled) return
      if (reason === "abort" || !terminationReason) terminationReason = reason
      killTree("SIGTERM")
      if (!killTimer) {
        killTimer = setTimeout(() => killTree("SIGKILL"), 1_000)
        killTimer.unref()
      }
    }
    const abort = () => stop("abort")
    const timeout = setTimeout(() => stop("timeout"), timeoutMs)
    timeout.unref()
    const cleanup = () => {
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      signal?.removeEventListener("abort", abort)
    }
    signal?.addEventListener("abort", abort, { once: true })
    child.stdout!.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      outputBytes += buffer.length
      if (outputBytes <= MAX_PROVIDER_OUTPUT_BYTES) {
        stdout.push(buffer)
      } else {
        stop("output")
      }
    })
    child.stderr!.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      outputBytes += buffer.length
      if (outputBytes <= MAX_PROVIDER_OUTPUT_BYTES) {
        stderr.push(buffer)
      } else {
        stop("output")
      }
    })
    child.once("error", (error) => {
      spawnError = error
    })
    child.on("message", (message) => {
      if (
        isObject(message) &&
        message.type === "dws-supervisor-spawn-error" &&
        typeof message.code === "string"
      ) {
        supervisedSpawnError = message.code
      }
    })
    child.once("close", async (code, exitSignal) => {
      if (settled) return
      settled = true
      cleanup()
      const parsedStdout = parseJson(Buffer.concat(stdout).toString("utf8"))
      const parsedStderr = parseJson(Buffer.concat(stderr).toString("utf8"))
      try {
        await beforeBoundary?.()
      } catch {
        resolve({
          ok: false,
          code: "dingtalk_provider_fence_unavailable",
          ...(effectMayHaveOccurred ? { indeterminate: true } : {}),
        })
        return
      }
      const systemCode = supervisedSpawnError ?? fileErrorCode(spawnError)
      if (systemCode === "ENOENT") {
        resolve({ ok: false, code: "dingtalk_provider_cli_unavailable" })
        return
      }
      if (terminationReason) {
        resolve({
          ok: false,
          code: terminationReason === "abort"
            ? "deploy_interrupted"
            : terminationReason === "output"
              ? "dingtalk_provider_invalid_json"
              : "dingtalk_provider_command_failed",
          indeterminate: true,
        })
        return
      }
      if (spawnError || code !== 0 || exitSignal) {
        const streamScans = [parsedStdout, parsedStderr].map(providerCodeScan)
        const conflictingStream = streamScans.some(
          (scan) => scan.malformed || scan.codes.size > 1,
        )
        const explicitCodes = new Set(
          streamScans.flatMap((scan) => [...scan.codes]),
        )
        const explicitProviderCode = !conflictingStream && explicitCodes.size === 1
          ? [...explicitCodes][0]
          : undefined
        resolve({
          ok: false,
          code: actionableProviderFailureCode(
            explicitProviderCode ? { code: explicitProviderCode } : undefined,
          ) ??
            "dingtalk_provider_command_failed",
          ...(explicitProviderCode ? { explicitProviderCode } : {}),
          ...(!explicitProviderCode || exitSignal ? { indeterminate: true } : {}),
        })
        return
      }
      if (parsedStdout === undefined) {
        resolve({
          ok: false,
          code: "dingtalk_provider_invalid_json",
          indeterminate: true,
        })
        return
      }
      resolve({ ok: true, value: parsedStdout })
    })
    if (signal?.aborted) stop("abort")
  })
}

function fileErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined
}

function validProviderIdentifier(value: unknown): value is string {
  return Boolean(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 256 &&
      !/[\u0000-\u001f\u007f]/.test(value),
  )
}

function appFromObject(value: unknown): ProviderApp | undefined {
  if (!isObject(value)) return undefined
  if (!validProviderIdentifier(value.unifiedAppId)) return undefined
  if (typeof value.name !== "string" || !value.name || value.name.length > 128) {
    return undefined
  }
  return { unifiedAppId: value.unifiedAppId, name: value.name }
}

function appFromReadback(value: unknown): ProviderApp | undefined {
  if (!isObject(value)) return undefined
  const candidates = [
    value,
    value.app,
    value.result,
    value.data,
    isObject(value.result) ? value.result.app : undefined,
    isObject(value.data) ? value.data.app : undefined,
  ]
    .map(appFromObject)
    .filter((candidate): candidate is ProviderApp => Boolean(candidate))
  const unique = new Map(candidates.map((candidate) => [
    `${candidate.unifiedAppId}\u0000${candidate.name}`,
    candidate,
  ]))
  return unique.size === 1 ? [...unique.values()][0] : undefined
}

function listPage(
  value: unknown,
): { apps: ProviderApp[]; nextCursor?: string } | undefined {
  if (!isObject(value)) return undefined
  const pagination = (
    primary: ProviderObject,
    fallback?: ProviderObject,
  ): { hasMore: boolean; cursor?: string } | undefined => {
    const primaryHasMore = primary.hasMore
    const fallbackHasMore = fallback?.hasMore
    const primaryCursor = primary.nextCursor
    const fallbackCursor = fallback?.nextCursor
    if (
      primaryHasMore !== undefined &&
      fallbackHasMore !== undefined &&
      primaryHasMore !== fallbackHasMore
    ) {
      return undefined
    }
    if (
      primaryCursor !== undefined &&
      fallbackCursor !== undefined &&
      primaryCursor !== fallbackCursor
    ) {
      return undefined
    }
    const hasMore = primaryHasMore ?? fallbackHasMore
    const cursor = primaryCursor ?? fallbackCursor
    if (typeof hasMore !== "boolean") return undefined
    const cursorPresent = cursor !== undefined && cursor !== null && cursor !== ""
    if (hasMore !== cursorPresent) return undefined
    if (!hasMore) return { hasMore: false }
    if (
      typeof cursor !== "string" ||
      cursor.length > 4_096 ||
      /[\u0000-\u001f\u007f]/.test(cursor)
    ) {
      return undefined
    }
    return { hasMore: true, cursor }
  }
  const candidates = [
    { apps: value.apps, pagination: pagination(value) },
    {
      apps: Array.isArray(value.result) ? value.result : undefined,
      pagination: pagination(value),
    },
    {
      apps: isObject(value.result) ? value.result.apps : undefined,
      pagination: isObject(value.result)
        ? pagination(value.result, value)
        : undefined,
    },
    {
      apps: isObject(value.data) ? value.data.apps : undefined,
      pagination: isObject(value.data)
        ? pagination(value.data, value)
        : undefined,
    },
  ].filter(
    (candidate): candidate is {
      apps: unknown[]
      pagination: { hasMore: boolean; cursor?: string } | undefined
    } => Array.isArray(candidate.apps),
  )
  if (candidates.length !== 1) return undefined
  if (!candidates[0]!.pagination) return undefined
  const parsed = candidates[0]!.apps.map(appFromObject)
  if (!parsed.every(Boolean)) return undefined
  const cursor = candidates[0]!.pagination.cursor
  if (cursor) {
    return { apps: parsed as ProviderApp[], nextCursor: cursor }
  }
  return { apps: parsed as ProviderApp[] }
}

function createdAppId(value: unknown): string | undefined {
  const app = appFromReadback(value)
  if (app) return app.unifiedAppId
  if (!isObject(value)) return undefined
  const candidates = [
    value.unifiedAppId,
    isObject(value.result) ? value.result.unifiedAppId : undefined,
    isObject(value.data) ? value.data.unifiedAppId : undefined,
  ].filter(validProviderIdentifier)
  return new Set(candidates).size === 1 ? candidates[0] : undefined
}

async function readbackApp(
  resourceId: string,
  expectedName: string,
  signal?: AbortSignal,
  beforeBoundary?: () => void | Promise<void>,
  commandTimeoutMs?: number,
): Promise<DingTalkProviderResult> {
  const response = await runDwsJson(
    [
      "devapp",
      "+get",
      "--unified-app-id",
      resourceId,
      "--format",
      "json",
    ],
    signal,
    beforeBoundary,
    commandTimeoutMs,
  )
  if (!response.ok) {
    return {
      status: isIdentityReadUncertainty(response) ? "indeterminate" : "failed",
      code: response.code,
    }
  }
  const app = appFromReadback(response.value)
  if (
    !app ||
    app.unifiedAppId !== resourceId ||
    app.name !== expectedName
  ) {
    return {
      status: "indeterminate",
      code: "dingtalk_provider_readback_mismatch",
    }
  }
  const provider = {
    kind: "dingtalk-app" as const,
    resourceId,
  }
  return { status: "verified", code: "dingtalk_app_verified", provider }
}

async function findExactApp(
  name: string,
  signal?: AbortSignal,
  beforeBoundary?: () => void | Promise<void>,
  commandTimeoutMs?: number,
): Promise<
  | { status: "none" }
  | { status: "one"; app: ProviderApp }
  | { status: "indeterminate"; code: string }
  | { status: "failed"; code: string }
> {
  let cursor: string | undefined
  const seenCursors = new Set<string>()
  const exact = new Map<string, ProviderApp>()
  let appCount = 0
  for (let pageNumber = 0; pageNumber < MAX_PROVIDER_PAGES; pageNumber += 1) {
    const response = await runDwsJson(
      [
      "devapp",
      "+list",
      "--name",
      name,
      "--page-size",
      String(PROVIDER_PAGE_SIZE),
      ...(cursor ? ["--cursor", cursor] : []),
      "--format",
      "json",
      ],
      signal,
      beforeBoundary,
      commandTimeoutMs,
    )
    if (!response.ok) {
      return {
        status: isIdentityReadUncertainty(response) ? "indeterminate" : "failed",
        code: response.code,
      }
    }
    const page = listPage(response.value)
    if (!page) {
      return {
        status: "indeterminate",
        code: "dingtalk_provider_list_invalid",
      }
    }
    if (page.apps.length > PROVIDER_PAGE_SIZE) {
      return {
        status: "indeterminate",
        code: "dingtalk_provider_pagination_limit",
      }
    }
    appCount += page.apps.length
    if (appCount > MAX_PROVIDER_APPS) {
      return {
        status: "indeterminate",
        code: "dingtalk_provider_pagination_limit",
      }
    }
    for (const app of page.apps) {
      if (app.name === name) exact.set(app.unifiedAppId, app)
    }
    if (!page.nextCursor) {
      if (exact.size === 0) return { status: "none" }
      if (exact.size > 1) {
        return {
          status: "indeterminate",
          code: "dingtalk_provider_identity_ambiguous",
        }
      }
      return { status: "one", app: [...exact.values()][0]! }
    }
    if (seenCursors.has(page.nextCursor)) {
      return {
        status: "indeterminate",
        code: "dingtalk_provider_pagination_invalid",
      }
    }
    seenCursors.add(page.nextCursor)
    cursor = page.nextCursor
  }
  return {
    status: "indeterminate",
    code: "dingtalk_provider_pagination_limit",
  }
}

export async function reconcileDingTalkApplication(
  {
    name,
    existing,
  }: {
    name: string
    existing?: DeployProviderState
  },
  {
    signal,
    allowWrite = false,
    confirmWrite,
    beforeBoundary,
    commandTimeoutMs,
    existingOperation,
    onCreateAttempt,
    onProviderIdentified,
  }: DingTalkProviderOptions = {},
): Promise<DingTalkProviderResult> {
  if (existing?.kind === "dingtalk-app") {
    return readbackApp(
      existing.resourceId,
      name,
      signal,
      beforeBoundary,
      commandTimeoutMs,
    )
  }

  let found = await findExactApp(name, signal, beforeBoundary, commandTimeoutMs)
  if (existingOperation && found.status !== "one") {
    return {
      status: "indeterminate",
      code: "dingtalk_provider_create_indeterminate",
    }
  }
  if (found.status === "failed" || found.status === "indeterminate") return found
  if (found.status === "one") {
    const provider = {
      kind: "dingtalk-app" as const,
      resourceId: found.app.unifiedAppId,
    }
    const readback = await readbackApp(
      found.app.unifiedAppId,
      name,
      signal,
      beforeBoundary,
      commandTimeoutMs,
    )
    if (readback.status !== "verified") {
      return existingOperation
        ? {
            status: "indeterminate",
            code: "dingtalk_provider_create_indeterminate",
          }
        : readback
    }
    try {
      await onProviderIdentified?.(provider)
    } catch {
      return {
        status: "failed",
        code: "dingtalk_provider_state_write_failed",
        provider,
      }
    }
    return readback
  }
  if (existingOperation) {
    return {
      status: "indeterminate",
      code: "dingtalk_provider_create_indeterminate",
    }
  }

  const approved = allowWrite || await confirmWrite?.() === true
  if (!approved) {
    return {
      status: "confirmation_required",
      code: "dingtalk_provider_confirmation_required",
    }
  }
  if (!onCreateAttempt || !onProviderIdentified) {
    return { status: "failed", code: "dingtalk_provider_fence_unavailable" }
  }
  const operation: DeployProviderOperation = {
    kind: "dingtalk-app-create",
    operationId: randomBytes(16).toString("hex"),
    name,
    attemptedAt: new Date().toISOString(),
  }
  try {
    await onCreateAttempt(operation)
    await beforeBoundary?.()
  } catch {
    return { status: "failed", code: "dingtalk_provider_fence_write_failed" }
  }
  const created = await runDwsJson(
    [
      "devapp",
      "+create",
      "--name",
      name,
      "--desc",
      "Managed by digital-employee deploy.",
      "--format",
      "json",
      "--yes",
    ],
    signal,
    beforeBoundary,
    commandTimeoutMs,
    true,
  )
  let resourceId: string | undefined
  if (created.ok) {
    resourceId = createdAppId(created.value)
    if (!resourceId) {
      return {
        status: "indeterminate",
        code: "dingtalk_provider_create_indeterminate",
      }
    }
  } else {
    const normalized = created.explicitProviderCode?.toLowerCase()
    if (!normalized || !ALREADY_EXISTS_CODES.has(normalized)) {
      // Crossing +create is an irreversible provider boundary. A non-zero
      // result cannot prove that the remote side performed no write, even
      // when it contains a well-formed machine code. Keep the durable
      // operation fence and make every replay reconcile-only.
      return {
        status: "indeterminate",
        code: created.explicitProviderCode
          ? created.code
          : "dingtalk_provider_create_indeterminate",
      }
    }
    found = await findExactApp(name, signal, beforeBoundary, commandTimeoutMs)
    if (found.status === "failed") {
      return {
        status: "indeterminate",
        code: "dingtalk_provider_create_indeterminate",
      }
    }
    if (found.status !== "one") {
      return {
        status: "indeterminate",
        code: "dingtalk_provider_create_indeterminate",
      }
    }
    resourceId = found.app.unifiedAppId
  }
  const provider = { kind: "dingtalk-app" as const, resourceId }
  const readback = await readbackApp(
    resourceId,
    name,
    signal,
    beforeBoundary,
    commandTimeoutMs,
  )
  if (readback.status !== "verified") {
    return {
      status: "indeterminate",
      code: "dingtalk_provider_create_indeterminate",
    }
  }
  try {
    await onProviderIdentified(provider)
  } catch {
    return {
      status: "indeterminate",
      code: "dingtalk_provider_state_write_failed",
      provider,
    }
  }
  return readback
}
