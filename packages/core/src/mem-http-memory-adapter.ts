import { createHash } from "node:crypto"

import {
  MEMORY_RECALL_MAX_ITEMS,
  MEMORY_RECALL_SCHEMA_VERSION,
  MEMORY_WRITE_RESULT_SCHEMA_VERSION,
  MemoryPortError,
  computeMemoryIdempotencyKey,
  derivePositionPrincipal,
  normalizeMemoryScope,
  validateMemoryRecall,
  validateMemoryWriteRequest,
  validateTaskState,
} from "./memory-port.js"
import type {
  MemoryPort,
  MemoryRecall,
  MemoryRecallItem,
  MemoryRecallRequest,
  MemoryWriteRequest,
  MemoryWriteResult,
  TaskState,
} from "./memory-port.js"

export const MEM_DURABLE_CONTEXT_CONTRACT = "durable-context.v1" as const

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 1024 * 1024
const TOKEN_ENV_PATTERN = /^MEM_[A-Z0-9_]{1,100}_TOKEN$/
const TOKEN_VALUE_PATTERN = /^mem_[A-Za-z0-9_-]{8,}$/
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

const CAPABILITY_KEYS = [
  "deployment_mode",
  "registration_mode",
  "workspace",
  "workspace_restore_modes",
  "workspace_bundle_schema_versions",
  "features",
  "handoff_schema_versions",
  "permissions",
] as const
const WORKSPACE_KEYS = [
  "id",
  "name",
  "resource_owner_user_id",
  "role",
  "created_at",
] as const
const FEATURE_KEYS = [
  "context",
  "handoff",
  "memory",
  "ask",
  "index_generation_status",
  "index_generation_execution",
  "workspace_export",
  "workspace_import",
] as const
const PERMISSION_KEYS = [
  "read",
  "search",
  "write",
  "delete",
  "provider_read",
  "provider_modify",
  "permissions_manage",
  "workspace_export",
  "workspace_import",
] as const
const MEMORY_KEYS = [
  "id",
  "workspace_id",
  "created_by_user_id",
  "kind",
  "content",
  "attributes",
  "path",
  "event_at",
  "source_type",
  "source_ref",
  "source_file_id",
  "source_file_sha256",
  "source_locator",
  "producer_agent",
  "producer_session",
  "producer_task",
  "content_sha256",
  "lifecycle_status",
  "state_version",
  "pinned",
  "pinned_at",
  "useful_count",
  "not_useful_count",
  "feedback_score",
  "feedback_count",
  "feedback_at",
  "forgotten_at",
  "created_at",
  "updated_at",
] as const
const PROVENANCE_KEYS = [
  "workspace_id",
  "created_by_user_id",
  "event_at",
  "source_type",
  "source_ref",
  "source_file_id",
  "source_file_sha256",
  "source_locator",
  "producer_agent",
  "producer_session",
  "producer_task",
] as const

export interface MemHttpMemoryAdapterOptions {
  baseUrl: string
  memWorkspaceId: string
  workspaceInstanceId: string
  positionId: string
  memoryScope: string
  tokenEnv: string
  /** Exact mem server revision accepted by this adapter instance. */
  pinnedRevision: string
  timeoutMs?: number
  /** Test/embedder seam; only tokenEnv is ever read from this object. */
  environment?: NodeJS.ProcessEnv
}

interface AdapterConfig {
  baseUrl: string
  memWorkspaceId: string
  workspaceInstanceId: string
  positionId: string
  principal: string
  memoryScope: string
  tokenEnv: string
  pinnedRevision: string
  timeoutMs: number
  environment: NodeJS.ProcessEnv
}

interface MemMemory {
  id: string
  workspaceId: string
  kind: string
  content: string
  path: string
  sourceType: string
  sourceRef?: string
  producerAgent?: string
  producerSession?: string
  producerTask?: string
  contentDigest: string
  lifecycleStatus: string
  stateVersion: number
  eventAt?: string
  createdAt: string
}

