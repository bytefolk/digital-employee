import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import {
  TURN_EVIDENCE_VERSION,
  validateTurnEvidenceRecord,
  type TurnEvidenceConformanceViolation,
  type TurnEvidenceRecord,
} from "../../packages/engine/src/index.js"

function digest(seed: string): string {
  return createHash("sha256").update(seed, "utf8").digest("hex")
}

function record(overrides: Partial<TurnEvidenceRecord> = {}): TurnEvidenceRecord {
  return {
    schemaVersion: TURN_EVIDENCE_VERSION,
    evidenceId: "evidence-1",
    workspaceRef: "/tmp/workspace",
    positionId: "repo-owner",
    turnId: "turn-1",
    runId: "run-1",
    engineVersion: "0.1.0",
    inputDigest: digest("input"),
    outputDigest: digest("output"),
    budget: {
      turn: { iterationsUsed: 1, tokensUsed: 2, maxIterations: 4 },
    },
    terminal: { status: "completed", reason: "goal_met" },
    assemblyManifestDigest: digest("assembly"),
    timeBounds: {
      startedAt: "2026-09-05T00:00:00.000Z",
      completedAt: "2026-09-05T00:00:01.000Z",
    },
    ...overrides,
  }
}

function codes(violations: readonly TurnEvidenceConformanceViolation[]): string[] {
  return violations.map((violation) => violation.code)
}

function fields(violations: readonly TurnEvidenceConformanceViolation[]): string[] {
  return violations.map((violation) => violation.field)
}

test("a complete conformant record passes with no violations", () => {
  const result = validateTurnEvidenceRecord(record())
  assert.equal(result.ok, true)
  assert.deepEqual(result.violations, [])
})

test("a failed terminal carrying a stable machine code passes", () => {
  const result = validateTurnEvidenceRecord(
    record({
      terminal: {
        status: "failed",
        reason: "turn_budget_exceeded",
        errorCode: "engine.turn_budget_exceeded",
      },
    }),
  )
  assert.equal(result.ok, true)
})

test("a failed terminal without errorCode is rejected", () => {
  const result = validateTurnEvidenceRecord(
    record({ terminal: { status: "failed", reason: "doom_loop" } }),
  )
  assert.equal(result.ok, false)
  assert.ok(codes(result.violations).includes("error_code_required_on_failure"))
  assert.ok(fields(result.violations).includes("terminal.errorCode"))
})

test("an unknown terminal reason is rejected", () => {
  const result = validateTurnEvidenceRecord(
    record({ terminal: { status: "completed", reason: "made_up_reason" } }),
  )
  assert.equal(result.ok, false)
  assert.ok(codes(result.violations).includes("reason_enum"))
})

test("an unknown top-level field fails closed", () => {
  const withExtra = { ...record(), promptText: "leaked prompt" }
  const result = validateTurnEvidenceRecord(withExtra)
  assert.equal(result.ok, false)
  assert.ok(codes(result.violations).includes("unknown_field"))
  assert.ok(fields(result.violations).includes("promptText"))
})

test("a wrong schemaVersion is rejected", () => {
  const result = validateTurnEvidenceRecord(
    record({ schemaVersion: "turn-evidence.v2" as never }),
  )
  assert.equal(result.ok, false)
  assert.ok(codes(result.violations).includes("schema_version_mismatch"))
})

test("non-sha256 digests are rejected by field", () => {
  const result = validateTurnEvidenceRecord(
    record({ inputDigest: "not-a-digest", outputDigest: digest("ok") }),
  )
  assert.equal(result.ok, false)
  assert.deepEqual(fields(result.violations), ["inputDigest"])
  assert.ok(codes(result.violations).includes("sha256_hex_required"))
})

test("negative budget counters and a used-over-cap are each named", () => {
  const result = validateTurnEvidenceRecord(
    record({
      budget: {
        turn: { iterationsUsed: 9, tokensUsed: -1, maxIterations: 4 },
      },
    }),
  )
  assert.equal(result.ok, false)
  // tokensUsed negative + iterationsUsed over cap both reported (no short-circuit)
  assert.ok(fields(result.violations).includes("budget.turn.tokensUsed"))
  assert.ok(fields(result.violations).includes("budget.turn.iterationsUsed"))
  assert.ok(codes(result.violations).includes("non_negative_int_required"))
  assert.ok(codes(result.violations).includes("counter_exceeds_cap"))
})

test("an optional maxTokens is validated only when present", () => {
  assert.equal(validateTurnEvidenceRecord(record()).ok, true)
  const bad = validateTurnEvidenceRecord(
    record({ budget: { turn: { iterationsUsed: 1, tokensUsed: 1, maxIterations: 4, maxTokens: -5 } } }),
  )
  assert.equal(bad.ok, false)
  assert.ok(fields(bad.violations).includes("budget.turn.maxTokens"))
})

