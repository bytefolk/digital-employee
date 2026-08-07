/**
 * Write-approval lifecycle: request → preview → approval/denial → execution → result/audit
 */

import { createHash } from "node:crypto"

export const WRITE_APPROVAL_VERSION = "write-approval.v1" as const

// --- States ---

export type WriteApprovalState =
  | "preview_pending"
  | "preview_validated"
  | "approved"
  | "denied"
  | "expired"
  | "executing"
  | "success"
  | "failed"
  | "partial_fail"

// --- Error codes ---

export type WriteApprovalErrorCode =
  | "stale_base_revision"
  | "tampered_preview"
  | "stale_attempt"
  | "fencing_mismatch"
  | "already_consumed"
  | "approval_expired"
  | "undeclared_tool"
  | "approval_not_configured"
  | "permission_revoked"

// --- Interfaces ---

export interface WriteTarget {
  uri: string
  baseRevision?: string
  [key: string]: unknown
}

export interface WriteEffect {
  type: string
  canonicalPayload: string
  [key: string]: unknown
}

export interface WritePreviewRequest {
  taskId: string
  toolName: string
  target: WriteTarget
  effect: WriteEffect
  declaredTools?: string[]
}

export interface WritePreview {
  previewId: string
  version: typeof WRITE_APPROVAL_VERSION
  state: WriteApprovalState
  request: WritePreviewRequest
  previewDigest: string
  idempotencyKey: string
  attempt: number
  fencingToken: string
  createdAt: number
}

export interface WriteApprovalDecision {
  previewId: string
  approved: boolean
  previewDigest: string
  attempt: number
  fencingToken: string
  expiresAt: number
  decidedBy: string
  reason?: string
}

export interface WriteExecutionResult {
  previewId: string
  state: WriteApprovalState
  success: boolean
  revision?: string
  errorCode?: string
  compensation?: { required: boolean; description: string }
  idempotencyKey: string
  executedAt: number
}

export interface WriteAuditEvent {
  previewId: string
  version: typeof WRITE_APPROVAL_VERSION
  request: WritePreviewRequest
  preview: WritePreview
  decision: WriteApprovalDecision | null
  result: WriteExecutionResult | null
  timeline: Array<{ state: WriteApprovalState; timestamp: number }>
}

// --- Functions ---

export function computePreviewDigest(target: WriteTarget, effect: WriteEffect): string {
  const sortedTarget = canonicalJson(target)
  const sortedEffect = canonicalJson(effect)
  const payload = JSON.stringify({ target: sortedTarget, effect: sortedEffect })
  return createHash("sha256").update(payload).digest("hex")
}

export function deriveIdempotencyKey(
  taskId: string,
  toolName: string,
  targetUri: string,
  effectType: string,
  previewDigest: string,
): string {
  const input = [taskId, toolName, targetUri, effectType, previewDigest].join("|")
  return createHash("sha256").update(input).digest("hex")
}

export function validateWritePreviewRequest(input: unknown): WritePreviewRequest {
  if (input === null || typeof input !== "object") {
    throw new WriteApprovalValidationError("input must be a non-null object")
  }
  const obj = input as Record<string, unknown>
  if (typeof obj.taskId !== "string" || obj.taskId.length === 0) {
    throw new WriteApprovalValidationError("taskId must be a non-empty string")
  }
  if (typeof obj.toolName !== "string" || obj.toolName.length === 0) {
    throw new WriteApprovalValidationError("toolName must be a non-empty string")
  }
  if (obj.target === null || typeof obj.target !== "object") {
    throw new WriteApprovalValidationError("target must be a non-null object")
  }
  const target = obj.target as Record<string, unknown>
  if (typeof target.uri !== "string" || target.uri.length === 0) {
    throw new WriteApprovalValidationError("target.uri must be a non-empty string")
  }
  if (obj.effect === null || typeof obj.effect !== "object") {
    throw new WriteApprovalValidationError("effect must be a non-null object")
  }
  const effect = obj.effect as Record<string, unknown>
  if (typeof effect.type !== "string" || effect.type.length === 0) {
    throw new WriteApprovalValidationError("effect.type must be a non-empty string")
  }
  if (typeof effect.canonicalPayload !== "string") {
    throw new WriteApprovalValidationError("effect.canonicalPayload must be a string")
  }
  if (obj.declaredTools !== undefined) {
    if (!Array.isArray(obj.declaredTools)) {
      throw new WriteApprovalValidationError("declaredTools must be an array")
    }
    for (const t of obj.declaredTools) {
      if (typeof t !== "string") {
        throw new WriteApprovalValidationError("declaredTools entries must be strings")
      }
    }
  }
  return {
    taskId: obj.taskId as string,
    toolName: obj.toolName as string,
    target: obj.target as WriteTarget,
    effect: obj.effect as WriteEffect,
    declaredTools: obj.declaredTools as string[] | undefined,
  }
}

