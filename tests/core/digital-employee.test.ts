import assert from "node:assert/strict"
import test from "node:test"

import {
  CoreError,
  DigitalEmployee,
  EscalationPolicy,
  JobRunner,
  LexicalRetriever,
  VerifiedFaqStore,
} from "../../packages/core/index.js"

function createPermissiveEscalationPolicy() {
  return new EscalationPolicy({
    minEvidence: 0,
    minCitations: 0,
  })
}

test("DigitalEmployee answers with traceable citations and the public model contract", async () => {
  let modelInput
  const retriever = new LexicalRetriever([
    {
      id: "handbook-leave",
      title: "Team handbook: leave",
      text: "Submit the leave form at least two working days in advance.",
      source: {
        type: "git",
        uri: "https://example.test/handbook/leave.md",
      },
      metadata: { revision: "abc123" },
    },
  ])
  const employee = new DigitalEmployee({
    profile: {
      id: "answer-agent",
      role: "Knowledge assistant",
      instructions: "Use only supplied contexts.",
    },
    retriever,
    async model(input) {
      modelInput = input
      return {
        answer: "Submit the leave form two working days in advance.",
        confidence: 0.93,
        citationIds: ["handbook-leave", "invented-source"],
      }
    },
  })

  const result = await employee.answer({
    requestId: "request-1",
    actorId: "user-1",
    sessionId: "conversation-1",
    message: "When should I submit the leave form?",
  })

  assert.equal(result.ok, true)
  assert.equal(result.status, "answered")
  assert.equal(result.confidence, 0.93)
  assert.deepEqual(result.citations, [
    {
      id: "handbook-leave",
      label: "Team handbook: leave",
      uri: "https://example.test/handbook/leave.md",
      sourceType: "git",
      metadata: { revision: "abc123" },
    },
  ])
  assert.equal(modelInput.question, "When should I submit the leave form?")
  assert.equal(modelInput.contexts[0].id, "handbook-leave")
  assert.equal(modelInput.profile.id, "answer-agent")
  assert.deepEqual(modelInput.history, [])
  assert.equal(modelInput.employee.readOnly, true)
})

