import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

import {
  USAGE_EVIDENCE_VERSION,
  UsageEvidenceError,
  validateUsageEvidence,
  normalizeUsageEvidence,
  classifyProofQuality,
  bindEvidenceToReceipt,
} from "../../packages/core/src/runner-usage-evidence.js"
import type { UsageEvidenceRecord } from "../../packages/core/src/runner-usage-evidence.js"

const VECTORS_DIR = join(import.meta.dirname, "../../fixtures/runner-usage-vectors/v1")

function loadVectors(name: string): unknown {
  return JSON.parse(readFileSync(join(VECTORS_DIR, name), "utf-8"))
}

// --- Validation tests ---

test("validateUsageEvidence – valid evidence records", async (t) => {
  const fixture = loadVectors("validation.json") as {
    vectors: { id: string; input: unknown; expected: { valid: boolean } }[]
  }
  const validVectors = fixture.vectors.filter((v) => v.expected.valid)

  for (const vector of validVectors) {
    await t.test(vector.id, () => {
      const result = validateUsageEvidence(vector.input)
      assert.equal(result.version, USAGE_EVIDENCE_VERSION)
      assert.equal(typeof result.evidenceId, "string")
    })
  }
})

test("validateUsageEvidence – reject invalid evidence", async (t) => {
  const fixture = loadVectors("validation.json") as {
    vectors: { id: string; input: unknown; expected: { valid: boolean; errorContains?: string } }[]
  }
  const invalidVectors = fixture.vectors.filter((v) => !v.expected.valid)

  for (const vector of invalidVectors) {
    await t.test(vector.id, () => {
      assert.throws(
        () => validateUsageEvidence(vector.input),
        (err: unknown) => {
          assert.ok(err instanceof UsageEvidenceError)
          if (vector.expected.errorContains) {
            assert.ok(
              err.message.includes(vector.expected.errorContains),
              `Expected error to contain "${vector.expected.errorContains}", got: "${err.message}"`,
            )
          }
          return true
        },
      )
    })
  }
})

test("validateUsageEvidence – unknown provider fields preserved", () => {
  const fixture = loadVectors("validation.json") as {
    vectors: {
      id: string
      input: unknown
      expected: { valid: boolean; preservedProviderFields?: string[] }
    }[]
  }
  const vector = fixture.vectors.find((v) => v.id === "valid-with-unknown-provider-fields")!
  const result = validateUsageEvidence(vector.input)
  assert.equal((result.provider as Record<string, unknown>).datacenter, "dc-west")
  assert.equal((result.provider as Record<string, unknown>).tier, "premium")
})

test("validateUsageEvidence – redactions handling", () => {
  const fixture = loadVectors("validation.json") as {
    vectors: { id: string; input: unknown; expected: { valid: boolean } }[]
  }
  const vector = fixture.vectors.find((v) => v.id === "valid-with-redactions")!
  const result = validateUsageEvidence(vector.input)
  assert.deepEqual(result.redactions, ["provider.region", "tokens.cached"])
})

// --- Normalization tests ---

test("normalizeUsageEvidence – monotonicity valid aggregation", () => {
  const fixture = loadVectors("normalization.json") as {
    vectors: {
      id: string
      events: UsageEvidenceRecord[]
      expected: { tokens: { input: number; output: number }; requests: { count: number }; proofQuality: string }
    }[]
  }
  const vector = fixture.vectors.find((v) => v.id === "monotonicity-valid")!
  const events = vector.events.map((e) => validateUsageEvidence(e))
  const result = normalizeUsageEvidence(events)

  assert.equal(result.tokens.input, vector.expected.tokens.input)
  assert.equal(result.tokens.output, vector.expected.tokens.output)
  assert.equal(result.requests.count, vector.expected.requests.count)
  assert.equal(result.proofQuality, vector.expected.proofQuality)
})

test("normalizeUsageEvidence – monotonicity violation forces unverified", () => {
  const fixture = loadVectors("normalization.json") as {
    vectors: {
      id: string
      events: UsageEvidenceRecord[]
      expected: { tokens: { input: number; output: number }; requests: { count: number }; proofQuality: string }
    }[]
  }
  const vector = fixture.vectors.find((v) => v.id === "monotonicity-violation")!
  const events = vector.events.map((e) => validateUsageEvidence(e))
  const result = normalizeUsageEvidence(events)

  assert.equal(result.tokens.input, vector.expected.tokens.input)
  assert.equal(result.tokens.output, vector.expected.tokens.output)
  assert.equal(result.proofQuality, "unverified")
})