export function validateWriteApprovalDecision(
  input: unknown,
  preview: WritePreview,
): WriteApprovalDecision {
  if (input === null || typeof input !== "object") {
    throw new WriteApprovalValidationError("decision must be a non-null object")
  }
  const obj = input as Record<string, unknown>
  if (typeof obj.previewId !== "string" || obj.previewId !== preview.previewId) {
    throw new WriteApprovalValidationError("decision.previewId must match preview")
  }
  if (typeof obj.approved !== "boolean") {
    throw new WriteApprovalValidationError("decision.approved must be a boolean")
  }
  if (typeof obj.previewDigest !== "string") {
    throw new WriteApprovalValidationError("decision.previewDigest must be a string")
  }
  if (typeof obj.attempt !== "number") {
    throw new WriteApprovalValidationError("decision.attempt must be a number")
  }
  if (typeof obj.fencingToken !== "string") {
    throw new WriteApprovalValidationError("decision.fencingToken must be a string")
  }
  if (typeof obj.expiresAt !== "number") {
    throw new WriteApprovalValidationError("decision.expiresAt must be a number")
  }
  if (typeof obj.decidedBy !== "string") {
    throw new WriteApprovalValidationError("decision.decidedBy must be a string")
  }
  return {
    previewId: obj.previewId as string,
    approved: obj.approved as boolean,
    previewDigest: obj.previewDigest as string,
    attempt: obj.attempt as number,
    fencingToken: obj.fencingToken as string,
    expiresAt: obj.expiresAt as number,
    decidedBy: obj.decidedBy as string,
    reason: typeof obj.reason === "string" ? obj.reason : undefined,
  }
}

export function classifyApprovalGuard(
  decision: WriteApprovalDecision,
  nowMs: number,
  consumedKeys: Set<string>,
  context?: { preview: WritePreview; idempotencyKey?: string },
): { allowed: boolean; code?: WriteApprovalErrorCode } {
  // Check tampered preview
  if (context?.preview && decision.previewDigest !== context.preview.previewDigest) {
    return { allowed: false, code: "tampered_preview" }
  }
  // Check stale attempt
  if (context?.preview && decision.attempt !== context.preview.attempt) {
    return { allowed: false, code: "stale_attempt" }
  }
  // Check fencing token
  if (context?.preview && decision.fencingToken !== context.preview.fencingToken) {
    return { allowed: false, code: "fencing_mismatch" }
  }
  // Check already consumed
  const key = context?.idempotencyKey ?? decision.previewId
  if (consumedKeys.has(key)) {
    return { allowed: false, code: "already_consumed" }
  }
  // Check expiry
  if (nowMs > decision.expiresAt) {
    return { allowed: false, code: "approval_expired" }
  }
  return { allowed: true }
}

// --- Helpers ---

function canonicalJson(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj
  if (Array.isArray(obj)) return obj.map(canonicalJson)
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = canonicalJson((obj as Record<string, unknown>)[key])
  }
  return sorted
}

export class WriteApprovalValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WriteApprovalValidationError"
  }
}
