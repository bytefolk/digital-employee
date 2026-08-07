/**
 * Task-intake approval: owner must confirm before the Runner accepts a task.
 *
 * Implements the "向上请示" (escalate upward) principle: when someone assigns
 * a task to a digital employee, the employee first asks its owner whether to
 * accept. This is upstream of write-approval (#12) — it gates task *intake*
 * regardless of whether the task involves write operations.
 *
 * Design decisions (per #49 P9 freeze):
 * - Gate lives in Runner policy layer (not platform).
 * - Pending tasks are held (not declined); they expire on timeout.
 * - Default: auto-accept when unconfigured (backward compatible).
 * - Granularity: per-task (no per-requester batching).
 * - Works offline/locally — no inbound port or platform-held owner state.
 */

import { createHash } from "node:crypto"
import { CoreError } from "./contracts.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TASK_INTAKE_APPROVAL_VERSION = "task-intake-approval.v1" as const

/** Default timeout (ms) for owner approval before auto-expiry. */
export const TASK_INTAKE_DEFAULT_TIMEOUT_MS = 300_000 // 5 minutes

/** Maximum allowed timeout (ms). */
export const TASK_INTAKE_MAX_TIMEOUT_MS = 3_600_000 // 1 hour

/** Minimum allowed timeout (ms). */
export const TASK_INTAKE_MIN_TIMEOUT_MS = 10_000 // 10 seconds

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export type TaskIntakeApprovalErrorCode =
  | "INTAKE_ALREADY_DECIDED"
  | "INTAKE_EXPIRED"
  | "INTAKE_NOT_FOUND"
  | "INTAKE_POLICY_INVALID"
  | "INTAKE_REQUEST_INVALID"