test("a position budget block is validated when present", () => {
  const good = validateTurnEvidenceRecord(
    record({
      budget: {
        turn: { iterationsUsed: 1, tokensUsed: 1, maxIterations: 4 },
        position: {
          taskUsedTokens: 10,
          taskUsedIterations: 1,
          dayUsedTokens: 20,
          dayUsedIterations: 2,
        },
      },
    }),
  )
  assert.equal(good.ok, true)

  const bad = validateTurnEvidenceRecord(
    record({
      budget: {
        turn: { iterationsUsed: 1, tokensUsed: 1, maxIterations: 4 },
        position: { taskUsedTokens: -1 } as never,
      },
    }),
  )
  assert.equal(bad.ok, false)
  assert.ok(fields(bad.violations).includes("budget.position.taskUsedTokens"))
})

test("timeBounds ordering is enforced and ISO-8601 required", () => {
  const reversed = validateTurnEvidenceRecord(
    record({
      timeBounds: {
        startedAt: "2026-09-05T00:00:05.000Z",
        completedAt: "2026-09-05T00:00:01.000Z",
      },
    }),
  )
  assert.equal(reversed.ok, false)
  assert.ok(codes(reversed.violations).includes("negative_duration"))

  const malformed = validateTurnEvidenceRecord(
    record({
      timeBounds: { startedAt: "yesterday", completedAt: "2026-09-05T00:00:01.000Z" },
    }),
  )
  assert.equal(malformed.ok, false)
  assert.ok(fields(malformed.violations).includes("timeBounds.startedAt"))
})

test("an approvalRef is validated against the outcome enum", () => {
  const good = validateTurnEvidenceRecord(
    record({
      terminal: { status: "failed", reason: "cancelled", errorCode: "engine.approval_denied" },
      approvalRef: { approvalId: "ap-1", outcome: "denied" },
    }),
  )
  assert.equal(good.ok, true)

  const bad = validateTurnEvidenceRecord(
    record({ approvalRef: { approvalId: "ap-1", outcome: "maybe" } as never }),
  )
  assert.equal(bad.ok, false)
  assert.ok(codes(bad.violations).includes("outcome_enum"))
})

test("approvalRefs accepts a conformant atomic batch and names invalid members", () => {
  const good = validateTurnEvidenceRecord(
    record({
      terminal: { status: "failed", reason: "cancelled", errorCode: "engine.approval_denied" },
      approvalRefs: [
        { approvalId: "ap-1", outcome: "denied" },
        { approvalId: "ap-2", previewId: "preview-2", outcome: "denied" },
      ],
    }),
  )
  assert.equal(good.ok, true)

  const bad = validateTurnEvidenceRecord(
    record({
      approvalRefs: [{ approvalId: "", previewId: 1, outcome: "maybe" }] as never,
    }),
  )
  assert.equal(bad.ok, false)
  assert.ok(fields(bad.violations).includes("approvalRefs"))
  assert.ok(fields(bad.violations).includes("approvalRefs[0].approvalId"))
  assert.ok(fields(bad.violations).includes("approvalRefs[0].previewId"))
  assert.ok(fields(bad.violations).includes("approvalRefs[0].outcome"))
})

test("permission denials are validated against the stable workspace_org_* codes", () => {
  const good = validateTurnEvidenceRecord(
    record({
      terminal: { status: "failed", reason: "permission_denied", errorCode: "workspace_org_context_denied" },
      permissions: {
        summary: { allowCount: 0, denyCount: 1, codesSeen: ["workspace_org_context_denied"], redirectToTargets: ["repo-owner"] },
        denials: [
          {
            positionId: "issue-researcher",
            requested: "context/secret",
            code: "workspace_org_context_denied",
            redirectTo: "repo-owner",
          },
        ],
      },
    }),
  )
  assert.equal(good.ok, true)

  const bad = validateTurnEvidenceRecord(
    record({
      permissions: {
        summary: { allowCount: 0, denyCount: 1, codesSeen: [], redirectToTargets: [] },
        denials: [{ positionId: "x", requested: "y", code: "not_a_code", redirectTo: "repo-owner" } as never],
      },
    }),
  )
  assert.equal(bad.ok, false)
  assert.ok(codes(bad.violations).includes("denial_code_enum"))
})

test("a non-object input is rejected with a single violation", () => {
  const result = validateTurnEvidenceRecord(null)
  assert.equal(result.ok, false)
  assert.equal(result.violations.length, 1)
  assert.equal(result.violations[0]!.code, "not_an_object")
})

test("violations are collected, not short-circuited", () => {
  const result = validateTurnEvidenceRecord({
    schemaVersion: "wrong",
    inputDigest: "nope",
    budget: {},
    terminal: {},
    timeBounds: {},
  })
  assert.equal(result.ok, false)
  // schemaVersion + inputDigest + budget.turn + terminal.status + terminal.reason
  // + timeBounds.startedAt + timeBounds.completedAt + several missing required strings
  assert.ok(result.violations.length >= 6, `expected many violations, got ${result.violations.length}`)
})
