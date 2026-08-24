import { createHash } from "node:crypto"

import { CoreError } from "./contracts.js"

export const TASK_STATE_SCHEMA_VERSION = "task-state.v1" as const
export const MEMORY_WRITE_REQUEST_SCHEMA_VERSION = "memory-write-request.v1" as const
export const MEMORY_WRITE_RESULT_SCHEMA_VERSION = "memory-write-result.v1" as const
export const MEMORY_RECALL_SCHEMA_VERSION = "memory-recall.v1" as const

export const TASK_STATE_MAX_SUMMARY_BYTES = 16 * 1024
export const MEMORY_RECALL_MAX_ITEMS = 20
export const MEMORY_RECALL_MAX_ITEM_BYTES = 16 * 1024
export const MEMORY_RECALL_MAX_TOTAL_BYTES = 64 * 1024

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const POSITION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,118}$/
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/
const RAW_SHA256_PATTERN = /^[a-f0-9]{64}$/
const MEMORY_CITATION_PATTERN = /^mem:\/\/memories\/([0-9a-f-]{36})$/
const MEMORY_LOCATOR_PATTERN = /^mem:\/\/memories\/([0-9a-f-]{36})@([1-9][0-9]*)$/

export type MemoryPortErrorCode =
  | "MEMORY_CONFIGURATION_INVALID"
  | "MEMORY_CONFLICT"
  | "MEMORY_CONTRACT_UNSUPPORTED"
  | "MEMORY_DENIED"
  | "MEMORY_NOT_FOUND"
  | "MEMORY_READBACK_MISMATCH"
  | "MEMORY_RECORD_INVALID"
  | "MEMORY_SCOPE_INVALID"
  | "MEMORY_SCOPE_MISMATCH"
  | "MEMORY_UNAVAILABLE"

export class MemoryPortError extends CoreError {
  constructor(
    code: MemoryPortErrorCode,
    message: string,
    options: { retryable?: boolean; status?: number; cause?: unknown } = {},
  ) {
    super(code, message, {
      retryable: options.retryable ?? false,
      status: options.status ?? 400,
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    })
    this.name = "MemoryPortError"
  }
}

export type TaskStateStatus = "completed" | "failed" | "cancelled"

/**
 * A deliberately small reviewed terminal projection. It is not a transcript,
 * Host resume handle, tool grant, or model-authored memory extraction.
 */
export interface TaskState {
  schemaVersion: typeof TASK_STATE_SCHEMA_VERSION
  taskId: string
  status: TaskStateStatus
  summary: string
  terminalOutputDigest: string
  recordedAt: string
}

export interface MemoryWriteRequest {
  schemaVersion: typeof MEMORY_WRITE_REQUEST_SCHEMA_VERSION
  workspaceInstanceId: string
  sessionId: string
  turnId: string
  positionId: string
  principal: string
  memoryScope: string
  taskState: TaskState
}

export interface MemoryWriteResult {
  schemaVersion: typeof MEMORY_WRITE_RESULT_SCHEMA_VERSION
  memoryId: string
  citation: string
  stateVersion: number
  digest: string
  replayed: boolean
  readBack: TaskState
}

export type MemoryRecallMode = "optional" | "required"

export interface MemoryRecallRequest {
  workspaceInstanceId: string
  sessionId: string
  positionId: string
  principal: string
  memoryScope: string
  mode: MemoryRecallMode
  limit?: number
}

export interface MemoryRecallProvenance {
  sourceType: string
  sourceRef?: string
  producerAgent?: string
  producerSession?: string
  producerTask?: string
}

export interface MemoryRecallItem {
  memoryId: string
  kind: string
  text: string
  digest: string
  citation: string
  locator: string
  stateVersion: number
  recordedAt: string
  provenance: MemoryRecallProvenance
  trust: "untrusted"
  authority: "none"
}

