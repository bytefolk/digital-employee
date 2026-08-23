import type { SafeValue } from "../../core/src/contracts.js"

/**
 * Built-in execution engine protocol identity.
 *
 * The engine is the workspace's default execution body. It speaks its own
 * contract vocabulary (independently defined); the event *shape* is kept
 * compatible with agent-host.v1 so the workbench stays engine-agnostic.
 */
export const ENGINE_PROTOCOL_VERSION = "engine.v1" as const
export const ENGINE_ID = "built-in" as const

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
  return request
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
