import assert from "node:assert/strict"
import test from "node:test"

import {
  COMPONENT_MATRIX_SCHEMA_ID,
  REAL_LOCAL_CODES,
  requireMatrixComponent,
  validateComponentMatrix,
} from "../../packages/core/src/component-matrix.js"
import { CoreError } from "../../packages/core/src/contracts.js"

const MEM_COMMIT = "3335ebea211d7fb65a8ea0e5ea2285b2cbc2d0bd"

function validMatrix(): Record<string, unknown> {
  return {
    schema: COMPONENT_MATRIX_SCHEMA_ID,
    components: [
      {
        name: "mem",
        repository: "https://github.com/bytefolk/mem",
        commit: MEM_COMMIT,
        contract: "durable-context.v1",
        startCommand: "make test-env-up",
        healthEndpoint: "/v1/version",
        ports: { http: 8321 },
      },
    ],
  }
}

function expectUnsupported(value: unknown): void {
  assert.throws(
    () => validateComponentMatrix(value),
    (error: unknown) =>
      error instanceof CoreError &&
      error.code === REAL_LOCAL_CODES.matrixUnsupported,
  )
}

test("a well-formed matrix validates and pins its component", () => {
  const matrix = validateComponentMatrix(validMatrix())
  const entry = requireMatrixComponent(matrix, "mem", "durable-context.v1")
  assert.equal(entry.commit, MEM_COMMIT)
})

test("unknown schema versions fail closed", () => {
  expectUnsupported({ ...validMatrix(), schema: "component-matrix.v2" })
})

test("unknown top-level and entry fields fail closed", () => {
  expectUnsupported({ ...validMatrix(), vendor: "smuggled" })
  const matrix = validMatrix()
  ;(matrix.components as Array<Record<string, unknown>>)[0].mirror = "smuggled"
  expectUnsupported(matrix)
})

test("malformed commits, contracts and ports fail closed", () => {
  for (const patch of [
    { commit: "deadbeef" },
    { commit: MEM_COMMIT.toUpperCase() },
    { contract: "Durable Context" },
    { ports: {} },
    { ports: { http: 0 } },
    { ports: { http: 70000 } },
    { repository: "http://example.com/mem" },
    { startCommand: "" },
  ]) {
    const matrix = validMatrix()
    Object.assign((matrix.components as Array<Record<string, unknown>>)[0], patch)
    expectUnsupported(matrix)
  }
})

test("a missing component or contract mismatch is an unsupported matrix", () => {
  const matrix = validateComponentMatrix(validMatrix())
  assert.throws(
    () => requireMatrixComponent(matrix, "doc", "doc-api.v1"),
    (error: unknown) =>
      error instanceof CoreError &&
      error.code === REAL_LOCAL_CODES.matrixUnsupported,
  )
  assert.throws(
    () => requireMatrixComponent(matrix, "mem", "durable-context.v2"),
    (error: unknown) =>
      error instanceof CoreError &&
      error.code === REAL_LOCAL_CODES.matrixUnsupported,
  )
})

test("missing required entry fields fail closed", () => {
  for (const fieldToRemove of [
    "name",
    "repository",
    "commit",
    "contract",
    "startCommand",
    "healthEndpoint",
    "ports",
  ]) {
    const matrix = validMatrix()
    const entry = (matrix.components as Array<Record<string, unknown>>)[0]
    delete entry[fieldToRemove]
    expectUnsupported(matrix)
  }
})

test("missing top-level schema field fails closed", () => {
  const matrix = validMatrix()
  delete (matrix as Record<string, unknown>).schema
  expectUnsupported(matrix)
})

test("duplicate components fail closed", () => {
  const matrix = validMatrix()
  ;(matrix.components as Array<unknown>).push(
    (matrix.components as Array<Record<string, unknown>>)[0],
  )
  expectUnsupported(matrix)
})