export interface MemoryRecallWarning {
  code: "MEMORY_UNAVAILABLE"
  message: "Durable memory is temporarily unavailable."
  retryable: true
}

export interface MemoryRecall {
  schemaVersion: typeof MEMORY_RECALL_SCHEMA_VERSION
  workspaceInstanceId: string
  sessionId: string
  positionId: string
  principal: string
  retrievedAt: string
  items: MemoryRecallItem[]
  warnings: MemoryRecallWarning[]
}

export interface MemoryPort {
  writeTaskState(request: MemoryWriteRequest): Promise<MemoryWriteResult>
  recall(request: MemoryRecallRequest): Promise<MemoryRecall>
}

function record(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value)
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  )
}

function invalidRecord(message: string): never {
  throw new MemoryPortError("MEMORY_RECORD_INVALID", message)
}

function boundedId(value: unknown, field: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    invalidRecord(`${field} must be a bounded identifier`)
  }
  return value
}

function boundedText(value: unknown, field: string, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    byteLength(value) > maxBytes ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    invalidRecord(`${field} must be a bounded single-line string`)
  }
  return value
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    invalidRecord(`${field} must be a lowercase UUID`)
  }
  return value
}

function rfc3339(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    invalidRecord(`${field} must be an RFC3339 timestamp`)
  }
  return value
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8")
}

export function derivePositionPrincipal(positionId: string): string {
  if (!POSITION_PATTERN.test(positionId)) {
    throw new MemoryPortError(
      "MEMORY_SCOPE_INVALID",
      "positionId must be a lowercase bounded identifier",
    )
  }
  return `position.${positionId}`
}

export function normalizeMemoryScope(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > 1_024 ||
    value !== value.trim() ||
    !value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("//") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new MemoryPortError(
      "MEMORY_SCOPE_INVALID",
      "memoryScope must be one canonical non-root virtual path",
    )
  }
  const segments = value.slice(1).split("/")
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new MemoryPortError(
      "MEMORY_SCOPE_INVALID",
      "memoryScope must not contain traversal segments",
    )
  }
  return value
}

export function validateTaskState(value: unknown): TaskState {
  const keys = [
    "schemaVersion",
    "taskId",
    "status",
    "summary",
    "terminalOutputDigest",
    "recordedAt",
  ] as const
  if (!record(value) || !exactKeys(value, keys)) {
    invalidRecord("task-state.v1 carries unknown or missing fields")
  }
  if (value.schemaVersion !== TASK_STATE_SCHEMA_VERSION) {
    invalidRecord(`schemaVersion must be ${TASK_STATE_SCHEMA_VERSION}`)
  }
  const taskId = boundedId(value.taskId, "taskId")
  if (
    value.status !== "completed" &&
    value.status !== "failed" &&
    value.status !== "cancelled"
  ) {
    invalidRecord("status must be one terminal task state")
  }
  if (
    typeof value.summary !== "string" ||
    value.summary.trim() !== value.summary ||
    value.summary.length === 0 ||
    byteLength(value.summary) > TASK_STATE_MAX_SUMMARY_BYTES
  ) {
    invalidRecord(
      `summary must be non-empty and at most ${TASK_STATE_MAX_SUMMARY_BYTES} UTF-8 bytes`,
    )
  }
  if (
    typeof value.terminalOutputDigest !== "string" ||
    !SHA256_PATTERN.test(value.terminalOutputDigest)
  ) {
    invalidRecord("terminalOutputDigest must be sha256:<lowercase hex>")
  }
  return {
    schemaVersion: TASK_STATE_SCHEMA_VERSION,
    taskId,
    status: value.status,
    summary: value.summary,
    terminalOutputDigest: value.terminalOutputDigest,
    recordedAt: rfc3339(value.recordedAt, "recordedAt"),
  }
}