interface MemProvenance {
  workspaceId: string
  sourceType: string
  sourceRef?: string
  producerAgent?: string
  producerSession?: string
  producerTask?: string
}

function record(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

function environmentRecord(value: unknown): value is NodeJS.ProcessEnv {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  allowed: readonly string[] = required,
): boolean {
  const keys = Object.keys(value)
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.includes(key))
  )
}

function contractError(message: string, cause?: unknown): MemoryPortError {
  return new MemoryPortError("MEMORY_CONTRACT_UNSUPPORTED", message, {
    status: 502,
    ...(cause === undefined ? {} : { cause }),
  })
}

function configError(message: string): MemoryPortError {
  return new MemoryPortError("MEMORY_CONFIGURATION_INVALID", message)
}

function validateUUID(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw configError(`${field} must be a lowercase UUID`)
  }
  return value
}

function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value) {
    throw configError("baseUrl must be a canonical URL")
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw configError("baseUrl must be a valid URL")
  }
  const loopback =
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "::1" ||
    parsed.hostname === "[::1]"
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    throw configError(
      "baseUrl must be an HTTPS origin or a credential-free loopback HTTP origin",
    )
  }
  return parsed.origin
}

function validateOptions(value: MemHttpMemoryAdapterOptions): AdapterConfig {
  if (
    !record(value) ||
    !exactKeys(
      value,
      [
        "baseUrl",
        "memWorkspaceId",
        "workspaceInstanceId",
        "positionId",
        "memoryScope",
        "tokenEnv",
        "pinnedRevision",
      ],
      [
        "baseUrl",
        "memWorkspaceId",
        "workspaceInstanceId",
        "positionId",
        "memoryScope",
        "tokenEnv",
        "pinnedRevision",
        "timeoutMs",
        "environment",
      ],
    )
  ) {
    throw configError("adapter options carry unknown or missing fields")
  }
  const positionId =
    typeof value.positionId === "string" ? value.positionId : ""
  const timeoutMs = value.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (
    typeof timeoutMs !== "number" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw configError(`timeoutMs must be between 100 and ${MAX_TIMEOUT_MS}`)
  }
  if (typeof value.tokenEnv !== "string" || !TOKEN_ENV_PATTERN.test(value.tokenEnv)) {
    throw configError("tokenEnv must name one position-scoped MEM_*_TOKEN variable")
  }
  if (
    typeof value.pinnedRevision !== "string" ||
    value.pinnedRevision.length === 0 ||
    value.pinnedRevision.length > 128 ||
    value.pinnedRevision.trim() !== value.pinnedRevision ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.pinnedRevision)
  ) {
    throw configError("pinnedRevision must be a bounded revision identifier")
  }
  if (
    value.environment !== undefined &&
    !environmentRecord(value.environment)
  ) {
    // A supplied environment is an internal seam, not a user-facing config
    // field. It must be an object and is intentionally not copied or logged.
    throw configError("environment must be a process environment object")
  }
  return {
    baseUrl: normalizeBaseUrl(value.baseUrl),
    memWorkspaceId: validateUUID(value.memWorkspaceId, "memWorkspaceId"),
    workspaceInstanceId: validateUUID(
      value.workspaceInstanceId,
      "workspaceInstanceId",
    ),
    positionId,
    principal: derivePositionPrincipal(positionId),
    memoryScope: normalizeMemoryScope(value.memoryScope),
    tokenEnv: value.tokenEnv,
    pinnedRevision: value.pinnedRevision,
    timeoutMs,
    environment: value.environment ?? process.env,
  }
}

function tokenFromEnvironment(config: AdapterConfig): string {
  const value = config.environment[config.tokenEnv]
  if (typeof value !== "string" || !TOKEN_VALUE_PATTERN.test(value)) {
    throw configError(
      "the configured position token environment variable is missing or malformed",
    )
  }
  return value
}

