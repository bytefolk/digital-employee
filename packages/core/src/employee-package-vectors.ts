/**
 * Employee-package golden vector corpus runner.
 *
 * Mirrors the agent-host-vectors pattern: language-neutral JSON vectors are
 * parsed and classified against frozen validation rules, producing a stable
 * machine-readable result.
 */

import { CoreError } from "./contracts.js"
import {
  EMPLOYEE_PACKAGE_SCHEMA_VERSION,
  validateEmployeePackageManifest,
} from "./employee-package.js"
import { computeEmployeePackageDigest } from "./employee-package-digest.js"
import type { EmployeePackageDigestEntry } from "./employee-package-digest.js"
import {
  classifySchemaCompatibility,
  detectUnknownManifestFields,
} from "./employee-package-compat.js"

// --- Schema constants ---

export const EMPLOYEE_PACKAGE_VECTOR_SCHEMA_VERSION =
  "employee-package-vectors.v1"
export const EMPLOYEE_PACKAGE_VECTOR_RESULT_SCHEMA_VERSION =
  "employee-package-vectors-result.v1"

export const EMPLOYEE_PACKAGE_VECTOR_FAMILIES = Object.freeze([
  "schema_validation",
  "field_constraints",
  "cross_field",
  "unknown_fields",
  "compatibility",
  "digest",
] as const)

export type EmployeePackageVectorFamily =
  (typeof EMPLOYEE_PACKAGE_VECTOR_FAMILIES)[number]

// --- Vector types ---

export interface EmployeePackageVectorExpectation {
  kind: "accept" | "reject"
  code?: string
}

export interface EmployeePackageVector {
  id: string
  family: EmployeePackageVectorFamily
  description?: string
  input: unknown
  expect: EmployeePackageVectorExpectation
}

export interface EmployeePackageVectorFile {
  schemaVersion: string
  family: EmployeePackageVectorFamily
  vectors: EmployeePackageVector[]
}

export interface EmployeePackageVectorManifestEntry {
  file: string
  sha256: string
  vectorCount: number
}

export interface EmployeePackageVectorManifest {
  schemaVersion: string
  packageSchemaVersion: string
  families: readonly string[]
  files: EmployeePackageVectorManifestEntry[]
}

export interface EmployeePackageVectorClassification {
  kind: "accept" | "reject"
  code?: string
}

export interface EmployeePackageVectorFailure {
  id: string
  family: EmployeePackageVectorFamily
  expected: EmployeePackageVectorExpectation
  actual: EmployeePackageVectorClassification
}

export interface EmployeePackageVectorResult {
  schemaVersion: string
  corpusVersion: string
  packageSchemaVersion: string
  total: number
  passed: number
  failed: EmployeePackageVectorFailure[]
  result: "PASS" | "FAIL"
}

// --- Parsing ---