export function validateMemoryWriteRequest(value: unknown): MemoryWriteRequest {
  const keys = [
    "schemaVersion",
    "workspaceInstanceId",
    "sessionId",
    "turnId",
    "positionId",
    "principal",
    "memoryScope",
    "taskState",
  ] as const
  if (!record(value) || !exactKeys(value, keys)) {
    invalidRecord("memory-write-request.v1 carries unknown or missing fields")
  }
  if (value.schemaVersion !== MEMORY_WRITE_REQUEST_SCHEMA_VERSION) {
    invalidRecord(`schemaVersion must be ${MEMORY_WRITE_REQUEST_SCHEMA_VERSION}`)
  }
  const positionId =
    typeof value.positionId === "string" ? value.positionId : ""
  const expectedPrincipal = derivePositionPrincipal(positionId)
  if (value.principal !== expectedPrincipal) {
    throw new MemoryPortError(
      "MEMORY_SCOPE_MISMATCH",
      "principal does not match the addressed position",
      { status: 403 },
    )
  }
  return {
    schemaVersion: MEMORY_WRITE_REQUEST_SCHEMA_VERSION,
    workspaceInstanceId: uuid(value.workspaceInstanceId, "workspaceInstanceId"),
    sessionId: uuid(value.sessionId, "sessionId"),
    turnId: boundedId(value.turnId, "turnId"),
    positionId,
    principal: expectedPrincipal,
    memoryScope: normalizeMemoryScope(value.memoryScope),
    taskState: validateTaskState(value.taskState),
  }
}

function idempotencyProjection(request: MemoryWriteRequest): string {
  return JSON.stringify({
    schemaVersion: MEMORY_WRITE_REQUEST_SCHEMA_VERSION,
    workspaceInstanceId: request.workspaceInstanceId,
    sessionId: request.sessionId,
    turnId: request.turnId,
    positionId: request.positionId,
    terminalOutputDigest: request.taskState.terminalOutputDigest,
  })
}

export function computeMemoryIdempotencyKey(value: unknown): string {
  const request = validateMemoryWriteRequest(value)
  return `de-task-state-v1:${createHash("sha256")
    .update(idempotencyProjection(request), "utf8")
    .digest("hex")}`
}

function validateRecallProvenance(value: unknown): MemoryRecallProvenance {
  if (
    !record(value) ||
    !exactKeys(value, ["sourceType"], [
      "sourceRef",
      "producerAgent",
      "producerSession",
      "producerTask",
    ])
  ) {
    invalidRecord("recall provenance carries unknown or missing fields")
  }
  const output: MemoryRecallProvenance = {
    sourceType: boundedId(value.sourceType, "provenance.sourceType"),
  }
  if (value.sourceRef !== undefined) {
    output.sourceRef = boundedText(
      value.sourceRef,
      "provenance.sourceRef",
      2_048,
    )
  }
  for (const key of [
    "producerAgent",
    "producerSession",
    "producerTask",
  ] as const) {
    if (value[key] !== undefined) {
      output[key] = boundedId(value[key], `provenance.${key}`)
    }
  }
  return output
}

