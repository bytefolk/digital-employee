import type { SafeValue } from "../../core/src/contracts.js"

import {
  validatePositionBudgetDeclaration,
  type PositionBudgetDeclaration,
} from "./budget.js"
import type { OrganizationPermissions } from "./org-permissions.js"

/**
 * Built-in execution engine protocol identity.
 *
 * The engine is the workspace's default execution body. It speaks its own
 * contract vocabulary (independently defined); the event *shape* is kept
 * compatible with agent-host.v1 so the workbench stays engine-agnostic.
 */
export const ENGINE_PROTOCOL_VERSION = "engine.v1" as const
export const ENGINE_ID = "built-in" as const
export const ENGINE_VERSION = "0.1.0" as const

/**
 * Terminal reasons are this repository's own enumeration. They are NOT a
 * translation of any external enumeration; the coverage mapping is maintained
 * only in internal design documents.
 */
export type TerminalReason =
  | "goal_met"
  | "invalid_output_exhausted"
  | "turn_budget_exceeded"
  | "position_budget_exceeded"
  | "iteration_cap"
  | "doom_loop"
  | "deadline_exceeded"
  | "cancelled"
  | "permission_denied"
  | "memory_unavailable"
  | "memory_denied"
  | "engine_internal_error"

/** Lowercase ASCII machine code: `[a-z0-9][a-z0-9._-]{0,127}`. */
export const ENGINE_ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/

export interface EngineTerminalError {
  code: string
  message: string
  retryable: boolean
  terminalReason: TerminalReason
}

interface EngineEventBase {
  runId: string
  timestamp: string
}

export type EngineEvent =
  | (EngineEventBase & { type: "run.started" })
  | (EngineEventBase & { type: "model.delta"; text: string })
  | (EngineEventBase & {
      type: "usage"
      inputTokens?: number
      outputTokens?: number
      totalTokens?: number
    })
  | (EngineEventBase & {
      type: "run.completed"
      output: SafeValue
      terminalReason: "goal_met"
    })
  | (EngineEventBase & {
      type: "run.failed"
      error: EngineTerminalError
    })
  // Approval gate vocabulary (#187, Option 1 terminal-and-resume). Additive:
  // the five existing event shapes are unchanged. `requested` settles the
  // requesting run as a retryable failure; `granted`/`denied` are the resume
  // run's authoritative records of the operator verdict being consumed at the
  // trust boundary — records, not the authorization itself, which still
  // comes from the policy projection. Hard ordering rule: within a run,
  // granted/denied presuppose a matching requested (emitted in this run or
  // inherited from the referenced request turn).
  | (EngineEventBase & {
      type: "approval.requested"
      /** Stable across the request turn and the resume turn. */
      approvalId: string
      action: {
        kind: TurnApprovalActionKind
        /** Bounded human-readable description, <= 1 KiB. */
        description: string
        /** Command/path/host/tool name, <= 512 B. */
        target?: string
      }
      reason?: string
      /** ISO 8601; defaults to being bounded by the run deadline. */
      expiresAt?: string
    })
  | (EngineEventBase & {
      type: "approval.granted"
      approvalId: string
      grantedBy: "operator"
      /** once = this action only; run = same-kind actions within this run. */
      scope: "once" | "run"
    })
  | (EngineEventBase & {
      type: "approval.denied"
      approvalId: string
      deniedBy: "operator"
      reason?: string
    })

export function isTerminalEngineEvent(
  event: EngineEvent,
): event is Extract<EngineEvent, { type: "run.completed" | "run.failed" }> {
  return event.type === "run.completed" || event.type === "run.failed"
}

/**
 * Budget carried by a single turn. `maxIterations` bounds the
 * validate/repair loop and is mandatory (no unbounded runs). Token budget is
 * optional at the skeleton stage; full dual-dimension budget consumption
 * (turn + position) lands with the loop-control slice.
 */
export interface TurnBudget {
  maxIterations: number
  maxTokens?: number
}

export interface PositionContextInput {
  /** Position package instructions (SKILL/instruction asset). */
  instructions?: string
  /** Organization-tree role descriptor projection. */
  spec?: string
}

/** Capability-gate action kinds for approval requests (#187). */
export type TurnApprovalActionKind = "exec" | "write" | "network" | "tool"

/**
 * Bounded reference to the write-approval.v1 preview that must precede any
 * approval request (#187 AC-001): a write action without a validated
 * preview fails closed.
 */
export interface TurnApprovalPreviewRef {
  /** Must equal write-approval.v1. */
  version: string
  previewId: string
  previewDigest: string
  /** Must equal preview_validated. */
  state: string
}

