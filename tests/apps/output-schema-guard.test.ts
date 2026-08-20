import assert from "node:assert/strict"
import test from "node:test"

import {
  SHARED_MAX_OUTPUT_SCHEMA_BYTES,
  prepareOutputSchemaSnapshot,
} from "../../apps/cli/output-schema-guard.js"
import type { SafeValue } from "../../packages/core/index.js"

class GuardError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "GuardError"
  }
}

const errors = {
  tooLarge: () => new GuardError("schema_too_large"),
  invalid: () => new GuardError("schema_invalid"),
  isGuardError: (error: unknown) => error instanceof GuardError,
}

function guardError(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof GuardError)
    return error.code
  }
  assert.fail("expected the guard to throw")
}

test("the shared guard passes undefined through unchanged", () => {
  assert.equal(prepareOutputSchemaSnapshot(undefined, errors), undefined)
})

test("the shared guard prepares one synchronous snapshot per Schema", () => {
  const schema: SafeValue = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  }
  const snapshot = prepareOutputSchemaSnapshot(schema, errors)
  assert.ok(snapshot)
  assert.deepEqual(JSON.parse(snapshot.json), schema)
  assert.deepEqual(snapshot.value, schema)
  assert.equal(snapshot.validate({ answer: "ok" }), true)
  assert.equal(snapshot.validate({ answer: 7 }), false)
  assert.equal(snapshot.validate({}), false)
  assert.equal(snapshot.validate({ answer: "ok", extra: 1 }), false)
})

test("the shared guard rejects $async and invalid Schemas before compile output", () => {
  assert.equal(
    guardError(() =>
      prepareOutputSchemaSnapshot({ $async: true, type: "object" }, errors),
    ),
    "schema_invalid",
  )
  assert.equal(
    guardError(() =>
      prepareOutputSchemaSnapshot(
        { type: "definitely-not-a-json-schema-type" },
        errors,
      ),
    ),
    "schema_invalid",
  )
  assert.equal(
    guardError(() => prepareOutputSchemaSnapshot("not an object" as SafeValue, errors)),
    "schema_invalid",
  )
})

test("the shared guard enforces the byte cap with a typed too-large error", () => {
  assert.equal(SHARED_MAX_OUTPUT_SCHEMA_BYTES, 16 * 1024)
  const oversized: SafeValue = {
    type: "object",
    properties: { filler: { description: "x".repeat(SHARED_MAX_OUTPUT_SCHEMA_BYTES) } },
  }
  assert.equal(
    guardError(() => prepareOutputSchemaSnapshot(oversized, errors)),
    "schema_too_large",
  )
})

test("the shared guard snapshot survives hostile mutation of the source Schema", () => {
  const schema: {
    type: string
    properties: { answer: { type: string } }
    required?: string[]
    additionalProperties: boolean
  } = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  }
  const snapshot = prepareOutputSchemaSnapshot(schema as SafeValue, errors)
  assert.ok(snapshot)
  schema.type = "boolean"
  schema.properties.answer.type = "number"
  delete schema.required
  assert.equal(snapshot.validate({ answer: "ok" }), true)
  assert.equal(snapshot.validate({ answer: 7 }), false)
  assert.deepEqual(JSON.parse(snapshot.json), {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  })
})

test("the shared guard fails closed on non-serializable Schemas", () => {
  assert.equal(
    guardError(() =>
      prepareOutputSchemaSnapshot(BigInt(1) as unknown as SafeValue, errors),
    ),
    "schema_invalid",
  )
})