test("DigitalEmployee escalates when a high-confidence answer has no valid citation", async () => {
  const retriever = new LexicalRetriever([
    {
      id: "approved-guide",
      title: "Approved guide",
      text: "Use the documented support flow.",
      source: {
        type: "git",
        uri: "https://example.test/guide.md",
      },
    },
  ])
  const employee = new DigitalEmployee({
    retriever,
    model: async () => ({
      answer: "Use the documented support flow.",
      confidence: 0.99,
      citationIds: ["invented-source"],
    }),
    escalationPolicy: new EscalationPolicy({
      minConfidence: 0.5,
      minEvidence: 1,
      minCitations: 1,
      message: "A maintainer must verify this answer.",
    }),
  })

  const result = await employee.answer({
    requestId: "request-no-valid-citation",
    actorId: "user-no-valid-citation",
    message: "What support flow should I use?",
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, "escalated")
  assert.equal(result.escalation.reason, "insufficient_citations")
  assert.equal(result.answer, "A maintainer must verify this answer.")
  assert.deepEqual(result.citations, [])
})

test("DigitalEmployee hands low-confidence and explicit needsHuman responses to a human", async () => {
  const lowConfidence = new DigitalEmployee({
    model: async () => ({
      answer: "This might be the process.",
      confidence: 0.2,
    }),
    escalationPolicy: new EscalationPolicy({
      minConfidence: 0.7,
      target: "support-queue",
      message: "A human teammate will take a look.",
    }),
  })
  const lowResult = await lowConfidence.answer({
    requestId: "request-low",
    actorId: "user-low",
    message: "What is the exception process?",
  })
  assert.equal(lowResult.status, "escalated")
  assert.equal(lowResult.escalation.reason, "low_confidence")
  assert.equal(lowResult.escalation.target, "support-queue")

  const explicit = new DigitalEmployee({
    model: async () => ({
      needsHuman: true,
      escalationReason: "Requires policy owner approval",
    }),
  })
  const explicitResult = await explicit.answer({
    requestId: "request-human",
    actorId: "user-human",
    message: "Can this exception be approved?",
  })
  assert.equal(explicitResult.status, "escalated")
  assert.equal(explicitResult.escalation.reason, "model_requested")
  assert.equal(
    explicitResult.escalation.details.modelReason,
    "Requires policy owner approval",
  )
})

test("DigitalEmployee returns a redacted structured error and escalates model failures", async () => {
  const employee = new DigitalEmployee({
    model: async () => {
      throw new CoreError(
        "PROVIDER_ERROR",
        "Provider rejected token=private-value",
        {
          retryable: true,
          details: { apiKey: "private-key", provider: "example" },
        },
      )
    },
  })

  const result = await employee.answer({
    requestId: "request-error",
    actorId: "user-error",
    message: "Where is the handbook?",
  })
  assert.equal(result.status, "escalated")
  assert.equal(result.escalation.reason, "execution_error")
  assert.deepEqual(result.error, {
    code: "PROVIDER_ERROR",
    message: "Provider rejected token=[REDACTED]",
    retryable: true,
    details: { apiKey: "[REDACTED]", provider: "example" },
  })
})

test("DigitalEmployee exposes JobRunner cooldown as a structured rejection", async () => {
  let now = 5_000
  const employee = new DigitalEmployee({
    model: async () => ({ answer: "Done.", confidence: 1 }),
    escalationPolicy: createPermissiveEscalationPolicy(),
    jobRunner: new JobRunner({
      cooldownMs: 1_000,
      clock: () => now,
    }),
  })
  const first = await employee.answer({
    requestId: "request-1",
    actorId: "user-1",
    message: "First question",
  })
  assert.equal(first.status, "answered")

  now += 100
  const second = await employee.answer({
    requestId: "request-2",
    actorId: "user-1",
    message: "Second question",
  })
  assert.equal(second.status, "rejected")
  assert.equal(second.error.code, "RATE_LIMITED")
  assert.equal(second.error.details.retryAfterMs, 900)
})

test("DigitalEmployee is read-only by default and does not execute write tools", async () => {
  let writeExecuted = false
  let calls = 0
  const employee = new DigitalEmployee({
    escalationPolicy: createPermissiveEscalationPolicy(),
    tools: [
      {
        name: "update-record",
        mode: "write",
        async execute() {
          writeExecuted = true
          return { updated: true }
        },
      },
    ],
    async model(input) {
      calls += 1
      if (calls === 1) {
        return {
          toolCalls: [
            {
              id: "call-1",
              name: "update-record",
              input: { recordId: "record-1" },
            },
          ],
        }
      }
      assert.equal(input.toolResults[0].ok, false)
      assert.equal(
        input.toolResults[0].error.code,
        "READ_ONLY_VIOLATION",
      )
      return {
        answer: "The requested write was not performed.",
        confidence: 1,
      }
    },
  })

  const result = await employee.answer({
    requestId: "request-write",
    actorId: "user-write",
    message: "Update the record.",
  })
  assert.equal(result.status, "answered")
  assert.equal(writeExecuted, false)
})

test("DigitalEmployee denies verified FAQ learning without an authorizer", async () => {
  const faqStore = new VerifiedFaqStore()
  const employee = new DigitalEmployee({
    faqStore,
    escalationPolicy: createPermissiveEscalationPolicy(),
    model: async () => ({
      answer: "The handbook is in the shared repository.",
      confidence: 0.9,
    }),
  })
  await employee.answer({
    requestId: "request-feedback-default-deny",
    actorId: "user-feedback",
    sessionId: "session-feedback-default-deny",
    message: "Where is the handbook?",
  })

  assert.deepEqual(
    employee.recordFeedback({
      sessionId: "session-feedback-default-deny",
      verified: true,
    }),
    { stored: false, reason: "feedback_not_authorized" },
  )
  assert.equal(faqStore.stats().count, 0)
})

test("DigitalEmployee stores FAQ memory only after authorized verified feedback", async () => {
  const faqStore = new VerifiedFaqStore()
  const reviewerCapability = Object.freeze({ type: "faq-reviewer" })
  let authorizationInput
  const employee = new DigitalEmployee({
    faqStore,
    escalationPolicy: createPermissiveEscalationPolicy(),
    authorizeFeedback(input) {
      authorizationInput = input
      return input.authorization === reviewerCapability
    },
    model: async () => ({
      answer: "The handbook is in the shared repository.",
      confidence: 0.9,
    }),
  })
  await employee.answer({
    requestId: "request-feedback",
    actorId: "user-feedback",
    sessionId: "session-feedback",
    message: "Where is the handbook?",
  })

  assert.deepEqual(
    employee.recordFeedback({
      sessionId: "session-feedback",
      verified: false,
    }),
    { stored: false, reason: "unverified_feedback" },
  )
  assert.equal(faqStore.stats().count, 0)

  assert.deepEqual(
    employee.recordFeedback({
      sessionId: "session-feedback",
      verified: true,
      note: "The requester confirmed the answer.",
      authorization: reviewerCapability,
    }),
    { stored: false, reason: "feedback_not_authorized" },
  )
  assert.equal(faqStore.stats().count, 0)

  const verified = employee.recordFeedback(
    {
      sessionId: "session-feedback",
      verified: true,
      note: "The reviewer confirmed the answer.",
    },
    reviewerCapability,
  )
  assert.equal(verified.stored, true)
  assert.equal(faqStore.stats().count, 1)
  assert.equal(authorizationInput.authorization, reviewerCapability)
  assert.equal(authorizationInput.requestId, "request-feedback")
  assert.equal(authorizationInput.exchange.question, "Where is the handbook?")
  assert.equal(
    authorizationInput.exchange.answer,
    "The handbook is in the shared repository.",
  )
})

test("DigitalEmployee never promotes an escalated response to verified FAQ memory", async () => {
  const faqStore = new VerifiedFaqStore()
  let authorizationCalls = 0
  const employee = new DigitalEmployee({
    faqStore,
    authorizeFeedback() {
      authorizationCalls += 1
      return true
    },
    model: async () => ({
      answer: "This answer has no approved evidence.",
      confidence: 0.99,
    }),
  })
  const result = await employee.answer({
    requestId: "request-feedback-escalated",
    actorId: "user-feedback",
    sessionId: "session-feedback-escalated",
    message: "What is the undocumented exception?",
  })

  assert.equal(result.status, "escalated")
  assert.deepEqual(
    employee.recordFeedback(
      {
        sessionId: "session-feedback-escalated",
        verified: true,
      },
      { reviewer: "trusted" },
    ),
    { stored: false, reason: "exchange_not_answered" },
  )
  assert.equal(authorizationCalls, 0)
  assert.equal(faqStore.stats().count, 0)
})

test("DigitalEmployee never promotes a stale answer after a failed request", async () => {
  const faqStore = new VerifiedFaqStore()
  let shouldFail = false
  const employee = new DigitalEmployee({
    faqStore,
    authorizeFeedback: () => true,
    escalationPolicy: {
      evaluate: () => ({ required: false }),
    },
    model: async () => {
      if (shouldFail) {
        throw new CoreError("PROVIDER_ERROR", "Provider unavailable")
      }
      return {
        answer: "The handbook is in the shared repository.",
        confidence: 0.9,
      }
    },
  })
  const answered = await employee.answer({
    requestId: "request-feedback-before-failure",
    actorId: "user-feedback",
    sessionId: "session-feedback-failed",
    message: "Where is the handbook?",
  })
  assert.equal(answered.status, "answered")

  shouldFail = true
  const failed = await employee.answer({
    requestId: "request-feedback-failed",
    actorId: "user-feedback",
    sessionId: "session-feedback-failed",
    message: "What changed today?",
  })
  assert.equal(failed.status, "failed")

  assert.deepEqual(
    employee.recordFeedback(
      {
        sessionId: "session-feedback-failed",
        verified: true,
      },
      { reviewer: "trusted" },
    ),
    { stored: false, reason: "exchange_not_answered" },
  )
  assert.equal(faqStore.stats().count, 0)
})
