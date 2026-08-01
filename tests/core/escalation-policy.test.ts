import assert from "node:assert/strict"
import test from "node:test"

import { EscalationPolicy } from "../../packages/core/index.js"

const answer = {
  answer: "Use the approved support flow.",
  confidence: 0.99,
}

test("EscalationPolicy requires evidence and a citation by default", () => {
  const policy = new EscalationPolicy()

  assert.deepEqual(policy.evaluate({ response: answer }), {
    required: true,
    reason: "insufficient_evidence",
    target: "human-support",
    message:
      "I could not answer this reliably, so I have requested human help.",
    details: {
      evidenceCount: 0,
      minimum: 1,
    },
  })

  assert.deepEqual(
    policy.evaluate({
      response: answer,
      evidence: [{ id: "approved-source" }],
    }),
    {
      required: true,
      reason: "insufficient_citations",
      target: "human-support",
      message:
        "I could not answer this reliably, so I have requested human help.",
      details: {
        citationCount: 0,
        minimum: 1,
      },
    },
  )

  assert.deepEqual(
    policy.evaluate({
      response: answer,
      evidence: [{ id: "approved-source" }],
      citations: [{ id: "approved-source" }],
    }),
    { required: false },
  )
})

test("EscalationPolicy still supports explicit zero thresholds", () => {
  const policy = new EscalationPolicy({
    minEvidence: 0,
    minCitations: 0,
  })

  assert.deepEqual(policy.evaluate({ response: answer }), {
    required: false,
  })
})