function validateRecallItem(value: unknown): MemoryRecallItem {
  const keys = [
    "memoryId",
    "kind",
    "text",
    "digest",
    "citation",
    "locator",
    "stateVersion",
    "recordedAt",
    "provenance",
    "trust",
    "authority",
  ] as const
  if (!record(value) || !exactKeys(value, keys)) {
    invalidRecord("memory recall item carries unknown or missing fields")
  }
  const memoryId = uuid(value.memoryId, "memoryId")
  if (
    typeof value.text !== "string" ||
    byteLength(value.text) > MEMORY_RECALL_MAX_ITEM_BYTES
  ) {
    invalidRecord("memory recall text exceeds its UTF-8 byte bound")
  }
  if (typeof value.digest !== "string" || !RAW_SHA256_PATTERN.test(value.digest)) {
    invalidRecord("memory recall digest must be lowercase SHA-256")
  }
  const citationMatch =
    typeof value.citation === "string"
      ? MEMORY_CITATION_PATTERN.exec(value.citation)
      : null
  const locatorMatch =
    typeof value.locator === "string"
      ? MEMORY_LOCATOR_PATTERN.exec(value.locator)
      : null
  if (
    citationMatch?.[1] !== memoryId ||
    locatorMatch?.[1] !== memoryId ||
    value.trust !== "untrusted" ||
    value.authority !== "none"
  ) {
    invalidRecord("memory recall identity or trust boundary is invalid")
  }
  if (
    typeof value.stateVersion !== "number" ||
    !Number.isSafeInteger(value.stateVersion) ||
    value.stateVersion < 1 ||
    Number(locatorMatch[2]) !== value.stateVersion
  ) {
    invalidRecord("memory recall stateVersion is invalid")
  }
  return {
    memoryId,
    kind: boundedId(value.kind, "kind"),
    text: value.text,
    digest: value.digest,
    citation: value.citation as string,
    locator: value.locator as string,
    stateVersion: value.stateVersion,
    recordedAt: rfc3339(value.recordedAt, "recordedAt"),
    provenance: validateRecallProvenance(value.provenance),
    trust: "untrusted",
    authority: "none",
  }
}

export function validateMemoryRecall(value: unknown): MemoryRecall {
  const keys = [
    "schemaVersion",
    "workspaceInstanceId",
    "sessionId",
    "positionId",
    "principal",
    "retrievedAt",
    "items",
    "warnings",
  ] as const
  if (!record(value) || !exactKeys(value, keys)) {
    invalidRecord("memory-recall.v1 carries unknown or missing fields")
  }
  if (value.schemaVersion !== MEMORY_RECALL_SCHEMA_VERSION) {
    invalidRecord(`schemaVersion must be ${MEMORY_RECALL_SCHEMA_VERSION}`)
  }
  const positionId =
    typeof value.positionId === "string" ? value.positionId : ""
  const principal = derivePositionPrincipal(positionId)
  if (value.principal !== principal) {
    throw new MemoryPortError(
      "MEMORY_SCOPE_MISMATCH",
      "recalled principal does not match the addressed position",
      { status: 403 },
    )
  }
  if (!Array.isArray(value.items) || value.items.length > MEMORY_RECALL_MAX_ITEMS) {
    invalidRecord(`items must contain at most ${MEMORY_RECALL_MAX_ITEMS} entries`)
  }
  const items = value.items.map(validateRecallItem)
  if (
    items.reduce((sum, item) => sum + byteLength(item.text), 0) >
    MEMORY_RECALL_MAX_TOTAL_BYTES
  ) {
    invalidRecord("memory recall exceeds its total UTF-8 byte bound")
  }
  if (!Array.isArray(value.warnings) || value.warnings.length > 1) {
    invalidRecord("warnings must be an array with at most one entry")
  }
  const warnings = value.warnings.map((warning): MemoryRecallWarning => {
    if (
      !record(warning) ||
      !exactKeys(warning, ["code", "message", "retryable"]) ||
      warning.code !== "MEMORY_UNAVAILABLE" ||
      warning.message !== "Durable memory is temporarily unavailable." ||
      warning.retryable !== true
    ) {
      invalidRecord("memory recall warning is invalid")
    }
    return {
      code: "MEMORY_UNAVAILABLE",
      message: "Durable memory is temporarily unavailable.",
      retryable: true,
    }
  })
  if (warnings.length > 0 && items.length > 0) {
    invalidRecord("a degraded recall must be empty")
  }
  return {
    schemaVersion: MEMORY_RECALL_SCHEMA_VERSION,
    workspaceInstanceId: uuid(value.workspaceInstanceId, "workspaceInstanceId"),
    sessionId: uuid(value.sessionId, "sessionId"),
    positionId,
    principal,
    retrievedAt: rfc3339(value.retrievedAt, "retrievedAt"),
    items,
    warnings,
  }
}
