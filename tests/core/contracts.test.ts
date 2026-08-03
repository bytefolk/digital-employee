import assert from "node:assert/strict"
import test from "node:test"

import {
  CoreError,
  sanitizeDetails,
  structuredError,
  validateAnswerRequest,
  validateModelResponse,
} from "../../packages/core/index.js"

test("answer request validation normalizes IDs and redacts secret metadata", () => {
  const request = validateAnswerRequest({
    actorId: "  actor-1 ",
    message: "  Where is the handbook?  ",
    metadata: {
      apiKey: "should-not-leak",
      nested: { note: "token=private-value" },
    },
  })

  assert.equal(request.actorId, "actor-1")
  assert.equal(request.sessionId, "actor-1")
  assert.equal(request.message, "Where is the handbook?")
  assert.equal(request.metadata.apiKey, "[REDACTED]")
  const nested = request.metadata.nested
  assert.ok(nested && typeof nested === "object" && !Array.isArray(nested))
  assert.equal(nested.note, "token=[REDACTED]")
})

test("model response supports the public needsHuman contract", () => {
  assert.deepEqual(validateModelResponse({ needsHuman: true }), {
    answer: null,
    confidence: null,
    citationIds: [],
    toolCalls: [],
    escalate: true,
    escalationReason: undefined,
  })
})

test("structured errors preserve safe fields without exposing credentials or stack traces", () => {
  const error = new CoreError(
    "PROVIDER_ERROR",
    "Provider failed with token=private-value",
    {
      retryable: true,
      details: {
        apiKey: "private-key",
        endpoint: "https://example.test/run?token=private-query",
      },
    },
  )
  error.stack = "sensitive internal stack"

  assert.deepEqual(structuredError(error), {
    code: "PROVIDER_ERROR",
    message: "Provider failed with token=[REDACTED]",
    retryable: true,
    details: {
      apiKey: "[REDACTED]",
      endpoint: "https://example.test/run?token=[REDACTED]",
    },
  })
  assert.equal(JSON.stringify(structuredError(error)).includes("stack"), false)

  const unknown = structuredError(
    new Error("password=private-value at /private/path"),
  )
  assert.equal(unknown.code, "INTERNAL_ERROR")
  assert.equal(JSON.stringify(unknown).includes("private-value"), false)
})

test("sanitizing untrusted JSON keeps __proto__ as inert data", () => {
  const input = JSON.parse('{"__proto__":{"polluted":true},"safe":"value"}')
  const sanitized = sanitizeDetails(input)

  assert.equal(Object.getPrototypeOf(sanitized), Object.prototype)
  assert.deepEqual(Object.keys(sanitized as object), ["__proto__", "safe"])
  assert.equal(({} as { polluted?: boolean }).polluted, undefined)
  assert.equal(JSON.stringify(sanitized).includes('"__proto__"'), true)
})
