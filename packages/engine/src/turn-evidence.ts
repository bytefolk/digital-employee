import { createHash } from "node:crypto"

import type { SafeValue } from "../../core/src/contracts.js"

import type { BudgetUsage } from "./budget.js"
import { ENGINE_ERROR_CODE_PATTERN } from "./contracts.js"
import type { TerminalReason } from "./contracts.js"
import type { EscalationCause } from "./escalation.js"
import type {
  PermissionDecisionSummary,
  PermissionDenialAttempt,
} from "./org-permissions.js"

export const TURN_EVIDENCE_VERSION = "turn-evidence.v1" as const

/**
 * Per-turn evidence record under the repository evidence standard.
 *
 * Hard content rule: the record carries digests, counters, and bounded
 * identifiers only — never prompt text, model completions, chain-of-thought,
 * or credentials. A turn without evidence is a failed turn; the executor
 * writes this record in the same atomic sequence as the terminal event.
 */

export interface TurnEvidenceBudget {
  turn: {
    iterationsUsed: number
    tokensUsed: number
    maxIterations: number
    maxTokens?: number
  }
  position?: BudgetUsage
}

export interface TurnEvidenceTerminal {
  status: "completed" | "failed"
  reason: string
  errorCode?: string
}

/**
 * Approval chain link for turns settled through the #187 approval gate.
 * Bounded identifiers only — verdict text and action descriptions stay out
 * of evidence. A denied settlement must carry this reference together with
 * the terminal reason (#187 AC-003).
 */
export interface TurnEvidenceApprovalRef {
  approvalId: string
  previewId?: string
  outcome: "requested" | "granted" | "denied" | "expired"
}

/**
 * Per-turn permission decision evidence (#159 REQ-005). Carries the decision
 * summary plus every denial attempt. Denial attempts carry the position, the
 * requested path or tool name, the stable code, and the redirect target — and
 * NEVER any content from the denied resource. This family is disjoint from
 * the approval settlement fields; both are present where applicable.
 */
export interface TurnEvidencePermissions {
  summary: PermissionDecisionSummary
  denials: PermissionDenialAttempt[]
}

/**
 * Digest-only evidence for one recalled memory item (#180 memory-recall
 * seam, consumed through #209). Raw recall text never enters evidence:
 * items are untrusted data with authority "none"; only digests, locators,
 * and bounded counters are recorded. Provenance enters as a digest over the
 * canonical provenance block — never as raw provenance fields (#209
 * REQ-001).
 */
export interface TurnEvidenceMemoryItem {
  digest: string
  locator: string
  kind: string
  stateVersion: number
  byteLength: number
  /** sha256 over the canonical provenance block of the recalled item. */
  provenanceDigest: string
}

export interface TurnEvidenceMemoryWarning {
  code: string
}

/**
 * Digest-only memory-consumption evidence (#209 REQ-001): effective mode,
 * retrievedAt, adapter identity, and per-item locators/state versions/
 * content digests/provenance digests. Never raw recall content, never
 * credentials.
 */
export interface TurnEvidenceMemory {
  mode: "optional" | "required"
  /** Bounded machine identity of the pinned adapter, e.g. "mem-http.v1". */
  adapterIdentity: string
  /** Exact configured scope binding; no recalled content is included. */
  memoryScope: string
  retrievedAt: string
  itemCount: number
  totalBytes: number
  items: TurnEvidenceMemoryItem[]
  warnings: TurnEvidenceMemoryWarning[]
  /** Present only when an in-process recall cache is configured (#303). */
  cacheHit?: boolean
  cacheAgeMs?: number
}

/**
 * Digest-only evidence for one recalled workbench context item (#179).
 * Raw context text never enters evidence: items are untrusted data with
 * trust "untrusted-context-data"; only artifact digests, locators, and
 * bounded counters are recorded.
 */
export interface TurnEvidenceContextItem {
  artifactDigest: string
  locator: string
  kind: string
  sourceRevision: number
  derivedRevision: number
  byteLength: number
}

export interface TurnEvidenceContextWarning {
  code: string
}

/**
 * Digest-only context-consumption evidence (#179 REQ-005): effective mode,
 * adapter identity, bundle digest, completed watermark, and per-item
 * artifact digests/locators. Never raw context content, never credentials.
 */