function unavailable(cause?: unknown): MemoryPortError {
  return new MemoryPortError(
    "MEMORY_UNAVAILABLE",
    "Durable memory is temporarily unavailable.",
    { status: 503, retryable: true, ...(cause === undefined ? {} : { cause }) },
  )
}

function mapHttpError(status: number, body: unknown): MemoryPortError {
  const code = record(body) && typeof body.error === "string" ? body.error : ""
  if (status === 409 && code === "idempotency_conflict") {
    return new MemoryPortError(
      "MEMORY_CONFLICT",
      "The memory idempotency key is bound to a different payload.",
      { status },
    )
  }
  if (status === 400 && code === "contract_unsupported") {
    return contractError("The pinned mem contract is unsupported.")
  }
  if (status === 401 || status === 403) {
    return new MemoryPortError(
      "MEMORY_DENIED",
      "The position-scoped memory credential was denied.",
      { status },
    )
  }
  if (status === 404 || status === 410) {
    return new MemoryPortError(
      "MEMORY_NOT_FOUND",
      "The requested memory is unavailable in this scope.",
      { status },
    )
  }
  if (status >= 500) return unavailable()
  return contractError("The pinned mem HTTP operation failed.")
}

async function requestJson(
  config: AdapterConfig,
  path: string,
  options: {
    method?: "GET" | "POST"
    token?: string
    body?: unknown
    idempotencyKey?: string
  } = {},
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    const headers = new Headers({ Accept: "application/json" })
    if (options.token !== undefined) {
      headers.set("Authorization", `Bearer ${options.token}`)
      headers.set("X-Workspace-ID", config.memWorkspaceId)
    }
    if (options.body !== undefined) headers.set("Content-Type", "application/json")
    if (options.idempotencyKey !== undefined) {
      headers.set("Idempotency-Key", options.idempotencyKey)
    }
    let response: Response
    try {
      response = await fetch(`${config.baseUrl}${path}`, {
        method: options.method ?? "GET",
        headers,
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
      })
    } catch (error) {
      throw unavailable(error)
    }
    const text = await response.text()
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      throw contractError("The mem response exceeds the adapter byte bound.")
    }
    let body: unknown = null
    if (text !== "") {
      try {
        body = JSON.parse(text) as unknown
      } catch (error) {
        throw contractError("The mem response is not valid JSON.", error)
      }
    }
    if (!response.ok) throw mapHttpError(response.status, body)
    return body
  } finally {
    clearTimeout(timer)
  }
}

function assertExactBooleanRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, boolean> {
  if (
    !record(value) ||
    !exactKeys(value, keys) ||
    keys.some((key) => typeof value[key] !== "boolean")
  ) {
    throw contractError(`${label} does not match the pinned mem response.`)
  }
  return value as Record<string, boolean>
}

function validateCapabilities(value: unknown, config: AdapterConfig): void {
  if (!record(value) || !exactKeys(value, CAPABILITY_KEYS)) {
    throw contractError("Capabilities do not match the pinned mem response.")
  }
  if (!record(value.workspace) || !exactKeys(value.workspace, WORKSPACE_KEYS)) {
    throw contractError("Workspace does not match the pinned mem response.")
  }
  if (value.workspace.id !== config.memWorkspaceId) {
    throw new MemoryPortError(
      "MEMORY_SCOPE_MISMATCH",
      "The mem token resolved a different workspace.",
      { status: 403 },
    )
  }
  const features = assertExactBooleanRecord(value.features, FEATURE_KEYS, "features")
  const permissions = assertExactBooleanRecord(
    value.permissions,
    PERMISSION_KEYS,
    "permissions",
  )
  if (features.memory !== true) throw unavailable()
  if (
    permissions.read !== true ||
    permissions.write !== true ||
    permissions.search !== false ||
    permissions.delete !== false ||
    permissions.permissions_manage !== false ||
    permissions.provider_modify !== false ||
    permissions.workspace_export !== false ||
    permissions.workspace_import !== false
  ) {
    throw new MemoryPortError(
      "MEMORY_DENIED",
      "The memory credential is not a minimum position-scoped read/write token.",
      { status: 403 },
    )
  }
}