export interface TurnApprovalActionInput {
  kind: TurnApprovalActionKind
  /** Bounded human-readable description, <= 1 KiB. */
  description: string
  /** Command/path/host/tool name, <= 512 B. */
  target?: string
  preview: TurnApprovalPreviewRef
}

/**
 * Operator verdict carried by the resume turn (#187 Option 1). The verdict
 * arrives through the sealed envelope of the next turn run; there is no
 * in-run inbound channel.
 */
export interface TurnPendingApprovalInput {
  /** Must match the approvalId of the referenced approval.requested. */
  approvalId: string
  decision: "granted" | "denied"
  decidedBy: "operator"
  /** Defaults to "once" when granted. */
  scope?: "once" | "run"
  reason?: string
  /** ISO 8601; a verdict past this bound fails closed as expired. */
  expiresAt?: string
}

export interface EngineTurnRequest {
  workspaceRef: string
  positionId: string
  turnId: string
  runId: string
  /** Bounded, schema-validated turn input. */
  input: SafeValue
  budget: TurnBudget
  /** Synchronous terminal schema, <= 16 KiB, compiled once. */
  outputSchema?: SafeValue
  position?: PositionContextInput
  /** ISO 8601 UTC deadline; exceeding fails closed. */
  deadline?: string
  signal?: AbortSignal
  /**
   * Position budget declaration from the organization model (per-task and
   * per-day caps). When present, taskId and dayKey are mandatory so the
   * ledger can attribute consumption.
   */
  positionBudget?: PositionBudgetDeclaration
  taskId?: string
  dayKey?: string
  /**
   * Organization permissions artifact (org-permissions.v1, recomputed by
   * `org apply`) for runtime enforcement (#159 REQ-004/REQ-009). When
   * present, the engine enforces Context Scope and Authority Scope before any
   * model consumption; a turn always consumes the current artifact.
   */
  permissions?: OrganizationPermissions
  /** Context paths this turn requests to read (enforced vs Context Scope). */
  contextReadRequests?: readonly string[]
  /** Tools this turn requests to call (enforced vs Authority Scope). */
  toolRequests?: readonly string[]
  /**
   * Write action declared at the capability gate (#187). Requires a
   * validated write-approval.v1 preview; the requesting turn settles as a
   * retryable failure carrying approval.requested. Mutually exclusive with
   * pendingApproval.
   */
  approvalAction?: TurnApprovalActionInput
  /**
   * Operator verdict for a previously requested approval (#187 Option 1),
   * consumed by the resume turn before any model consumption. Mutually
   * exclusive with approvalAction.
   */
  pendingApproval?: TurnPendingApprovalInput
}

const MAX_ID_LENGTH = 256
const MAX_INPUT_BYTES = 256 * 1024

export class EngineRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message)
    this.name = "EngineRequestError"
  }
}

function assertBoundedId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new EngineRequestError(
      "engine.input_invalid",
      `${label} must be a non-empty string`,
    )
  }
  if (value.length > MAX_ID_LENGTH) {
    throw new EngineRequestError(
      "engine.input_invalid",
      `${label} exceeds the bounded identifier length`,
    )
  }
  return value
}

/**
 * Fail-closed request validation. Any malformed field rejects the turn before
 * any model consumption, assembly, or side effect.
 */
export function validateTurnRequest(
  request: EngineTurnRequest,
): EngineTurnRequest {
  assertBoundedId(request.workspaceRef, "workspaceRef")
  assertBoundedId(request.positionId, "positionId")
  assertBoundedId(request.turnId, "turnId")
  assertBoundedId(request.runId, "runId")
  if (
    typeof request.input === "string" &&
    Buffer.byteLength(request.input, "utf8") > MAX_INPUT_BYTES
  ) {
    throw new EngineRequestError(
      "engine.input_invalid",
      "turn input exceeds the bounded size",
    )
  }
  if (
    !request.budget ||
    !Number.isInteger(request.budget.maxIterations) ||
    request.budget.maxIterations < 1
  ) {
    throw new EngineRequestError(
      "engine.input_invalid",
      "budget.maxIterations must be a positive integer",
    )
  }
  if (
    request.budget.maxTokens !== undefined &&
    (!Number.isInteger(request.budget.maxTokens) ||
      request.budget.maxTokens < 1)
  ) {
    throw new EngineRequestError(
      "engine.input_invalid",
      "budget.maxTokens must be a positive integer when present",
    )
  }
  if (request.deadline !== undefined) {
    const parsed = Date.parse(request.deadline)
    if (Number.isNaN(parsed)) {
      throw new EngineRequestError(
        "engine.input_invalid",
        "deadline must be a valid ISO 8601 timestamp",
      )
    }
  }
  if (request.positionBudget !== undefined) {
    try {
      validatePositionBudgetDeclaration(request.positionBudget)
    } catch {
      throw new EngineRequestError(
        "engine.input_invalid",
        "positionBudget must be fully allocated (perTask and perDay caps)",
      )
    }
    assertBoundedId(request.taskId, "taskId")
    assertBoundedId(request.dayKey, "dayKey")
  }
  validateApprovalRequestFields(request)
  return request
}