export class TaskIntakeApprovalError extends CoreError {
  constructor(code: TaskIntakeApprovalErrorCode, message?: string) {
    super(code, message ?? "Task intake approval operation failed", {
      status: 400,
      retryable: false,
    })
    this.name = "TaskIntakeApprovalError"
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskIntakeState =
  | "pending"
  | "approved"
  | "declined"
  | "expired"
  | "auto_accepted"

export interface TaskIntakePolicy {
  /** Whether owner approval is required before accepting tasks. */
  requireOwnerApproval: boolean
  /** Timeout in ms before a pending approval auto-expires. */
  timeoutMs?: number
}

export interface TaskIntakeRequest {
  /** Unique task identifier from the signed task payload. */
  taskId: string
  /** Lease identifier from the transport claim. */
  leaseId: string
  /** ISO-8601 timestamp when the lease expires. */
  leaseExpiresAt: string
  /** Employee identifier the task is addressed to. */
  employeeId: string
  /** Runner identifier processing this task. */
  runnerId: string
  /** ISO-8601 timestamp when the request was created. */
  requestedAt: string
}

export interface TaskIntakeRecord {
  version: typeof TASK_INTAKE_APPROVAL_VERSION
  taskId: string
  leaseId: string
  leaseExpiresAt: string
  employeeId: string
  runnerId: string
  state: TaskIntakeState
  requestedAt: string
  decidedAt: string | null
  decidedBy: string | null
  reason: string | null
  expiresAt: string
  digest: string
}

export interface TaskIntakeDecision {
  taskId: string
  approved: boolean
  decidedBy: string
  reason?: string
}

/**
 * Event emitted into the normalized event chain for observability (AC-002).
 */
export interface TaskIntakeEvent {
  version: typeof TASK_INTAKE_APPROVAL_VERSION
  type: "task_intake.state_change"
  taskId: string
  leaseId: string
  previousState: TaskIntakeState | null
  newState: TaskIntakeState
  timestamp: string
  digest: string
}

// ---------------------------------------------------------------------------
// Policy validation
// ---------------------------------------------------------------------------

export function validateTaskIntakePolicy(input: unknown): TaskIntakePolicy {
  if (input === null || typeof input !== "object") {
    throw new TaskIntakeApprovalError(
      "INTAKE_POLICY_INVALID",
      "Policy must be a non-null object",
    )
  }
  const obj = input as Record<string, unknown>
  if (typeof obj.requireOwnerApproval !== "boolean") {
    throw new TaskIntakeApprovalError(
      "INTAKE_POLICY_INVALID",
      "requireOwnerApproval must be a boolean",
    )
  }
  let timeoutMs: number | undefined
  if (obj.timeoutMs !== undefined) {
    if (
      typeof obj.timeoutMs !== "number" ||
      !Number.isSafeInteger(obj.timeoutMs) ||
      obj.timeoutMs < TASK_INTAKE_MIN_TIMEOUT_MS ||
      obj.timeoutMs > TASK_INTAKE_MAX_TIMEOUT_MS
    ) {
      throw new TaskIntakeApprovalError(
        "INTAKE_POLICY_INVALID",
        `timeoutMs must be an integer between ${TASK_INTAKE_MIN_TIMEOUT_MS} and ${TASK_INTAKE_MAX_TIMEOUT_MS}`,
      )
    }
    timeoutMs = obj.timeoutMs
  }
  return {
    requireOwnerApproval: obj.requireOwnerApproval,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  }
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

export function validateTaskIntakeRequest(input: unknown): TaskIntakeRequest {
  if (input === null || typeof input !== "object") {
    throw new TaskIntakeApprovalError(
      "INTAKE_REQUEST_INVALID",
      "Request must be a non-null object",
    )
  }
  const obj = input as Record<string, unknown>
  for (const field of ["taskId", "leaseId", "leaseExpiresAt", "employeeId", "runnerId", "requestedAt"] as const) {
    if (typeof obj[field] !== "string" || (obj[field] as string).length === 0) {
      throw new TaskIntakeApprovalError(
        "INTAKE_REQUEST_INVALID",
        `${field} must be a non-empty string`,
      )
    }
  }
  return {
    taskId: obj.taskId as string,
    leaseId: obj.leaseId as string,
    leaseExpiresAt: obj.leaseExpiresAt as string,
    employeeId: obj.employeeId as string,
    runnerId: obj.runnerId as string,
    requestedAt: obj.requestedAt as string,
  }
}

// ---------------------------------------------------------------------------
// Digest computation
// ---------------------------------------------------------------------------

export function computeTaskIntakeDigest(
  taskId: string,
  leaseId: string,
  state: TaskIntakeState,
  requestedAt: string,
): string {
  const payload = [taskId, leaseId, state, requestedAt].join("|")
  return createHash("sha256").update(payload).digest("hex")
}

// ---------------------------------------------------------------------------
// Evaluate policy gate
// ---------------------------------------------------------------------------

/**
 * Determines the initial intake state based on the configured policy.
 * When policy does not require approval, the task is auto-accepted immediately.
 */
export function evaluateIntakeGate(
  policy: TaskIntakePolicy,
): { requiresApproval: boolean } {
  return { requiresApproval: policy.requireOwnerApproval }
}

// ---------------------------------------------------------------------------
// TaskIntakeGate — stateful per-runner gate
// ---------------------------------------------------------------------------

export class TaskIntakeGate {
  private readonly records = new Map<string, TaskIntakeRecord>()
  private readonly events: TaskIntakeEvent[] = []
  private readonly policy: TaskIntakePolicy
  private readonly clock: () => Date

  constructor(options: { policy: TaskIntakePolicy; clock?: () => Date }) {
    this.policy = options.policy
    this.clock = options.clock ?? (() => new Date())
  }

  /**
   * Submit a task for intake approval. Returns the initial record.
   * If policy does not require approval, immediately auto-accepts.
   */
  submit(request: TaskIntakeRequest): TaskIntakeRecord {
    const validated = validateTaskIntakeRequest(request)
    if (this.records.has(validated.taskId)) {
      throw new TaskIntakeApprovalError(
        "INTAKE_ALREADY_DECIDED",
        `Task ${validated.taskId} already submitted for intake`,
      )
    }

    const now = this.clock()
    const timeoutMs = this.policy.timeoutMs ?? TASK_INTAKE_DEFAULT_TIMEOUT_MS
    // Expiry is the earlier of policy timeout or lease expiry
    const policyExpiry = new Date(now.getTime() + timeoutMs)
    const leaseExpiry = new Date(validated.leaseExpiresAt)
    const expiresAt = policyExpiry < leaseExpiry ? policyExpiry : leaseExpiry

    const initialState: TaskIntakeState = this.policy.requireOwnerApproval
      ? "pending"
      : "auto_accepted"

    const record: TaskIntakeRecord = {
      version: TASK_INTAKE_APPROVAL_VERSION,
      taskId: validated.taskId,
      leaseId: validated.leaseId,
      leaseExpiresAt: validated.leaseExpiresAt,
      employeeId: validated.employeeId,
      runnerId: validated.runnerId,
      state: initialState,
      requestedAt: validated.requestedAt,
      decidedAt: initialState === "auto_accepted" ? now.toISOString() : null,
      decidedBy: initialState === "auto_accepted" ? "policy:auto_accept" : null,
      reason: null,
      expiresAt: expiresAt.toISOString(),
      digest: computeTaskIntakeDigest(
        validated.taskId,
        validated.leaseId,
        initialState,
        validated.requestedAt,
      ),
    }

    this.records.set(validated.taskId, record)
    this.emitEvent(validated.taskId, null, initialState)
    return record
  }

  /**
   * Record an owner decision (approve or decline) for a pending task.
   */
  decide(decision: TaskIntakeDecision): TaskIntakeRecord {
    if (typeof decision.taskId !== "string" || decision.taskId.length === 0) {
      throw new TaskIntakeApprovalError(
        "INTAKE_REQUEST_INVALID",
        "decision.taskId must be a non-empty string",
      )
    }
    const record = this.records.get(decision.taskId)
    if (!record) {
      throw new TaskIntakeApprovalError(
        "INTAKE_NOT_FOUND",
        `No intake record for task ${decision.taskId}`,
      )
    }
    if (record.state !== "pending") {
      throw new TaskIntakeApprovalError(
        "INTAKE_ALREADY_DECIDED",
        `Task ${decision.taskId} is already in state '${record.state}'`,
      )
    }

    // Check if expired before applying decision
    const now = this.clock()
    if (now >= new Date(record.expiresAt)) {
      const previousState = record.state
      record.state = "expired"
      record.decidedAt = now.toISOString()
      record.decidedBy = "system:timeout"
      record.digest = computeTaskIntakeDigest(
        record.taskId,
        record.leaseId,
        record.state,
        record.requestedAt,
      )
      this.emitEvent(record.taskId, previousState, "expired")
      throw new TaskIntakeApprovalError(
        "INTAKE_EXPIRED",
        `Task ${decision.taskId} intake approval has expired`,
      )
    }

    const previousState = record.state
    const newState: TaskIntakeState = decision.approved ? "approved" : "declined"
    record.state = newState
    record.decidedAt = now.toISOString()
    record.decidedBy = decision.decidedBy
    record.reason = decision.reason ?? null
    record.digest = computeTaskIntakeDigest(
      record.taskId,
      record.leaseId,
      record.state,
      record.requestedAt,
    )
    this.emitEvent(record.taskId, previousState, newState)
    return record
  }

  /**
   * Expire any pending records that have passed their timeout.
   * Returns the list of task IDs that were expired.
   */
  expirePending(): string[] {
    const now = this.clock()
    const expired: string[] = []
    for (const record of this.records.values()) {
      if (record.state === "pending" && now >= new Date(record.expiresAt)) {
        const previousState = record.state
        record.state = "expired"
        record.decidedAt = now.toISOString()
        record.decidedBy = "system:timeout"
        record.digest = computeTaskIntakeDigest(
          record.taskId,
          record.leaseId,
          record.state,
          record.requestedAt,
        )
        this.emitEvent(record.taskId, previousState, "expired")
        expired.push(record.taskId)
      }
    }
    return expired
  }

  /**
   * Query the current intake record for a task.
   */
  get(taskId: string): TaskIntakeRecord | null {
    return this.records.get(taskId) ?? null
  }

  /**
   * Whether the task is allowed to proceed to Host execution (AC-002).
   */
  canLaunch(taskId: string): boolean {
    const record = this.records.get(taskId)
    if (!record) return false
    return record.state === "approved" || record.state === "auto_accepted"
  }

  /**
   * Return all emitted intake events (for observability / event chain).
   */
  drainEvents(): TaskIntakeEvent[] {
    return this.events.splice(0, this.events.length)
  }

  /**
   * Return the number of pending approvals.
   */
  pendingCount(): number {
    let count = 0
    for (const record of this.records.values()) {
      if (record.state === "pending") count++
    }
    return count
  }

  private emitEvent(
    taskId: string,
    previousState: TaskIntakeState | null,
    newState: TaskIntakeState,
  ): void {
    const record = this.records.get(taskId)!
    const timestamp = this.clock().toISOString()
    const digest = createHash("sha256")
      .update(
        [
          TASK_INTAKE_APPROVAL_VERSION,
          taskId,
          record.leaseId,
          previousState ?? "null",
          newState,
          timestamp,
        ].join("|"),
      )
      .digest("hex")

    this.events.push({
      version: TASK_INTAKE_APPROVAL_VERSION,
      type: "task_intake.state_change",
      taskId,
      leaseId: record.leaseId,
      previousState,
      newState,
      timestamp,
      digest,
    })
  }
}
