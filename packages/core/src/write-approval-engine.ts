/**
 * Stateful write-approval engine enforcing the lifecycle state machine.
 */

import { createHash, randomUUID } from "node:crypto"

import {
  WRITE_APPROVAL_VERSION,
  classifyApprovalGuard,
  computePreviewDigest,
  deriveIdempotencyKey,
  validateWriteApprovalDecision,
  validateWritePreviewRequest,
  WriteApprovalValidationError,
} from "./write-approval.js"
import type {
  WriteApprovalDecision,
  WriteApprovalState,
  WriteAuditEvent,
  WriteExecutionResult,
  WritePreview,
  WritePreviewRequest,
} from "./write-approval.js"

interface InternalEntry {
  preview: WritePreview
  decision: WriteApprovalDecision | null
  result: WriteExecutionResult | null
  timeline: Array<{ state: WriteApprovalState; timestamp: number }>
}

export class WriteApprovalEngine {
  private entries = new Map<string, InternalEntry>()
  private consumedKeys = new Set<string>()
  private idempotencyCache = new Map<string, WriteExecutionResult>()

  createPreview(request: WritePreviewRequest): WritePreview {
    const validated = validateWritePreviewRequest(request)

    // Check undeclared tool
    if (validated.declaredTools && !validated.declaredTools.includes(validated.toolName)) {
      throw new WriteApprovalValidationError(`undeclared_tool: ${validated.toolName}`)
    }

    const previewDigest = computePreviewDigest(validated.target, validated.effect)
    const idempotencyKey = deriveIdempotencyKey(
      validated.taskId,
      validated.toolName,
      validated.target.uri,
      validated.effect.type,
      previewDigest,
    )
    const previewId = randomUUID()
    const fencingToken = randomUUID()
    const now = Date.now()

    const preview: WritePreview = {
      previewId,
      version: WRITE_APPROVAL_VERSION,
      state: "preview_validated",
      request: validated,
      previewDigest,
      idempotencyKey,
      attempt: 1,
      fencingToken,
      createdAt: now,
    }

    const entry: InternalEntry = {
      preview,
      decision: null,
      result: null,
      timeline: [
        { state: "preview_pending", timestamp: now },
        { state: "preview_validated", timestamp: now },
      ],
    }

    this.entries.set(previewId, entry)
    return preview
  }

  submitDecision(decision: WriteApprovalDecision): void {
    const entry = this.entries.get(decision.previewId)
    if (!entry) {
      throw new WriteApprovalValidationError("unknown previewId")
    }

    // Validate decision binding
    validateWriteApprovalDecision(decision, entry.preview)

    // State machine: must be in preview_validated
    if (entry.preview.state !== "preview_validated") {
      throw new WriteApprovalValidationError(
        `invalid state transition: cannot submit decision in state ${entry.preview.state}`,
      )
    }

    const now = Date.now()

    if (!decision.approved) {
      entry.preview.state = "denied"
      entry.decision = decision
      entry.timeline.push({ state: "denied", timestamp: now })
      return
    }

    // Guard checks
    const guard = classifyApprovalGuard(decision, now, this.consumedKeys, {
      preview: entry.preview,
      idempotencyKey: entry.preview.idempotencyKey,
    })

    if (!guard.allowed) {
      throw new WriteApprovalValidationError(guard.code ?? "guard_failed")
    }

    entry.preview.state = "approved"
    entry.decision = decision
    entry.timeline.push({ state: "approved", timestamp: now })
  }

  async execute(
    previewId: string,
    executor: () => Promise<{
      success: boolean
      revision?: string
      errorCode?: string
      compensation?: { required: boolean; description: string }
    }>,
  ): Promise<WriteExecutionResult> {
    const entry = this.entries.get(previewId)
    if (!entry) {
      throw new WriteApprovalValidationError("unknown previewId")
    }

    // Idempotency: same key + success → return cached
    const cached = this.idempotencyCache.get(entry.preview.idempotencyKey)
    if (cached && cached.success) {
      return cached
    }

    // State machine: must be approved (or failed for retry)
    if (entry.preview.state !== "approved" && entry.preview.state !== "failed") {
      throw new WriteApprovalValidationError(
        `invalid state transition: cannot execute in state ${entry.preview.state}`,
      )
    }

    const now = Date.now()
    entry.preview.state = "executing"
    entry.timeline.push({ state: "executing", timestamp: now })

    let outcome: Awaited<ReturnType<typeof executor>>
    try {
      outcome = await executor()
    } catch (err) {
      const failNow = Date.now()
      entry.preview.state = "failed"
      entry.timeline.push({ state: "failed", timestamp: failNow })
      const result: WriteExecutionResult = {
        previewId,
        state: "failed",
        success: false,
        errorCode: err instanceof Error ? err.message : "unknown_error",
        idempotencyKey: entry.preview.idempotencyKey,
        executedAt: failNow,
      }
      entry.result = result
      return result
    }

    const endNow = Date.now()
    let finalState: WriteApprovalState

    if (outcome.success) {
      finalState = "success"
    } else if (outcome.compensation?.required) {
      finalState = "partial_fail"
    } else {
      finalState = "failed"
    }

    entry.preview.state = finalState
    entry.timeline.push({ state: finalState, timestamp: endNow })

    const result: WriteExecutionResult = {
      previewId,
      state: finalState,
      success: outcome.success,
      revision: outcome.revision,
      errorCode: outcome.errorCode,
      compensation: outcome.compensation,
      idempotencyKey: entry.preview.idempotencyKey,
      executedAt: endNow,
    }

    entry.result = result

    if (outcome.success) {
      this.consumedKeys.add(entry.preview.idempotencyKey)
      this.idempotencyCache.set(entry.preview.idempotencyKey, result)
    } else {
      // Allow retry: bump attempt and fencing token
      entry.preview.attempt += 1
      entry.preview.fencingToken = randomUUID()
      // Move back to preview_validated for re-approval
      entry.preview.state = "preview_validated"
      entry.timeline.push({ state: "preview_validated", timestamp: endNow })
    }

    return result
  }

  getAuditEvent(previewId: string): WriteAuditEvent {
    const entry = this.entries.get(previewId)
    if (!entry) {
      throw new WriteApprovalValidationError("unknown previewId")
    }
    return {
      previewId,
      version: WRITE_APPROVAL_VERSION,
      request: entry.preview.request,
      preview: entry.preview,
      decision: entry.decision,
      result: entry.result,
      timeline: [...entry.timeline],
    }
  }
}
