import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { buildTurnEnvelopeSchema } from "../../apps/cli/turn/envelope-schema.js"
import {
  computeEnvelopeDigest,
  parseTurnEnvelope,
  TURN_ENVELOPE_VERSION,
} from "../../apps/cli/turn/envelope.js"

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
)
const publishedSchemaPath = path.join(
  packageRoot,
  "configs",
  "turn-envelope.schema.json",
)

test("published turn-envelope.schema.json matches the code-side builder", async () => {
  const published = await readFile(publishedSchemaPath, "utf8")
  assert.equal(
    published,
    `${JSON.stringify(buildTurnEnvelopeSchema(), null, 2)}\n`,
  )
})

function sealedEnvelope(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const body = {
    schemaVersion: TURN_ENVELOPE_VERSION,
    workspaceRef: "/tmp/ws",
    positionId: "repo-owner",
    turnId: "turn-1",
    input: "Summarize the open issues.",
    budget: { maxIterations: 2 },
    ...overrides,
  }
  return { ...body, envelopeDigest: computeEnvelopeDigest(body) }
}

test("parseTurnEnvelope accepts a correctly sealed envelope", () => {
  const envelope = parseTurnEnvelope(sealedEnvelope())
  assert.equal(envelope.schemaVersion, TURN_ENVELOPE_VERSION)
  assert.equal(envelope.positionId, "repo-owner")
  assert.equal(envelope.budget?.maxIterations, 2)
})

test("parseTurnEnvelope rejects a tampered envelope before consumption", () => {
  const envelope = sealedEnvelope()
  envelope.input = "tampered after sealing"
  assert.throws(
    () => parseTurnEnvelope(envelope),
    (error: unknown) =>
      (error as { code?: string }).code === "engine.envelope_digest_mismatch",
  )
})

test("parseTurnEnvelope rejects an unknown schemaVersion", () => {
  const envelope = sealedEnvelope({ schemaVersion: "turn-envelope.v0" })
  assert.throws(
    () => parseTurnEnvelope(envelope),
    (error: unknown) =>
      (error as { code?: string }).code === "engine.envelope_invalid",
  )
})

test("position-budget triple must be all-present or all-absent", () => {
  const partial = sealedEnvelope({
    taskId: "task-1",
    dayKey: "2026-08-23",
  })
  assert.throws(
    () => parseTurnEnvelope(partial),
    (error: unknown) =>
      (error as { code?: string }).code === "engine.input_invalid",
  )
  const complete = sealedEnvelope({
    positionBudget: {
      perTask: { iterations: 2 },
      perDay: { iterations: 10 },
    },
    taskId: "task-1",
    dayKey: "2026-08-23",
  })
  const envelope = parseTurnEnvelope(complete)
  assert.equal(envelope.taskId, "task-1")
  assert.equal(envelope.positionBudget?.perDay.iterations, 10)
})

test("computeEnvelopeDigest is canonical: key order does not matter", () => {
  const a = computeEnvelopeDigest({ b: 1, a: { d: 2, c: [1, 2] } })
  const b = computeEnvelopeDigest({ a: { c: [1, 2], d: 2 }, b: 1 })
  assert.equal(a, b)
})

test("#193: a sealed pendingApproval verdict is accepted at the envelope boundary", () => {
  const envelope = parseTurnEnvelope(
    sealedEnvelope({
      pendingApproval: {
        approvalId: "appr-1",
        decision: "granted",
        decidedBy: "operator",
        scope: "once",
        expiresAt: "2026-08-26T00:00:00.000Z",
      },
    }),
  )
  assert.equal(envelope.pendingApproval?.approvalId, "appr-1")
  assert.equal(envelope.pendingApproval?.decision, "granted")
})

test("#193 AC-005: malformed pendingApproval shapes reject before consumption", () => {
  const malformed: Array<Record<string, unknown>> = [
    { approvalId: "appr-1", decision: "maybe", decidedBy: "operator" },
    { approvalId: "appr-1", decision: "granted", decidedBy: "someone-else" },
    { decision: "granted", decidedBy: "operator" },
    {
      approvalId: "appr-1",
      decision: "granted",
      decidedBy: "operator",
      scope: "session",
    },
    {
      approvalId: "appr-1",
      decision: "denied",
      decidedBy: "operator",
      reason: "x".repeat(1025),
    },
    {
      approvalId: "appr-1",
      decision: "granted",
      decidedBy: "operator",
      expiresAt: "not-a-timestamp",
    },
  ]
  for (const pendingApproval of malformed) {
    assert.throws(
      () => parseTurnEnvelope(sealedEnvelope({ pendingApproval })),
      (error: unknown) =>
        (error as { code?: string }).code === "engine.input_invalid",
    )
  }
})