export interface TurnEvidenceContext {
  mode: "optional" | "required"
  /** Bounded machine identity of the pinned adapter, e.g. "context-cli.v1". */
  adapterIdentity: string
  retrievedAt: string
  /** sha256 bundle digest covering scope/watermark/items/warnings. */
  bundleDigest: string
  /** Completed watermark occurrence revision at recall time. */
  watermarkRevision: number
  itemCount: number
  totalBytes: number
  items: TurnEvidenceContextItem[]
  warnings: TurnEvidenceContextWarning[]
  /**
   * Count of items evicted by the TTL + digest freshness pass BEFORE the
   * items reached the assembler. Optional and back-compat: absent when
   * the caller configures no freshness knobs, present (and possibly 0)
   * once they opt in via defaultTtlMs or expectedDigests. A dedicated
   * "context.evicted" EngineEvent is deferred — see TODO in
   * turn-executor.
   */
  evictedCount?: number
}

export interface TurnEvidenceRecord {
  schemaVersion: typeof TURN_EVIDENCE_VERSION
  evidenceId: string
  workspaceRef: string
  positionId: string
  turnId: string
  runId: string
  engineVersion: string
  /** sha256 over the canonical assembled-context serialization. */
  inputDigest: string
  /** sha256 over the terminal output JSON. */
  outputDigest: string
  budget: TurnEvidenceBudget
  terminal: TurnEvidenceTerminal
  escalationRef?: string
  approvalRef?: TurnEvidenceApprovalRef
  /** Exact batch settled by this recovery turn. Present only for an atomic
   * multi-approval recovery; keeping the legacy singular field preserves
   * existing evidence readers. */
  approvalRefs?: TurnEvidenceApprovalRef[]
  /** Permission decision summary + zero-content denial attempts (#159). */
  permissions?: TurnEvidencePermissions
  /** Digest-only memory-recall consumption evidence (#180 seam). */
  memory?: TurnEvidenceMemory
  /** Digest-only workbench-context consumption evidence (#179 seam). */
  context?: TurnEvidenceContext
  /** Assembly manifest digest from context-assembly.v1. */
  assemblyManifestDigest: string
  timeBounds: {
    startedAt: string
    completedAt: string
  }
}

export interface EvidenceSinkPort {
  write(record: TurnEvidenceRecord): Promise<void>
}

export interface InMemoryEvidenceSink extends EvidenceSinkPort {
  records: readonly TurnEvidenceRecord[]
}

export function createInMemoryEvidenceSink(): InMemoryEvidenceSink {
  const stored: TurnEvidenceRecord[] = []
  return {
    records: stored,
    async write(record) {
      stored.push(record)
    },
  }
}

export function digestOutputValue(output: SafeValue): string {
  const json = JSON.stringify(output)
  return createHash("sha256").update(json ?? "null", "utf8").digest("hex")
}

/**
 * Sentinel assembly digest for turns denied before any context assembly happens
 * (permission pre-check denials, #159 REQ-004(a)).
 */
export const NO_ASSEMBLY_DIGEST = createHash("sha256")
  .update("[]", "utf8")
  .digest("hex")

/**
 * Digest-shaped sentinel recorded as `bundleDigest` when an optional-mode
 * context outage degrades to an empty context (#179 REQ-005): no bundle was
 * observed, so no real bundle digest exists.
 */
export const NO_CONTEXT_BUNDLE_DIGEST = createHash("sha256")
  .update("context-bundle.v1:empty", "utf8")
  .digest("hex")

/**
 * Static content audit for a record: proves the forbidden material classes
 * are absent from the serialized evidence itself.
 */
export function evidenceRecordContainsForbiddenMaterial(
  record: TurnEvidenceRecord,
  probes: readonly string[],
): boolean {
  const serialized = JSON.stringify(record)
  return probes.some(
    (probe) => probe.length > 0 && serialized.includes(probe),
  )
}

/**
 * Structural conformance check for one `turn-evidence.v1` record against the
 * #140 evidence standard (exact engine version, input digest, output digest,
 * budget state). Pure and deterministic: it reads a parsed value, never the
 * filesystem or network, and never invokes a model.
 *
 * It collects every violation instead of short-circuiting, so an acceptance
 * harness or CI gate can name the exact failing field per record (#285
 * REQ-001). A record that carries an unknown top-level key fails closed: the
 * evidence record is a sealed digest-only artefact, and an unrecognised field
 * signals producer drift, not forward compatibility.
 */
