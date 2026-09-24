import assert from "node:assert/strict"
import test from "node:test"

import {
  projectS1NetworkEvidence,
  validateTurnEvidenceRecord,
  TURN_EVIDENCE_VERSION,
  type TurnEvidenceRecord,
} from "../../packages/engine/src/index.js"
import { createHash } from "node:crypto"

test("#309 AC-001: undeclared and deny record effective deny", () => {
  assert.deepEqual(projectS1NetworkEvidence(undefined), {
    declared: "undeclared",
    effective: "deny",
    enforceable: false,
  })
  assert.deepEqual(projectS1NetworkEvidence("deny"), {
    declared: "deny",
    effective: "deny",
    enforceable: false,
  })
})

test("#309 AC-002: allowlist/host_policy are recorded unenforceable, not rewritten to deny", () => {
  assert.deepEqual(projectS1NetworkEvidence("allowlist"), {
    declared: "allowlist",
    effective: "declared_unenforceable",
    enforceable: false,
  })
  assert.deepEqual(projectS1NetworkEvidence("host_policy"), {
    declared: "host_policy",
    effective: "declared_unenforceable",
    enforceable: false,
  })
})

test("#309 evidence records with network still conform", () => {
  const digest = (seed: string) =>
    createHash("sha256").update(seed, "utf8").digest("hex")
  const record: TurnEvidenceRecord = {
    schemaVersion: TURN_EVIDENCE_VERSION,
    evidenceId: "evidence-1",
    workspaceRef: "/tmp/workspace",
    positionId: "repo-owner",
    turnId: "turn-1",
    runId: "run-1",
    engineVersion: "0.1.0",
    inputDigest: digest("input"),
    outputDigest: digest("output"),
    budget: { turn: { iterationsUsed: 1, tokensUsed: 2, maxIterations: 4 } },
    terminal: { status: "completed", reason: "goal_met" },
    network: projectS1NetworkEvidence("allowlist"),
    assemblyManifestDigest: digest("assembly"),
    timeBounds: {
      startedAt: "2026-09-05T00:00:00.000Z",
      completedAt: "2026-09-05T00:00:01.000Z",
    },
  }
  assert.equal(validateTurnEvidenceRecord(record).ok, true)
})
