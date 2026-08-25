/**
 * Sealed turn envelope (turn-envelope.v1) — the wire contract for the
 * `turn run` spawn surface (#173 REQ-002, OQ-1 adjudication).
 *
 * The envelope is digest-bound: `envelopeDigest` is the sha256 over the
 * canonical JSON of the envelope body (every field except the digest
 * itself), and the CLI re-verifies it before any consumption. A mismatched
 * or malformed envelope fails closed before any model consumption, per the
 * #90 package-binding discipline.
 */

import { createHash } from "node:crypto"

import type { SafeValue } from "../../../packages/core/src/contracts.js"
import {
  validatePositionBudgetDeclaration,
  type PositionBudgetDeclaration,
} from "../../../packages/engine/src/budget.js"
import type { TurnBudget } from "../../../packages/engine/src/contracts.js"

export const TURN_ENVELOPE_VERSION = "turn-envelope.v1" as const
export const TURN_ENVELOPE_SCHEMA_ID =
  "https://fullstack-ai-infra.dev/schemas/turn-envelope.schema.json" as const

/**
 * Environment allowlist for the spawn surface. Credentials never appear in
 * argv; model keys flow only through this allowlist (#173 REQ-002).
 */
export const TURN_ENGINE_MODEL_ENV = "DIGITAL_EMPLOYEE_ENGINE_MODEL" as const
export const TURN_ENGINE_MODEL_SCRIPT_ENV =
  "DIGITAL_EMPLOYEE_ENGINE_MODEL_SCRIPT" as const
/**
 * Optional binary override for the claude-local port (#182). A version manager
 * or a non-standard install can keep `claude` off the spawn PATH; this names
 * the entrypoint without putting anything credential-bearing in argv.
 */
export const TURN_ENGINE_CLAUDE_COMMAND_ENV =
  "DIGITAL_EMPLOYEE_CLAUDE_COMMAND" as const
/**
 * Optional binary override for the qoder port (#185), same allowlist
 * discipline as the claude-local override: names the `qodercli` entrypoint
 * without putting anything credential-bearing in argv.
 */
export const TURN_ENGINE_QODER_COMMAND_ENV =
  "DIGITAL_EMPLOYEE_QODER_COMMAND" as const

export interface TurnEnvelope {
  schemaVersion: typeof TURN_ENVELOPE_VERSION
  workspaceRef: string
  positionId: string
  turnId: string
  input: SafeValue
  budget?: TurnBudget
  positionBudget?: PositionBudgetDeclaration
  taskId?: string
  dayKey?: string
  deadline?: string
  envelopeDigest: string
}

export class TurnEnvelopeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "TurnEnvelopeError"
  }
}

const MAX_ID_LENGTH = 256

function canonicalJson(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(canonicalJson)
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = canonicalJson((value as Record<string, unknown>)[key])
  }
  return sorted
}

/**
 * Compute the envelope digest: sha256 over the canonical JSON of the
 * envelope body (all fields except envelopeDigest), `sha256:<hex>` format.
 */