async function preflight(config: AdapterConfig, token: string): Promise<void> {
  const version = await requestJson(config, "/v1/version")
  if (!record(version) || !exactKeys(version, ["version"])) {
    throw new MemoryPortError(
      "MEMORY_CONTRACT_UNSUPPORTED",
      "The mem server version response does not match the pinned contract.",
      { status: 502 },
    )
  }
  if (typeof version.version !== "string") {
    throw new MemoryPortError(
      "MEMORY_CONTRACT_UNSUPPORTED",
      "The mem server version response does not contain a revision string.",
      { status: 502 },
    )
  }
  if (version.version !== config.pinnedRevision) {
    throw new MemoryPortError(
      "MEMORY_REVISION_MISMATCH",
      "The mem server revision does not match the configured revision.",
      { status: 502 },
    )
  }
  validateCapabilities(
    await requestJson(config, "/v1/capabilities", { token }),
    config,
  )
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const item = value[key]
  if (item === undefined) return undefined
  if (typeof item !== "string") throw contractError(`mem ${key} is invalid.`)
  return item
}

function memMemory(value: unknown): MemMemory {
  const required = [
    "id",
    "workspace_id",
    "kind",
    "content",
    "path",
    "source_type",
    "content_sha256",
    "lifecycle_status",
    "state_version",
    "created_at",
  ] as const
  if (!record(value) || !exactKeys(value, required, MEMORY_KEYS)) {
    throw contractError("Memory does not match the pinned mem response.")
  }
  if (
    typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id) ||
    typeof value.workspace_id !== "string" ||
    !UUID_PATTERN.test(value.workspace_id) ||
    typeof value.kind !== "string" ||
    typeof value.content !== "string" ||
    typeof value.path !== "string" ||
    typeof value.source_type !== "string" ||
    typeof value.content_sha256 !== "string" ||
    !SHA256_PATTERN.test(value.content_sha256) ||
    typeof value.lifecycle_status !== "string" ||
    typeof value.state_version !== "number" ||
    !Number.isSafeInteger(value.state_version) ||
    value.state_version < 1 ||
    typeof value.created_at !== "string" ||
    !Number.isFinite(Date.parse(value.created_at))
  ) {
    throw contractError("Memory contains invalid pinned fields.")
  }
  const eventAt = optionalString(value, "event_at")
  if (eventAt !== undefined && !Number.isFinite(Date.parse(eventAt))) {
    throw contractError("Memory event_at is invalid.")
  }
  return {
    id: value.id,
    workspaceId: value.workspace_id,
    kind: value.kind,
    content: value.content,
    path: value.path,
    sourceType: value.source_type,
    ...(optionalString(value, "source_ref") === undefined
      ? {}
      : { sourceRef: optionalString(value, "source_ref") }),
    ...(optionalString(value, "producer_agent") === undefined
      ? {}
      : { producerAgent: optionalString(value, "producer_agent") }),
    ...(optionalString(value, "producer_session") === undefined
      ? {}
      : { producerSession: optionalString(value, "producer_session") }),
    ...(optionalString(value, "producer_task") === undefined
      ? {}
      : { producerTask: optionalString(value, "producer_task") }),
    contentDigest: value.content_sha256,
    lifecycleStatus: value.lifecycle_status,
    stateVersion: value.state_version,
    ...(eventAt === undefined ? {} : { eventAt }),
    createdAt: value.created_at,
  }
}

function memoryProjection(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) =>
      (MEMORY_KEYS as readonly string[]).includes(key),
    ),
  )
}