export interface TurnEvidenceConformanceViolation {
  /** Dotted path to the offending field, e.g. `terminal.reason` or `budget.turn.maxIterations`. */
  field: string
  /** Stable machine-readable violation code. */
  code: string
  message: string
}

export type TurnEvidenceConformanceResult =
  | { ok: true; violations: [] }
  | { ok: false; violations: TurnEvidenceConformanceViolation[] }

const HEX_64 = /^[0-9a-f]{64}$/
const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

const TERMINAL_REASONS: ReadonlySet<string> = new Set<TerminalReason>([
  "goal_met",
  "invalid_output_exhausted",
  "turn_budget_exceeded",
  "position_budget_exceeded",
  "iteration_cap",
  "doom_loop",
  "deadline_exceeded",
  "cancelled",
  "permission_denied",
  "memory_unavailable",
  "memory_denied",
  "context_unavailable",
  "context_denied",
  "engine_internal_error",
])

const APPROVAL_OUTCOMES: ReadonlySet<string> = new Set([
  "requested",
  "granted",
  "denied",
  "expired",
])

/** Every top-level key a conformant `turn-evidence.v1` record may carry. */
const ALLOWED_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "evidenceId",
  "workspaceRef",
  "positionId",
  "turnId",
  "runId",
  "engineVersion",
  "inputDigest",
  "outputDigest",
  "budget",
  "terminal",
  "escalationRef",
  "approvalRef",
  "approvalRefs",
  "permissions",
  "memory",
  "context",
  "assemblyManifestDigest",
  "timeBounds",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A non-negative integer counter (iterations, tokens, byte counts). */
function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