export function computeEnvelopeDigest(body: Record<string, unknown>): string {
  const canonical = JSON.stringify(canonicalJson(body))
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`
}

function assertBoundedId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TurnEnvelopeError(
      "engine.input_invalid",
      `${label} must be a non-empty string`,
    )
  }
  if (value.length > MAX_ID_LENGTH) {
    throw new TurnEnvelopeError(
      "engine.input_invalid",
      `${label} exceeds the bounded identifier length`,
    )
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function envelopeBody(raw: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = { ...raw }
  delete body.envelopeDigest
  return body
}

/**
 * Fail-closed envelope validation. Every structural problem rejects before
 * any engine consumption.
 */
export function parseTurnEnvelope(raw: unknown): TurnEnvelope {
  if (!isRecord(raw)) {
    throw new TurnEnvelopeError(
      "engine.envelope_invalid",
      "envelope must be a JSON object",
    )
  }
  if (raw.schemaVersion !== TURN_ENVELOPE_VERSION) {
    throw new TurnEnvelopeError(
      "engine.envelope_invalid",
      `schemaVersion must be ${TURN_ENVELOPE_VERSION}`,
    )
  }
  const workspaceRef = assertBoundedId(raw.workspaceRef, "workspaceRef")
  const positionId = assertBoundedId(raw.positionId, "positionId")
  const turnId = assertBoundedId(raw.turnId, "turnId")
  if (raw.input === undefined) {
    throw new TurnEnvelopeError(
      "engine.input_invalid",
      "envelope input is required",
    )
  }

  let budget: TurnBudget | undefined
  if (raw.budget !== undefined) {
    if (
      !isRecord(raw.budget) ||
      !Number.isInteger(raw.budget.maxIterations) ||
      (raw.budget.maxIterations as number) < 1
    ) {
      throw new TurnEnvelopeError(
        "engine.input_invalid",
        "budget.maxIterations must be a positive integer",
      )
    }
    const maxTokens = raw.budget.maxTokens
    if (
      maxTokens !== undefined &&
      (!Number.isInteger(maxTokens) || (maxTokens as number) < 1)
    ) {
      throw new TurnEnvelopeError(
        "engine.input_invalid",
        "budget.maxTokens must be a positive integer when present",
      )
    }
    budget = {
      maxIterations: raw.budget.maxIterations as number,
      ...(maxTokens !== undefined ? { maxTokens: maxTokens as number } : {}),
    }
  }

  // Position-budget triple: all-present or all-absent (#173 REQ-002).
  const hasDeclaration = raw.positionBudget !== undefined
  const hasTaskId = raw.taskId !== undefined
  const hasDayKey = raw.dayKey !== undefined
  if (hasDeclaration !== hasTaskId || hasDeclaration !== hasDayKey) {
    throw new TurnEnvelopeError(
      "engine.input_invalid",
      "positionBudget, taskId and dayKey must be all-present or all-absent",
    )
  }
  let positionBudget: PositionBudgetDeclaration | undefined
  let taskId: string | undefined
  let dayKey: string | undefined
  if (hasDeclaration) {
    try {
      positionBudget = validatePositionBudgetDeclaration(
        raw.positionBudget as PositionBudgetDeclaration,
      )
    } catch {
      throw new TurnEnvelopeError(
        "engine.input_invalid",
        "positionBudget must be fully allocated (perTask and perDay caps)",
      )
    }
    taskId = assertBoundedId(raw.taskId, "taskId")
    dayKey = assertBoundedId(raw.dayKey, "dayKey")
  }

  if (raw.deadline !== undefined) {
    if (
      typeof raw.deadline !== "string" ||
      Number.isNaN(Date.parse(raw.deadline))
    ) {
      throw new TurnEnvelopeError(
        "engine.input_invalid",
        "deadline must be a valid ISO 8601 timestamp",
      )
    }
  }

  if (typeof raw.envelopeDigest !== "string" || raw.envelopeDigest.length === 0) {
    throw new TurnEnvelopeError(
      "engine.envelope_invalid",
      "envelopeDigest is required",
    )
  }
  const expected = computeEnvelopeDigest(envelopeBody(raw))
  if (raw.envelopeDigest !== expected) {
    throw new TurnEnvelopeError(
      "engine.envelope_digest_mismatch",
      "envelope digest does not match the canonical envelope body",
    )
  }

  return {
    schemaVersion: TURN_ENVELOPE_VERSION,
    workspaceRef,
    positionId,
    turnId,
    input: raw.input as SafeValue,
    ...(budget !== undefined ? { budget } : {}),
    ...(positionBudget !== undefined
      ? { positionBudget, taskId, dayKey }
      : {}),
    ...(raw.deadline !== undefined ? { deadline: raw.deadline as string } : {}),
    envelopeDigest: raw.envelopeDigest,
  }
}
