import assert from "node:assert/strict"
import test from "node:test"

import {
  HIRE_REQUEST_SCHEMA_VERSION,
  HireRequestError,
  buildHireRequestSchema,
  validateHireRequest,
} from "../../packages/core/index.js"
import { buildTurnEnvelopeSchema } from "../../apps/cli/turn/envelope-schema.js"

function hireRequest(): Record<string, any> {
  return {
    schemaVersion: HIRE_REQUEST_SCHEMA_VERSION,
    workspaceRef: "ws-main",
    packageRef: {
      name: "team-answer",
      version: "v1alpha1",
      digest: "sha256:0123456789abcdef",
    },
    targetParentId: "pos-parent-1",
    budget: {
      perTask: { tokens: 50_000, iterations: 8 },
      perDay: { tokens: 500_000 },
    },
    requestedBy: "cto",
    deadline: "2026-01-01T00:00:00Z",
    envelopeDigest: "sha256:abcdef0123456789",
  }
}

function assertHireFailure(input: unknown, code: string): void {
  try {
    validateHireRequest(input)
  } catch (error) {
    assert.ok(error instanceof HireRequestError)
    assert.equal(error.code, code)
    return
  }
  assert.fail(`expected hire request validation to fail with ${code}`)
}

test("hire request: valid envelope passes and is normalized (#194)", () => {
  const result = validateHireRequest(hireRequest())
  assert.deepEqual(result, {
    schemaVersion: "hire-request.v1alpha1",
    workspaceRef: "ws-main",
    packageRef: {
      name: "team-answer",
      version: "v1alpha1",
      digest: "sha256:0123456789abcdef",
    },
    targetParentId: "pos-parent-1",
    budget: {
      perTask: { tokens: 50_000, iterations: 8 },
      perDay: { tokens: 500_000 },
    },
    requestedBy: "cto",
    deadline: "2026-01-01T00:00:00Z",
    envelopeDigest: "sha256:abcdef0123456789",
  })

  const minimal = hireRequest()
  delete minimal.deadline
  const minimalResult = validateHireRequest(minimal)
  assert.equal(minimalResult.deadline, undefined)
})

test("hire request: targetParentId is required and opaque (AC-003, #194)", () => {
  // Any bounded text passes: no tree lookup, no org-workbench import.
  for (const targetParentId of [
    "pos-parent-1",
    "urn:org:node:42",
    "some/path/like/reference",
    "00000000-0000-0000-0000-000000000000",
  ]) {
    const input = hireRequest()
    input.targetParentId = targetParentId
    assert.equal(validateHireRequest(input).targetParentId, targetParentId)
  }

  const missing = hireRequest()
  delete missing.targetParentId
  assertHireFailure(missing, "hire_request_invalid_field:targetParentId")

  const empty = hireRequest()
  empty.targetParentId = "   "
  assertHireFailure(empty, "hire_request_invalid_field:targetParentId")

  const oversized = hireRequest()
  oversized.targetParentId = "x".repeat(257)
  assertHireFailure(oversized, "hire_request_invalid_field:targetParentId")
})

test("hire request: budget is required and attached at hire time (#194)", () => {
  const missing = hireRequest()
  delete missing.budget
  assertHireFailure(missing, "hire_request_missing_budget")

  const missingPerDay = hireRequest()
  delete missingPerDay.budget.perDay
  assertHireFailure(missingPerDay, "hire_request_invalid_field:budget.perDay")

  const extraBudgetKey = hireRequest()
  extraBudgetKey.budget.perWeek = { tokens: 1 }
  assertHireFailure(extraBudgetKey, "hire_request_unknown_field:budget.perWeek")
})

test("hire request: empty budget scope fails closed (#194)", () => {
  const empty = hireRequest()
  empty.budget.perTask = {}
  assertHireFailure(empty, "hire_request_invalid_field:budget.perTask")
})

test("hire request: budget scope bounds match the engine vocabulary (#194)", () => {
  const cases: Array<[string, unknown]> = [
    ["tokens", 0],
    ["tokens", -1],
    ["tokens", 1.5],
    ["tokens", "5"],
    ["tokens", 1_000_000_001],
    ["iterations", 0],
    ["iterations", 1_000_000_001],
  ]
  for (const [key, value] of cases) {
    const input = hireRequest()
    input.budget.perTask = { [key]: value }
    assertHireFailure(
      input,
      `hire_request_invalid_field:budget.perTask.${key}`,
    )
  }

  const atCap = hireRequest()
  atCap.budget.perTask = { tokens: 1_000_000_000 }
  atCap.budget.perDay = { iterations: 1_000_000_000 }
  assert.doesNotThrow(() => validateHireRequest(atCap))
})

test("hire request: unknown fields are rejected at every level (#194)", () => {
  const root = hireRequest()
  root.approval = { granted: true }
  assertHireFailure(root, "hire_request_unknown_field:approval")

  const nested = hireRequest()
  nested.packageRef.localReference = "./packages/team-answer"
  assertHireFailure(
    nested,
    "hire_request_unknown_field:packageRef.localReference",
  )
})

test("hire request: packageRef constraints fail closed (#194)", () => {
  for (const version of ["v1alpha2", "v1alpha1.x", "1alpha1", ""]) {
    const input = hireRequest()
    input.packageRef.version = version
    assertHireFailure(input, "hire_request_invalid_field:packageRef.version")
  }

  const versioned = hireRequest()
  versioned.packageRef.version = "v1alpha1.3"
  assert.equal(validateHireRequest(versioned).packageRef.version, "v1alpha1.3")

  const shortDigest = hireRequest()
  shortDigest.packageRef.digest = "short"
  assertHireFailure(shortDigest, "hire_request_invalid_field:packageRef.digest")

  const emptyName = hireRequest()
  emptyName.packageRef.name = ""
  assertHireFailure(emptyName, "hire_request_invalid_field:packageRef.name")
})

test("hire request: required bounded identifiers fail closed (#194)", () => {
  for (const field of ["workspaceRef", "requestedBy", "envelopeDigest"]) {
    const input = hireRequest()
    delete input[field]
    assertHireFailure(input, `hire_request_invalid_field:${field}`)
  }

  const shortEnvelopeDigest = hireRequest()
  shortEnvelopeDigest.envelopeDigest = "sha256:abc"
  assertHireFailure(
    shortEnvelopeDigest,
    "hire_request_invalid_field:envelopeDigest",
  )
})

test("hire request: deadline mirrors turn-envelope handling (#194)", () => {
  const invalid = hireRequest()
  invalid.deadline = "not-a-date"
  assertHireFailure(invalid, "hire_request_invalid_field:deadline")

  const numeric = hireRequest()
  numeric.deadline = 1_700_000_000
  assertHireFailure(numeric, "hire_request_invalid_field:deadline")
})

test("hire request: schema version and document shape fail closed (#194)", () => {
  const wrongVersion = hireRequest()
  wrongVersion.schemaVersion = "hire-request.v2"
  assertHireFailure(wrongVersion, "hire_request_invalid_field:schemaVersion")

  assertHireFailure([], "hire_request_invalid_field:hireRequest")
  assertHireFailure("hire", "hire_request_invalid_field:hireRequest")
})

test("hire request: budgetScope vocabulary is byte-aligned with turn-envelope.v1 (AC-005, #194)", () => {
  const hireDefs = buildHireRequestSchema().$defs as Record<string, unknown>
  const turnDefs = buildTurnEnvelopeSchema().$defs as Record<string, unknown>
  assert.deepEqual(hireDefs.budgetScope, turnDefs.budgetScope)
})