export function validateTurnEvidenceRecord(
  value: unknown,
): TurnEvidenceConformanceResult {
  const violations: TurnEvidenceConformanceViolation[] = []
  const add = (field: string, code: string, message: string): void => {
    violations.push({ field, code, message })
  }

  if (!isRecord(value)) {
    add("", "not_an_object", "evidence record must be a JSON object")
    return { ok: false, violations }
  }

  // Unknown top-level keys fail closed (sealed digest-only artefact).
  for (const key of Object.keys(value)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      add(key, "unknown_field", `unrecognised top-level field: ${key}`)
    }
  }

  if (value.schemaVersion !== TURN_EVIDENCE_VERSION) {
    add(
      "schemaVersion",
      "schema_version_mismatch",
      `expected "${TURN_EVIDENCE_VERSION}", got ${JSON.stringify(value.schemaVersion)}`,
    )
  }

  for (const field of [
    "evidenceId",
    "workspaceRef",
    "positionId",
    "turnId",
    "engineVersion",
  ] as const) {
    const v = value[field]
    if (typeof v !== "string" || v.length === 0) {
      add(field, "non_empty_string_required", `${field} must be a non-empty string`)
    }
  }

  // runId is typed as string and may legitimately be empty on a pre-lifecycle
  // denial, so only its type is constrained here.
  if (typeof value.runId !== "string") {
    add("runId", "string_required", "runId must be a string")
  }

  for (const field of ["inputDigest", "outputDigest", "assemblyManifestDigest"] as const) {
    const v = value[field]
    if (typeof v !== "string" || !HEX_64.test(v)) {
      add(field, "sha256_hex_required", `${field} must be a lowercase sha256 hex digest`)
    }
  }

  // --- budget: the #140 budget-state element ---
  const budget = value.budget
  if (!isRecord(budget)) {
    add("budget", "object_required", "budget must be an object")
  } else {
    for (const key of Object.keys(budget)) {
      if (key !== "turn" && key !== "position") {
        add(`budget.${key}`, "unknown_field", `unrecognised budget field: ${key}`)
      }
    }
    const turn = budget.turn
    if (!isRecord(turn)) {
      add("budget.turn", "object_required", "budget.turn must be an object")
    } else {
      for (const key of Object.keys(turn)) {
        if (!["iterationsUsed", "tokensUsed", "maxIterations", "maxTokens"].includes(key)) {
          add(`budget.turn.${key}`, "unknown_field", `unrecognised budget.turn field: ${key}`)
        }
      }
      for (const key of ["iterationsUsed", "tokensUsed", "maxIterations"] as const) {
        if (!isNonNegativeInt(turn[key])) {
          add(`budget.turn.${key}`, "non_negative_int_required", `budget.turn.${key} must be a non-negative integer`)
        }
      }
      if (turn.maxTokens !== undefined && !isNonNegativeInt(turn.maxTokens)) {
        add("budget.turn.maxTokens", "non_negative_int_required", "budget.turn.maxTokens must be a non-negative integer when present")
      }
      const used = turn.iterationsUsed
      const max = turn.maxIterations
      if (isNonNegativeInt(used) && isNonNegativeInt(max) && used > max) {
        add("budget.turn.iterationsUsed", "counter_exceeds_cap", `iterationsUsed (${used}) exceeds maxIterations (${max})`)
      }
    }
    if (budget.position !== undefined) {
      const pos = budget.position
      if (!isRecord(pos)) {
        add("budget.position", "object_required", "budget.position must be an object when present")
      } else {
        for (const key of ["taskUsedTokens", "taskUsedIterations", "dayUsedTokens", "dayUsedIterations"] as const) {
          if (!isNonNegativeInt(pos[key])) {
            add(`budget.position.${key}`, "non_negative_int_required", `budget.position.${key} must be a non-negative integer`)
          }
        }
      }
    }
  }

  // --- terminal: the #140 termination-reason element ---
  const terminal = value.terminal
  if (!isRecord(terminal)) {
    add("terminal", "object_required", "terminal must be an object")
  } else {
    for (const key of Object.keys(terminal)) {
      if (!["status", "reason", "errorCode"].includes(key)) {
        add(`terminal.${key}`, "unknown_field", `unrecognised terminal field: ${key}`)
      }
    }
    if (terminal.status !== "completed" && terminal.status !== "failed") {
      add("terminal.status", "status_enum", `terminal.status must be "completed" or "failed", got ${JSON.stringify(terminal.status)}`)
    }
    if (typeof terminal.reason !== "string" || !TERMINAL_REASONS.has(terminal.reason)) {
      add("terminal.reason", "reason_enum", `terminal.reason must be a known TerminalReason, got ${JSON.stringify(terminal.reason)}`)
    }
    if (terminal.errorCode !== undefined) {
      if (typeof terminal.errorCode !== "string" || !ENGINE_ERROR_CODE_PATTERN.test(terminal.errorCode)) {
        add("terminal.errorCode", "error_code_pattern", "terminal.errorCode must match the lowercase machine-code pattern when present")
      }
    } else if (terminal.status === "failed") {
      // Every executor-emitted failed record names a stable machine code; a
      // failed terminal without one cannot be attributed downstream.
      add("terminal.errorCode", "error_code_required_on_failure", "a failed terminal must carry errorCode")
    }
  }

  // --- timeBounds ---
  const timeBounds = value.timeBounds
  if (!isRecord(timeBounds)) {
    add("timeBounds", "object_required", "timeBounds must be an object")
  } else {
    for (const key of Object.keys(timeBounds)) {
      if (key !== "startedAt" && key !== "completedAt") {
        add(`timeBounds.${key}`, "unknown_field", `unrecognised timeBounds field: ${key}`)
      }
    }
    let startedMs: number | undefined
    let completedMs: number | undefined
    for (const key of ["startedAt", "completedAt"] as const) {
      const v = timeBounds[key]
      if (typeof v !== "string" || !ISO_8601.test(v)) {
        add(`timeBounds.${key}`, "iso_8601_required", `timeBounds.${key} must be an ISO-8601 timestamp`)
        continue
      }
      const ms = Date.parse(v)
      if (Number.isNaN(ms)) {
        add(`timeBounds.${key}`, "iso_8601_required", `timeBounds.${key} is not a parseable timestamp`)
      } else if (key === "startedAt") {
        startedMs = ms
      } else {
        completedMs = ms
      }
    }
    if (startedMs !== undefined && completedMs !== undefined && completedMs < startedMs) {
      add("timeBounds.completedAt", "negative_duration", "timeBounds.completedAt precedes startedAt")
    }
  }

  // --- optional blocks: structural checks when present ---
  if (value.escalationRef !== undefined && typeof value.escalationRef !== "string") {
    add("escalationRef", "string_required", "escalationRef must be a string when present")
  }

  if (value.approvalRef !== undefined) {
    const approval = value.approvalRef
    if (!isRecord(approval)) {
      add("approvalRef", "object_required", "approvalRef must be an object when present")
    } else {
      if (typeof approval.approvalId !== "string" || approval.approvalId.length === 0) {
        add("approvalRef.approvalId", "non_empty_string_required", "approvalRef.approvalId must be a non-empty string")
      }
      if (approval.previewId !== undefined && typeof approval.previewId !== "string") {
        add("approvalRef.previewId", "string_required", "approvalRef.previewId must be a string when present")
      }
      if (typeof approval.outcome !== "string" || !APPROVAL_OUTCOMES.has(approval.outcome)) {
        add("approvalRef.outcome", "outcome_enum", `approvalRef.outcome must be one of requested|granted|denied|expired, got ${JSON.stringify(approval.outcome)}`)
      }
    }
  }

  if (value.approvalRefs !== undefined) {
    const approvals = value.approvalRefs
    if (!Array.isArray(approvals)) {
      add("approvalRefs", "array_required", "approvalRefs must be an array when present")
    } else {
      if (approvals.length < 2 || approvals.length > 32) {
        add("approvalRefs", "array_length", "approvalRefs must contain between 2 and 32 members")
      }
      approvals.forEach((approval, index) => {
        const field = `approvalRefs[${index}]`
        if (!isRecord(approval)) {
          add(field, "object_required", "each approvalRefs member must be an object")
          return
        }
        if (typeof approval.approvalId !== "string" || approval.approvalId.length === 0) {
          add(`${field}.approvalId`, "non_empty_string_required", `${field}.approvalId must be a non-empty string`)
        }
        if (approval.previewId !== undefined && typeof approval.previewId !== "string") {
          add(`${field}.previewId`, "string_required", `${field}.previewId must be a string when present`)
        }
        if (typeof approval.outcome !== "string" || !APPROVAL_OUTCOMES.has(approval.outcome)) {
          add(`${field}.outcome`, "outcome_enum", `${field}.outcome must be one of requested|granted|denied|expired, got ${JSON.stringify(approval.outcome)}`)
        }
      })
    }
  }

  if (value.permissions !== undefined) {
    const permissions = value.permissions
    if (!isRecord(permissions)) {
      add("permissions", "object_required", "permissions must be an object when present")
    } else {
      const summary = permissions.summary
      if (!isRecord(summary)) {
        add("permissions.summary", "object_required", "permissions.summary must be an object")
      } else {
        if (!isNonNegativeInt(summary.allowCount)) {
          add("permissions.summary.allowCount", "non_negative_int_required", "permissions.summary.allowCount must be a non-negative integer")
        }
        if (!isNonNegativeInt(summary.denyCount)) {
          add("permissions.summary.denyCount", "non_negative_int_required", "permissions.summary.denyCount must be a non-negative integer")
        }
        if (!Array.isArray(summary.codesSeen) || summary.codesSeen.some((code) => typeof code !== "string")) {
          add("permissions.summary.codesSeen", "string_array_required", "permissions.summary.codesSeen must be an array of strings")
        }
        if (!Array.isArray(summary.redirectToTargets) || summary.redirectToTargets.some((target) => typeof target !== "string")) {
          add("permissions.summary.redirectToTargets", "string_array_required", "permissions.summary.redirectToTargets must be an array of strings")
        }
      }
      if (!Array.isArray(permissions.denials)) {
        add("permissions.denials", "array_required", "permissions.denials must be an array")
      } else {
        permissions.denials.forEach((denial, index) => {
          if (!isRecord(denial)) {
            add(`permissions.denials[${index}]`, "object_required", "each denial must be an object")
            return
          }
          for (const key of ["positionId", "requested", "redirectTo"] as const) {
            if (typeof denial[key] !== "string") {
              add(`permissions.denials[${index}].${key}`, "string_required", `denial ${key} must be a string`)
            }
          }
          const code = denial.code
          if (
            code !== "workspace_org_authority_denied" &&
            code !== "workspace_org_context_denied" &&
            code !== "workspace_org_position_unknown"
          ) {
            add(`permissions.denials[${index}].code`, "denial_code_enum", `denial code must be a stable workspace_org_* code, got ${JSON.stringify(code)}`)
          }
        })
      }
    }
  }

  if (violations.length > 0) {
    return { ok: false, violations }
  }
  return { ok: true, violations: [] }
}

export type { EscalationCause }
