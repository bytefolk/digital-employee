import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"

import {
  EVIDENCE_CLASSES,
  REAL_LOCAL_HARNESS_VERSION,
  buildPhaseResult,
  loadHarnessContext,
  validatePhaseAMatrix,
} from "../../packages/core/src/real-local-harness.js"
import { COMPONENT_MATRIX_SCHEMA_ID, REAL_LOCAL_CODES } from "../../packages/core/src/component-matrix.js"
import { CoreError } from "../../packages/core/src/contracts.js"

const FIXTURES_DIR = path.resolve(
  import.meta.dirname ?? ".",
  "../../fixtures/real-local-mcp",
)

test("EVIDENCE_CLASSES contains exactly three frozen classes", () => {
  assert.deepEqual([...EVIDENCE_CLASSES], [
    "synthetic-conformance",
    "real-local-e2e",
    "live-provider",
  ])
})

test("REAL_LOCAL_HARNESS_VERSION is frozen", () => {
  assert.equal(REAL_LOCAL_HARNESS_VERSION, "real-local-harness.v1")
})

test("loadHarnessContext loads valid matrix and grants from fixture paths", () => {
  const context = loadHarnessContext({
    matrixPath: path.join(FIXTURES_DIR, "component-matrix.json"),
    grantsPath: path.join(FIXTURES_DIR, "capability-grants.json"),
    evidenceClass: "real-local-e2e",
  })
  assert.equal(context.evidenceClass, "real-local-e2e")
  assert.equal(context.matrix.schema, COMPONENT_MATRIX_SCHEMA_ID)
  assert.equal(context.matrix.components.length, 2)
  assert.equal(context.grants.grantedBy, "operator")
})

test("loadHarnessContext rejects non-real-local-e2e evidence class", () => {
  assert.throws(
    () =>
      loadHarnessContext({
        matrixPath: path.join(FIXTURES_DIR, "component-matrix.json"),
        grantsPath: path.join(FIXTURES_DIR, "capability-grants.json"),
        evidenceClass: "synthetic-conformance",
      }),
    (error: unknown) =>
      error instanceof CoreError &&
      error.code === REAL_LOCAL_CODES.contractUnsupported,
  )
})

test("loadHarnessContext fails on missing matrix file", () => {
  assert.throws(
    () =>
      loadHarnessContext({
        matrixPath: "/nonexistent/matrix.json",
        grantsPath: path.join(FIXTURES_DIR, "capability-grants.json"),
        evidenceClass: "real-local-e2e",
      }),
    (error: unknown) =>
      error instanceof CoreError &&
      error.code === REAL_LOCAL_CODES.matrixUnsupported,
  )
})

test("loadHarnessContext fails on missing grants file", () => {
  assert.throws(
    () =>
      loadHarnessContext({
        matrixPath: path.join(FIXTURES_DIR, "component-matrix.json"),
        grantsPath: "/nonexistent/grants.json",
        evidenceClass: "real-local-e2e",
      }),
    (error: unknown) =>
      error instanceof CoreError &&
      error.code === REAL_LOCAL_CODES.grantMissing,
  )
})

test("validatePhaseAMatrix passes with both mem and doc pinned", () => {
  const context = loadHarnessContext({
    matrixPath: path.join(FIXTURES_DIR, "component-matrix.json"),
    grantsPath: path.join(FIXTURES_DIR, "capability-grants.json"),
    evidenceClass: "real-local-e2e",
  })
  assert.doesNotThrow(() => validatePhaseAMatrix(context.matrix))
})

test("validatePhaseAMatrix fails when mem is missing from matrix", () => {
  assert.throws(
    () =>
      validatePhaseAMatrix({
        schema: COMPONENT_MATRIX_SCHEMA_ID,
        components: [
          {
            name: "doc",
            repository: "https://github.com/bytefolk/doc",
            commit: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
            contract: "document-read.v1",
            startCommand: "make test-env-up",
            healthEndpoint: "/v1/version",
            ports: { http: 8322 },
          },
        ],
      }),
    (error: unknown) =>
      error instanceof CoreError &&
      error.code === REAL_LOCAL_CODES.matrixUnsupported,
  )
})

test("buildPhaseResult builds a stable result with component pins", () => {
  const context = loadHarnessContext({
    matrixPath: path.join(FIXTURES_DIR, "component-matrix.json"),
    grantsPath: path.join(FIXTURES_DIR, "capability-grants.json"),
    evidenceClass: "real-local-e2e",
  })
  const result = buildPhaseResult("phase-a-read-only", context, [])
  assert.equal(result.phase, "phase-a-read-only")
  assert.equal(result.evidenceClass, "real-local-e2e")
  assert.equal(result.passed, true)
  assert.equal(result.matrixSchema, COMPONENT_MATRIX_SCHEMA_ID)
  assert.equal(result.components.length, 2)
  assert.ok(result.components[0].startsWith("mem@"))
  assert.ok(result.components[1].startsWith("doc@"))
  assert.deepEqual(result.errors, [])
})

test("buildPhaseResult marks failure when errors present", () => {
  const context = loadHarnessContext({
    matrixPath: path.join(FIXTURES_DIR, "component-matrix.json"),
    grantsPath: path.join(FIXTURES_DIR, "capability-grants.json"),
    evidenceClass: "real-local-e2e",
  })
  const result = buildPhaseResult("phase-a-read-only", context, [
    "service_unavailable:mem",
  ])
  assert.equal(result.passed, false)
  assert.equal(result.errors.length, 1)
})