function memProvenance(value: unknown): MemProvenance {
  if (
    !record(value) ||
    !exactKeys(value, ["workspace_id", "source_type"], PROVENANCE_KEYS) ||
    typeof value.workspace_id !== "string" ||
    !UUID_PATTERN.test(value.workspace_id) ||
    typeof value.source_type !== "string"
  ) {
    throw contractError("Provenance does not match the pinned mem response.")
  }
  return {
    workspaceId: value.workspace_id,
    sourceType: value.source_type,
    ...(optionalString(value, "source_ref") === undefined
      ? {}
      : { sourceRef: optionalString(value, "source_ref") }),
    ...(optionalString(value, "producer_agent") === undefined
      ? {}
      : { producerAgent: optionalString(value, "producer_agent") }),
    ...(optionalString(value, "producer_session") === undefined
      ? {}
      : { producerSession: optionalString(value, "producer_session") }),
    ...(optionalString(value, "producer_task") === undefined
      ? {}
      : { producerTask: optionalString(value, "producer_task") }),
  }
}

function bindRequest(request: MemoryWriteRequest, config: AdapterConfig): MemoryWriteRequest {
  const value = validateMemoryWriteRequest(request)
  if (
    value.workspaceInstanceId !== config.workspaceInstanceId ||
    value.positionId !== config.positionId ||
    value.principal !== config.principal ||
    value.memoryScope !== config.memoryScope
  ) {
    throw new MemoryPortError(
      "MEMORY_SCOPE_MISMATCH",
      "The memory request does not match the configured workspace position scope.",
      { status: 403 },
    )
  }
  return value
}

function canonicalTaskState(value: TaskState): string {
  return JSON.stringify(validateTaskState(value))
}

function assertReadback(
  memory: MemMemory,
  request: MemoryWriteRequest,
  config: AdapterConfig,
  expectedContent: string,
  expectedDigest: string,
): TaskState {
  if (
    memory.workspaceId !== config.memWorkspaceId ||
    memory.kind !== "task_state" ||
    memory.path !== config.memoryScope ||
    memory.sourceType !== "agent" ||
    memory.sourceRef !== "digital-employee://task-state.v1" ||
    memory.producerAgent !== "digital-employee" ||
    memory.producerSession !== request.sessionId ||
    memory.producerTask !== request.taskState.taskId ||
    memory.lifecycleStatus !== "active" ||
    memory.content !== expectedContent ||
    memory.contentDigest !== expectedDigest
  ) {
    throw new MemoryPortError(
      "MEMORY_READBACK_MISMATCH",
      "The persisted task state did not match its scoped write.",
      { status: 409 },
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(memory.content) as unknown
  } catch (error) {
    throw new MemoryPortError(
      "MEMORY_READBACK_MISMATCH",
      "The persisted task state was not valid JSON.",
      { status: 409, cause: error },
    )
  }
  const state = validateTaskState(parsed)
  if (canonicalTaskState(state) !== expectedContent) {
    throw new MemoryPortError(
      "MEMORY_READBACK_MISMATCH",
      "The persisted task state was not canonical.",
      { status: 409 },
    )
  }
  return state
}

function validateRecallRequest(
  value: MemoryRecallRequest,
  config: AdapterConfig,
): Required<MemoryRecallRequest> {
  if (
    !record(value) ||
    !exactKeys(
      value,
      [
        "workspaceInstanceId",
        "sessionId",
        "positionId",
        "principal",
        "memoryScope",
        "mode",
      ],
      [
        "workspaceInstanceId",
        "sessionId",
        "positionId",
        "principal",
        "memoryScope",
        "mode",
        "limit",
      ],
    )
  ) {
    throw new MemoryPortError(
      "MEMORY_RECORD_INVALID",
      "Memory recall request carries unknown or missing fields.",
    )
  }
  if (value.mode !== "optional" && value.mode !== "required") {
    throw new MemoryPortError("MEMORY_RECORD_INVALID", "Recall mode is invalid.")
  }
  const limit = value.limit ?? 10
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MEMORY_RECALL_MAX_ITEMS) {
    throw new MemoryPortError("MEMORY_RECORD_INVALID", "Recall limit is invalid.")
  }
  if (
    value.workspaceInstanceId !== config.workspaceInstanceId ||
    value.positionId !== config.positionId ||
    value.principal !== config.principal ||
    normalizeMemoryScope(value.memoryScope) !== config.memoryScope ||
    typeof value.sessionId !== "string" ||
    !UUID_PATTERN.test(value.sessionId)
  ) {
    throw new MemoryPortError(
      "MEMORY_SCOPE_MISMATCH",
      "The recall request does not match the configured workspace position scope.",
      { status: 403 },
    )
  }
  return { ...value, limit }
}