function vectorError(message: string): CoreError {
  return new CoreError("EMPLOYEE_PACKAGE_VECTORS_INVALID", message, {
    status: 400,
    retryable: false,
  })
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

const VECTOR_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function parseVector(
  value: unknown,
  family: EmployeePackageVectorFamily,
): EmployeePackageVector {
  if (
    !plainRecord(value) ||
    typeof value.id !== "string" ||
    !VECTOR_ID_PATTERN.test(value.id) ||
    value.family !== family ||
    value.input === undefined ||
    !plainRecord(value.expect) ||
    (value.expect.kind !== "accept" && value.expect.kind !== "reject") ||
    (value.expect.kind === "reject" && typeof value.expect.code !== "string")
  ) {
    throw vectorError("vector entry is malformed")
  }
  return {
    id: value.id,
    family,
    ...(typeof value.description === "string"
      ? { description: value.description }
      : {}),
    input: value.input,
    expect: {
      kind: value.expect.kind,
      ...(value.expect.kind === "reject"
        ? { code: value.expect.code as string }
        : {}),
    },
  }
}

export function parseEmployeePackageVectorFile(
  value: unknown,
  expectedFamily: EmployeePackageVectorFamily,
): EmployeePackageVectorFile {
  if (
    !plainRecord(value) ||
    value.schemaVersion !== EMPLOYEE_PACKAGE_VECTOR_SCHEMA_VERSION ||
    value.family !== expectedFamily ||
    !Array.isArray(value.vectors)
  ) {
    throw vectorError(
      `vector file for family ${expectedFamily} is malformed`,
    )
  }
  const seen = new Set<string>()
  const vectors = value.vectors.map((entry) => {
    const vector = parseVector(entry, expectedFamily)
    if (seen.has(vector.id))
      throw vectorError(`duplicate vector id ${vector.id}`)
    seen.add(vector.id)
    return vector
  })
  return {
    schemaVersion: EMPLOYEE_PACKAGE_VECTOR_SCHEMA_VERSION,
    family: expectedFamily,
    vectors,
  }
}

export function parseEmployeePackageVectorManifest(
  value: unknown,
): EmployeePackageVectorManifest {
  if (
    !plainRecord(value) ||
    value.schemaVersion !== EMPLOYEE_PACKAGE_VECTOR_SCHEMA_VERSION ||
    value.packageSchemaVersion !== EMPLOYEE_PACKAGE_SCHEMA_VERSION ||
    !Array.isArray(value.families) ||
    value.families.length !== EMPLOYEE_PACKAGE_VECTOR_FAMILIES.length ||
    !EMPLOYEE_PACKAGE_VECTOR_FAMILIES.every((family) =>
      (value.families as unknown[]).includes(family),
    ) ||
    !Array.isArray(value.files) ||
    value.files.length !== EMPLOYEE_PACKAGE_VECTOR_FAMILIES.length ||
    !value.files.every(
      (entry) =>
        plainRecord(entry) &&
        typeof entry.file === "string" &&
        /^[a-z0-9_]+\.json$/.test(entry.file) &&
        typeof entry.sha256 === "string" &&
        /^[0-9a-f]{64}$/.test(entry.sha256) &&
        typeof entry.vectorCount === "number" &&
        Number.isInteger(entry.vectorCount) &&
        entry.vectorCount > 0,
    )
  ) {
    throw vectorError("vector manifest is malformed")
  }
  return value as unknown as EmployeePackageVectorManifest
}

// --- Classification ---

function classifySchemaValidation(
  input: unknown,
): EmployeePackageVectorClassification {
  try {
    validateEmployeePackageManifest(input)
    return { kind: "accept" }
  } catch (error) {
    const code =
      error instanceof Error ? error.message.split(":")[0] : "unknown"
    return { kind: "reject", code }
  }
}

function classifyFieldConstraints(
  input: unknown,
): EmployeePackageVectorClassification {
  return classifySchemaValidation(input)
}

function classifyCrossField(
  input: unknown,
): EmployeePackageVectorClassification {
  return classifySchemaValidation(input)
}

function classifyUnknownFields(
  input: unknown,
): EmployeePackageVectorClassification {
  // Unknown-field vectors test that the validator rejects unknown fields.
  try {
    validateEmployeePackageManifest(input)
    return { kind: "accept" }
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    if (message.startsWith("employee_package_unknown_field")) {
      return { kind: "reject", code: "employee_package_unknown_field" }
    }
    // Other validation errors
    const code = message.split(":")[0] || "unknown"
    return { kind: "reject", code }
  }
}

function classifyCompatibility(
  input: unknown,
): EmployeePackageVectorClassification {
  if (!plainRecord(input)) {
    return { kind: "reject", code: "schema_version_missing" }
  }
  const decision = classifySchemaCompatibility(input.schemaVersion)
  if (decision.action === "accept" || decision.action === "migrate") {
    return { kind: "accept" }
  }
  return { kind: "reject", code: decision.reason }
}

function classifyDigest(
  input: unknown,
): EmployeePackageVectorClassification {
  if (!plainRecord(input) || !Array.isArray(input.entries)) {
    return { kind: "reject", code: "employee_package_digest_input_invalid" }
  }
  try {
    const entries: EmployeePackageDigestEntry[] = input.entries.map(
      (entry: unknown) => {
        if (!plainRecord(entry)) throw new Error("invalid entry")
        const path = entry.path as string
        // Vectors encode bytes as hex strings for language neutrality
        const hexBytes = entry.bytesHex as string
        const bytes = Buffer.from(hexBytes, "hex")
        return { path, bytes }
      },
    )
    const digest = computeEmployeePackageDigest(entries)
    // If an expected digest is provided, verify it matches
    if (typeof input.expectedDigest === "string") {
      if (digest !== input.expectedDigest) {
        return { kind: "reject", code: "employee_package_digest_mismatch" }
      }
    }
    return { kind: "accept" }
  } catch {
    return { kind: "reject", code: "employee_package_digest_input_invalid" }
  }
}

/** Classifies one vector against the frozen employee-package rules. */
export function classifyEmployeePackageVector(
  vector: EmployeePackageVector,
): EmployeePackageVectorClassification {
  switch (vector.family) {
    case "schema_validation":
      return classifySchemaValidation(vector.input)
    case "field_constraints":
      return classifyFieldConstraints(vector.input)
    case "cross_field":
      return classifyCrossField(vector.input)
    case "unknown_fields":
      return classifyUnknownFields(vector.input)
    case "compatibility":
      return classifyCompatibility(vector.input)
    case "digest":
      return classifyDigest(vector.input)
    default:
      return { kind: "reject", code: "unknown_family" }
  }
}

// --- Corpus runner ---

function expectationsMatch(
  expected: EmployeePackageVectorExpectation,
  actual: EmployeePackageVectorClassification,
): boolean {
  if (expected.kind === "accept") return actual.kind === "accept"
  return actual.kind === "reject" && actual.code === expected.code
}

/** Runs a parsed corpus and produces the stable machine result. */
export function runEmployeePackageVectorCorpus(
  files: readonly EmployeePackageVectorFile[],
): EmployeePackageVectorResult {
  const failures: EmployeePackageVectorFailure[] = []
  let total = 0
  for (const file of files) {
    for (const vector of file.vectors) {
      total += 1
      const actual = classifyEmployeePackageVector(vector)
      if (!expectationsMatch(vector.expect, actual)) {
        failures.push({
          id: vector.id,
          family: vector.family,
          expected: vector.expect,
          actual,
        })
      }
    }
  }
  return {
    schemaVersion: EMPLOYEE_PACKAGE_VECTOR_RESULT_SCHEMA_VERSION,
    corpusVersion: EMPLOYEE_PACKAGE_VECTOR_SCHEMA_VERSION,
    packageSchemaVersion: EMPLOYEE_PACKAGE_SCHEMA_VERSION,
    total,
    passed: total - failures.length,
    failed: failures,
    result: failures.length === 0 ? "PASS" : "FAIL",
  }
}
