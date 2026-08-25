/**
 * Turn approval gate (#187, Option 1 terminal-and-resume).
 *
 * The engine stays one-directional: the requesting turn settles as a
 * retryable failure carrying `approval.requested`; the operator verdict
 * returns through the sealed envelope of the next turn run and is consumed
 * here, before any model consumption, as `approval.granted` /
 * `approval.denied`. There is no in-run inbound channel.
 *
 * Default policy (frozen by the #187 R2 decision, issuecomment-5409280515):
 * a write action requires an explicit operator verdict. This module has no
 * auto-grant path; changing the default requires a recorded product
 * decision (#187 AC-002).
 *
 * All approval settlement reuses the existing TerminalReason enumeration;
 * the approval lifecycle is carried by distinct error codes, not new
 * terminal reasons.
 */

import { WRITE_APPROVAL_VERSION } from "../../core/src/write-approval.js"

import type {
  TurnApprovalActionInput,
  TurnPendingApprovalInput,
} from "./contracts.js"

export const APPROVAL_REQUIRED_CODE = "engine.approval_required"
export const APPROVAL_DENIED_CODE = "engine.approval_denied"
export const APPROVAL_EXPIRED_CODE = "engine.approval_expired"
export const APPROVAL_PREVIEW_INVALID_CODE = "engine.approval_preview_invalid"

export interface ApprovalPreviewGateResult {
  allowed: boolean
  code?: string
  message?: string
}

/**
 * Preview-first gate (#187 AC-001): an approval request is only expressible
 * on top of a write-approval.v1 preview in state preview_validated. Any
 * other shape fails closed, aligned with the undeclared_tool /
 * approval_not_configured guard semantics of the write-approval vocabulary.
 */
export function previewGateAllows(
  action: TurnApprovalActionInput,
): ApprovalPreviewGateResult {
  const preview = action.preview
  if (preview.version !== WRITE_APPROVAL_VERSION) {
    return {
      allowed: false,
      code: APPROVAL_PREVIEW_INVALID_CODE,
      message: `approval request requires a ${WRITE_APPROVAL_VERSION} preview, got ${preview.version}`,
    }
  }
  if (preview.state !== "preview_validated") {
    return {
      allowed: false,
      code: APPROVAL_PREVIEW_INVALID_CODE,
      message: `approval request requires a preview in state preview_validated, got ${preview.state}`,
    }
  }
  return { allowed: true }
}

/**
 * Expiry check for a resume-turn verdict (#187 AC-005). Missing expiresAt
 * means the verdict is bounded only by the resume turn's own deadline;
 * an unparseable bound fails closed as expired.
 */
export function pendingApprovalExpired(
  pending: TurnPendingApprovalInput,
  nowMs: number,
): boolean {
  if (pending.expiresAt === undefined) return false
  const parsed = Date.parse(pending.expiresAt)
  if (Number.isNaN(parsed)) return true
  return nowMs > parsed
}
