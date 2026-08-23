import assert from "node:assert/strict"
import test from "node:test"

import {
  ENGINE_MAX_OUTPUT_SCHEMA_BYTES,
  OutputSchemaGuardError,
  prepareTerminalSchema,
} from "../../packages/engine/src/index.js"

test("undefined schema prepares nothing", () => {
  assert.equal(prepareTerminalSchema(undefined), undefined)
})

test("valid schema compiles and validates candidates", () => {
  const prepared = prepareTerminalSchema({
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
  })
  assert.ok(prepared)
  assert.equal(prepared!.validate({ answer: "ok" }), true)
  assert.equal(prepared!.validate({ answer: 3 }), false)
  assert.equal(prepared!.validate("nope"), false)
})

test("oversized schema fails closed", () => {
  const schema = {
    type: "object",
    properties: { filler: { description: "x".repeat(ENGINE_MAX_OUTPUT_SCHEMA_BYTES) } },
  }
  assert.throws(
    () => prepareTerminalSchema(schema),
    (error: unknown) =>
      error instanceof OutputSchemaGuardError &&
      error.code === "engine.output_schema_too_large",
  )
})

test("async schema fails closed", () => {
  const schema = {
    $async: true,
    type: "object",
    properties: { answer: { type: "string" } },
  }
  assert.throws(
    () => prepareTerminalSchema(schema),
    (error: unknown) =>
      error instanceof OutputSchemaGuardError &&
      error.code === "engine.output_schema_invalid",
  )
})

test("malformed schema fails closed", () => {
  assert.throws(
    () => prepareTerminalSchema({ type: "not-a-type" }),
    (error: unknown) => error instanceof OutputSchemaGuardError,
  )
})

test("the snapshot json round-trips the schema value", () => {
  const schema = { type: "object", properties: { ok: { type: "boolean" } } }
  const prepared = prepareTerminalSchema(schema)
  assert.deepEqual(JSON.parse(prepared!.json), schema)
})