test("normalizeUsageEvidence – widest time bounds and tool call aggregation", () => {
  const fixture = loadVectors("normalization.json") as {
    vectors: {
      id: string
      events: UsageEvidenceRecord[]
      expected: {
        tokens: { input: number; output: number }
        requests: { count: number; toolCalls: number }
        timeBounds: { startedAt: string; completedAt: string }
        proofQuality: string
      }
    }[]
  }
  const vector = fixture.vectors.find((v) => v.id === "aggregation-wide-time-bounds")!
  const events = vector.events.map((e) => validateUsageEvidence(e))
  const result = normalizeUsageEvidence(events)

  assert.equal(result.tokens.input, vector.expected.tokens.input)
  assert.equal(result.tokens.output, vector.expected.tokens.output)
  assert.equal(result.requests.count, vector.expected.requests.count)
  assert.equal(result.requests.toolCalls, vector.expected.requests.toolCalls)
  assert.equal(result.timeBounds.startedAt, vector.expected.timeBounds.startedAt)
  assert.equal(result.timeBounds.completedAt, vector.expected.timeBounds.completedAt)
  assert.equal(result.proofQuality, vector.expected.proofQuality)
})

test("normalizeUsageEvidence – empty array throws", () => {
  assert.throws(() => normalizeUsageEvidence([]), (err: unknown) => {
    assert.ok(err instanceof UsageEvidenceError)
    return true
  })
})

test("normalizeUsageEvidence – mismatched identity throws", () => {
  const base: UsageEvidenceRecord = {
    evidenceId: "ev-x1",
    version: USAGE_EVIDENCE_VERSION,
    taskId: "task-a",
    runId: "run-a",
    attempt: 1,
    runnerId: "runner-a",
    timestamp: "2026-01-15T10:00:00.000Z",
    provider: { id: "openai", model: "gpt-4o" },
    tokens: { input: 100, output: 50 },
    requests: { count: 1 },
    timeBounds: { startedAt: "2026-01-15T09:59:50.000Z", completedAt: "2026-01-15T10:00:00.000Z" },
    source: "runner_self_report",
    proofQuality: "unverified",
  }
  const other = { ...base, evidenceId: "ev-x2", taskId: "task-b" }
  assert.throws(() => normalizeUsageEvidence([base, other]), (err: unknown) => {
    assert.ok(err instanceof UsageEvidenceError)
    return true
  })
})

// --- Proof Quality Classification ---

test("classifyProofQuality – vectors", async (t) => {
  const fixture = loadVectors("proof_quality.json") as {
    vectors: { id: string; input: unknown; expected: string }[]
  }

  for (const vector of fixture.vectors) {
    await t.test(vector.id, () => {
      const record = validateUsageEvidence(vector.input)
      const result = classifyProofQuality(record)
      assert.equal(result, vector.expected)
    })
  }
})

// --- Receipt Binding ---

test("bindEvidenceToReceipt – matching receipt", () => {
  const evidence: UsageEvidenceRecord = {
    evidenceId: "ev-bind1",
    version: USAGE_EVIDENCE_VERSION,
    taskId: "task-123",
    runId: "run-456",
    attempt: 2,
    runnerId: "runner-r1",
    timestamp: "2026-01-15T10:00:00.000Z",
    provider: { id: "openai", model: "gpt-4o" },
    tokens: { input: 100, output: 50 },
    requests: { count: 1 },
    timeBounds: { startedAt: "2026-01-15T09:59:50.000Z", completedAt: "2026-01-15T10:00:00.000Z" },
    source: "runner_self_report",
    proofQuality: "unverified",
  }
  assert.equal(bindEvidenceToReceipt(evidence, { taskId: "task-123", runId: "run-456", attempt: 2 }), true)
})

test("bindEvidenceToReceipt – mismatching receipt", () => {
  const evidence: UsageEvidenceRecord = {
    evidenceId: "ev-bind2",
    version: USAGE_EVIDENCE_VERSION,
    taskId: "task-123",
    runId: "run-456",
    attempt: 2,
    runnerId: "runner-r1",
    timestamp: "2026-01-15T10:00:00.000Z",
    provider: { id: "openai", model: "gpt-4o" },
    tokens: { input: 100, output: 50 },
    requests: { count: 1 },
    timeBounds: { startedAt: "2026-01-15T09:59:50.000Z", completedAt: "2026-01-15T10:00:00.000Z" },
    source: "runner_self_report",
    proofQuality: "unverified",
  }
  assert.equal(bindEvidenceToReceipt(evidence, { taskId: "task-999", runId: "run-456", attempt: 2 }), false)
  assert.equal(bindEvidenceToReceipt(evidence, { taskId: "task-123", runId: "run-999", attempt: 2 }), false)
  assert.equal(bindEvidenceToReceipt(evidence, { taskId: "task-123", runId: "run-456", attempt: 1 }), false)
})
