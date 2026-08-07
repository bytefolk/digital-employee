/**
 * Real-local harness for Phase A (Issue #42): credential-free read-only
 * acceptance against actual pinned mem and doc services.
 *
 * This module provides the evidence classification, matrix loading, and
 * harness lifecycle needed to run reproducible real-local-e2e tests. It
 * does NOT run the services itself — that responsibility belongs to the
 * operator via the documented component-matrix startCommand.
 */
import { readFileSync } from "node:fs"

import { CoreError } from "./contracts.js"
import {
  COMPONENT_MATRIX_SCHEMA_ID,
  REAL_LOCAL_CODES,
  requireMatrixComponent,
  validateComponentMatrix,
} from "./component-matrix.js"
import type { ComponentMatrix } from "./component-matrix.js"
import { validateCapabilityGrants } from "./mcp-conformance.js"
import type { CapabilityGrantSet } from "./mcp-conformance.js"

export const EVIDENCE_CLASSES = [
  "synthetic-conformance",
  "real-local-e2e",
  "live-provider",
] as const

export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number]

export const REAL_LOCAL_HARNESS_VERSION = "real-local-harness.v1" as const

export interface HarnessConfig {
  matrixPath: string
  grantsPath: string
  evidenceClass: EvidenceClass
}

export interface HarnessContext {
  matrix: ComponentMatrix
  grants: CapabilityGrantSet
  evidenceClass: EvidenceClass
}

export interface HarnessPhaseResult {
  phase: string
  evidenceClass: EvidenceClass
  passed: boolean
  matrixSchema: string
  components: string[]
  errors: string[]
}

function harnessError(code: string, message: string, details?: unknown): CoreError {
  return new CoreError(code, message, {
    status: 400,
    retryable: false,
    details,
  })
}

/**
 * Loads and validates the harness configuration: component matrix and
 * capability grants from checked-in fixture paths. Fails explicitly
 * on any missing, malformed, or unsupported input.
 */
export function loadHarnessContext(config: HarnessConfig): HarnessContext {
  if (config.evidenceClass !== "real-local-e2e") {
    throw harnessError(
      REAL_LOCAL_CODES.contractUnsupported,
      `only real-local-e2e evidence satisfies this harness, got: ${config.evidenceClass}`,
    )
  }

  let matrixRaw: string
  try {
    matrixRaw = readFileSync(config.matrixPath, "utf8")
  } catch {
    throw harnessError(
      REAL_LOCAL_CODES.matrixUnsupported,
      "cannot read component-matrix file",
      { path: config.matrixPath },
    )
  }

  let matrixParsed: unknown
  try {
    matrixParsed = JSON.parse(matrixRaw)
  } catch {
    throw harnessError(
      REAL_LOCAL_CODES.matrixUnsupported,
      "component-matrix is not valid JSON",
    )
  }

  const matrix = validateComponentMatrix(matrixParsed)

  let grantsRaw: string
  try {
    grantsRaw = readFileSync(config.grantsPath, "utf8")
  } catch {
    throw harnessError(
      REAL_LOCAL_CODES.grantMissing,
      "cannot read capability-grants file",
      { path: config.grantsPath },
    )
  }

  let grantsParsed: unknown
  try {
    grantsParsed = JSON.parse(grantsRaw)
  } catch {
    throw harnessError(
      REAL_LOCAL_CODES.grantInvalid,
      "capability-grants is not valid JSON",
    )
  }

  const grants = validateCapabilityGrants(grantsParsed)

  return { matrix, grants, evidenceClass: config.evidenceClass }
}

/**
 * Validates that the matrix pins both required components at the expected
 * contracts. Called before any service interaction to fail fast on
 * unsupported matrices.
 */
export function validatePhaseAMatrix(matrix: ComponentMatrix): void {
  requireMatrixComponent(matrix, "mem", "durable-context.v1")
  requireMatrixComponent(matrix, "doc", "document-read.v1")
}

/**
 * Builds a stable evidence result for a completed phase run. The result
 * includes the pinned matrix schema and component names for reproducibility.
 */
export function buildPhaseResult(
  phase: string,
  context: HarnessContext,
  errors: string[],
): HarnessPhaseResult {
  return {
    phase,
    evidenceClass: context.evidenceClass,
    passed: errors.length === 0,
    matrixSchema: COMPONENT_MATRIX_SCHEMA_ID,
    components: context.matrix.components.map((c) => `${c.name}@${c.commit}`),
    errors,
  }
}