const APPROVAL_ACTION_KINDS: ReadonlySet<string> = new Set([
  "exec",
  "write",
  "network",
  "tool",
])
const APPROVAL_DESCRIPTION_MAX_BYTES = 1024
const APPROVAL_TARGET_MAX_BYTES = 512

function assertBoundedText(
  value: unknown,
  label: string,
  maxBytes: number,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new EngineRequestError(
      "engine.input_invalid",
      `${label} must be a non-empty string`,
    )
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new EngineRequestError(
      "engine.input_invalid",
      `${label} exceeds the bounded size`,
    )
  }
  return value
}

function assertOptionalTimestamp(value: unknown, label: string): void {
  if (value === undefined) return
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new EngineRequestError(
      "engine.input_invalid",
      `${label} must be a valid ISO 8601 timestamp`,
    )
  }
}

/**
 * Fail-closed shape checks for the #187 approval gate fields. The request
 * turn (approvalAction) and the resume turn (pendingApproval) are mutually
 * exclusive: carrying both violates the request-then-verdict ordering and
 * rejects before any model consumption.
 */
function validateApprovalRequestFields(request: EngineTurnRequest): void {
  const { approvalAction, pendingApproval } = request
  if (approvalAction !== undefined && pendingApproval !== undefined) {
    throw new EngineRequestError(
      "engine.input_invalid",
      "approvalAction and pendingApproval are mutually exclusive within one turn",
    )
  }
  if (approvalAction !== undefined) {
    if (!APPROVAL_ACTION_KINDS.has(approvalAction.kind)) {
      throw new EngineRequestError(
        "engine.input_invalid",
        "approvalAction.kind must be one of exec, write, network, tool",
      )
    }
    assertBoundedText(
      approvalAction.description,
      "approvalAction.description",
      APPROVAL_DESCRIPTION_MAX_BYTES,
    )
    if (approvalAction.target !== undefined) {
      assertBoundedText(
        approvalAction.target,
        "approvalAction.target",
        APPROVAL_TARGET_MAX_BYTES,
      )
    }
    const preview = approvalAction.preview
    if (preview === null || typeof preview !== "object") {
      throw new EngineRequestError(
        "engine.input_invalid",
        "approvalAction.preview must be an object",
      )
    }
    assertBoundedId(preview.previewId, "approvalAction.preview.previewId")
    assertBoundedId(
      preview.previewDigest,
      "approvalAction.preview.previewDigest",
    )
    assertBoundedId(preview.version, "approvalAction.preview.version")
    assertBoundedId(preview.state, "approvalAction.preview.state")
  }
  if (pendingApproval !== undefined) {
    assertBoundedId(pendingApproval.approvalId, "pendingApproval.approvalId")
    if (
      pendingApproval.decision !== "granted" &&
      pendingApproval.decision !== "denied"
    ) {
      throw new EngineRequestError(
        "engine.input_invalid",
        "pendingApproval.decision must be granted or denied",
      )
    }
    if (pendingApproval.decidedBy !== "operator") {
      throw new EngineRequestError(
        "engine.input_invalid",
        "pendingApproval.decidedBy must be operator",
      )
    }
    if (
      pendingApproval.scope !== undefined &&
      pendingApproval.scope !== "once" &&
      pendingApproval.scope !== "run"
    ) {
      throw new EngineRequestError(
        "engine.input_invalid",
        "pendingApproval.scope must be once or run when present",
      )
    }
    if (pendingApproval.reason !== undefined) {
      assertBoundedText(
        pendingApproval.reason,
        "pendingApproval.reason",
        APPROVAL_DESCRIPTION_MAX_BYTES,
      )
    }
    assertOptionalTimestamp(
      pendingApproval.expiresAt,
      "pendingApproval.expiresAt",
    )
  }
}

export function terminalError(
  code: string,
  message: string,
  terminalReason: TerminalReason,
  retryable = false,
): EngineTerminalError {
  if (!ENGINE_ERROR_CODE_PATTERN.test(code)) {
    throw new EngineRequestError(
      "engine.internal_error",
      `terminal error code violates the machine-code pattern: ${code}`,
    )
  }
  return { code, message, retryable, terminalReason }
}