function degradedRecall(
  request: Required<MemoryRecallRequest>,
): MemoryRecall {
  return validateMemoryRecall({
    schemaVersion: MEMORY_RECALL_SCHEMA_VERSION,
    workspaceInstanceId: request.workspaceInstanceId,
    sessionId: request.sessionId,
    positionId: request.positionId,
    principal: request.principal,
    retrievedAt: new Date().toISOString(),
    items: [],
    warnings: [
      {
        code: "MEMORY_UNAVAILABLE",
        message: "Durable memory is temporarily unavailable.",
        retryable: true,
      },
    ],
  })
}

class MemHttpMemoryAdapter implements MemoryPort {
  readonly #config: AdapterConfig

  constructor(options: MemHttpMemoryAdapterOptions) {
    this.#config = validateOptions(options)
  }

  async writeTaskState(input: MemoryWriteRequest): Promise<MemoryWriteResult> {
    const request = bindRequest(input, this.#config)
    const token = tokenFromEnvironment(this.#config)
    await preflight(this.#config, token)
    const content = canonicalTaskState(request.taskState)
    const digest = createHash("sha256").update(content, "utf8").digest("hex")
    const response = await requestJson(this.#config, "/v1/memories", {
      method: "POST",
      token,
      idempotencyKey: computeMemoryIdempotencyKey(request),
      body: {
        kind: "task_state",
        content,
        path: this.#config.memoryScope,
        event_at: request.taskState.recordedAt,
        source: {
          type: "agent",
          ref: "digital-employee://task-state.v1",
          locator: {
            schema_version: request.taskState.schemaVersion,
            workspace_instance_id: request.workspaceInstanceId,
            position_id: request.positionId,
            principal: request.principal,
            turn_id: request.turnId,
            terminal_output_digest: request.taskState.terminalOutputDigest,
          },
        },
        producer: {
          agent_id: "digital-employee",
          session_id: request.sessionId,
          task_id: request.taskState.taskId,
        },
        attributes: {
          schema_version: request.taskState.schemaVersion,
          reviewed: true,
        },
      },
    })
    if (
      !record(response) ||
      !exactKeys(response, ["memory", "replayed"]) ||
      typeof response.replayed !== "boolean"
    ) {
      throw contractError("Remember does not match the pinned mem response.")
    }
    const written = memMemory(response.memory)
    assertReadback(written, request, this.#config, content, digest)
    const readResponse = await requestJson(
      this.#config,
      `/v1/memories/${written.id}?scope=${encodeURIComponent(this.#config.memoryScope)}`,
      { token },
    )
    if (
      !record(readResponse) ||
      !exactKeys(readResponse, ["citation", "provenance", ...[
        "id",
        "workspace_id",
        "kind",
        "content",
        "path",
        "source_type",
        "content_sha256",
        "lifecycle_status",
        "state_version",
        "created_at",
      ]], [...MEMORY_KEYS, "citation", "provenance"])
    ) {
      throw contractError("Readback does not match the pinned mem response.")
    }
    const readBackMemory = memMemory(memoryProjection(readResponse))
    const readBack = assertReadback(
      readBackMemory,
      request,
      this.#config,
      content,
      digest,
    )
    const provenance = memProvenance(readResponse.provenance)
    const citation = readResponse.citation
    if (
      citation !== `mem://memories/${written.id}` ||
      readBackMemory.id !== written.id ||
      readBackMemory.stateVersion !== written.stateVersion ||
      provenance.workspaceId !== this.#config.memWorkspaceId ||
      provenance.sourceType !== "agent"
    ) {
      throw new MemoryPortError(
        "MEMORY_READBACK_MISMATCH",
        "The memory citation or provenance did not match its write.",
        { status: 409 },
      )
    }
    return {
      schemaVersion: MEMORY_WRITE_RESULT_SCHEMA_VERSION,
      memoryId: written.id,
      citation,
      stateVersion: written.stateVersion,
      digest,
      replayed: response.replayed,
      readBack,
    }
  }

  async recall(input: MemoryRecallRequest): Promise<MemoryRecall> {
    const request = validateRecallRequest(input, this.#config)
    try {
      const token = tokenFromEnvironment(this.#config)
      await preflight(this.#config, token)
      const response = await requestJson(
        this.#config,
        "/v1/durable-context/recall",
        {
          method: "POST",
          token,
          body: {
            contract: MEM_DURABLE_CONTEXT_CONTRACT,
            principal: request.principal,
            session_ref: request.sessionId,
            limit: request.limit,
          },
        },
      )
      if (
        !record(response) ||
        !exactKeys(response, ["contract", "principal", "hits"]) ||
        response.contract !== MEM_DURABLE_CONTEXT_CONTRACT ||
        response.principal !== request.principal ||
        !Array.isArray(response.hits) ||
        response.hits.length > request.limit
      ) {
        throw contractError("Recall does not match the pinned durable-context response.")
      }
      const items: MemoryRecallItem[] = response.hits.map((hit): MemoryRecallItem => {
        if (
          !record(hit) ||
          !exactKeys(hit, ["memory", "locator", "state_version", "provenance"])
        ) {
          throw contractError("Recall hit does not match the pinned response.")
        }
        const memory = memMemory(hit.memory)
        const provenance = memProvenance(hit.provenance)
        if (
          memory.workspaceId !== this.#config.memWorkspaceId ||
          provenance.workspaceId !== this.#config.memWorkspaceId ||
          memory.path !== this.#config.memoryScope ||
          memory.lifecycleStatus !== "active" ||
          hit.state_version !== memory.stateVersion ||
          hit.locator !== `mem://memories/${memory.id}@${memory.stateVersion}`
        ) {
          throw new MemoryPortError(
            "MEMORY_SCOPE_MISMATCH",
            "A recalled memory did not match the configured scope.",
            { status: 403 },
          )
        }
        return {
          memoryId: memory.id,
          kind: memory.kind,
          text: memory.content,
          digest: memory.contentDigest,
          citation: `mem://memories/${memory.id}`,
          locator: hit.locator,
          stateVersion: memory.stateVersion,
          recordedAt: memory.eventAt ?? memory.createdAt,
          provenance: {
            sourceType: provenance.sourceType,
            ...(provenance.sourceRef === undefined
              ? {}
              : { sourceRef: provenance.sourceRef }),
            ...(provenance.producerAgent === undefined
              ? {}
              : { producerAgent: provenance.producerAgent }),
            ...(provenance.producerSession === undefined
              ? {}
              : { producerSession: provenance.producerSession }),
            ...(provenance.producerTask === undefined
              ? {}
              : { producerTask: provenance.producerTask }),
          },
          trust: "untrusted",
          authority: "none",
        }
      })
      return validateMemoryRecall({
        schemaVersion: MEMORY_RECALL_SCHEMA_VERSION,
        workspaceInstanceId: request.workspaceInstanceId,
        sessionId: request.sessionId,
        positionId: request.positionId,
        principal: request.principal,
        retrievedAt: new Date().toISOString(),
        items,
        warnings: [],
      })
    } catch (error) {
      if (
        request.mode === "optional" &&
        error instanceof MemoryPortError &&
        error.code === "MEMORY_UNAVAILABLE"
      ) {
        return degradedRecall(request)
      }
      throw error
    }
  }
}

export function createMemHttpMemoryAdapter(
  options: MemHttpMemoryAdapterOptions,
): MemoryPort {
  return new MemHttpMemoryAdapter(options)
}
