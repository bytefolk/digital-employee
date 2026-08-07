/**
 * Runner protocol golden vector corpus - language-neutral compatibility test
 * infrastructure for task envelopes, events, event chains, receipts,
 * execution bundles, usage binding, version negotiation, and migration.
 */

import { createPublicKey } from "node:crypto"
import type { KeyLike } from "node:crypto"

import { CoreError } from "./contracts.js"
import {
  RUNNER_PROTOCOL_VERSION,
  canonicalRunnerJson,
  validateSignedEnvelope,
  validateRunnerTask,
  validateRunnerEvent,
  validateRunnerReceipt,
  verifyRunnerTask,
  verifyRunnerReceipt,
  verifyRunnerEventChain,
  verifyRunnerExecutionBundle,
  createRunnerEvent,
} from "./runner-protocol.js"
import type { RunnerEvent } from "./runner-protocol.js"

// --- Schema constants ---

export const RUNNER_PROTOCOL_VECTOR_SCHEMA_VERSION =
  "runner-protocol-vectors.v1" as const
export const RUNNER_PROTOCOL_VECTOR_RESULT_SCHEMA_VERSION =
  "runner-protocol-vectors-result.v1" as const

// --- Vector families ---

export const RUNNER_PROTOCOL_VECTOR_FAMILIES = Object.freeze([
  "canonical_bytes",
  "task_envelope",
  "event_chain",
  "receipt_envelope",
  "execution_bundle",
  "usage_binding",
  "version_negotiation",
  "migration",
] as const)

export type RunnerProtocolVectorFamily =
  (typeof RUNNER_PROTOCOL_VECTOR_FAMILIES)[number]

// --- Vector types ---

export interface RunnerProtocolVectorExpectation {
  kind: "accept" | "reject"
  code?: string
  output?: Record<string, unknown>
}

export interface RunnerProtocolVector {
  id: string
  family: RunnerProtocolVectorFamily
  description?: string
  context?: Record<string, unknown>
  input: unknown
  expect: RunnerProtocolVectorExpectation
}

export interface RunnerProtocolVectorFile {
  schemaVersion: typeof RUNNER_PROTOCOL_VECTOR_SCHEMA_VERSION
  family: RunnerProtocolVectorFamily
  vectors: RunnerProtocolVector[]
}

export interface RunnerProtocolVectorManifestEntry {
  file: string
  sha256: string
  vectorCount: number
}

export interface RunnerProtocolVectorManifest {
  schemaVersion: typeof RUNNER_PROTOCOL_VECTOR_SCHEMA_VERSION
  protocolVersion: typeof RUNNER_PROTOCOL_VERSION
  families: readonly string[]
  files: RunnerProtocolVectorManifestEntry[]
}

export interface RunnerProtocolVectorClassification {
  kind: "accept" | "reject"
  code?: string
  output?: Record<string, unknown>
}

export interface RunnerProtocolVectorFailure {
  id: string
  family: RunnerProtocolVectorFamily
  expected: RunnerProtocolVectorExpectation
  actual: RunnerProtocolVectorClassification
}

export interface RunnerProtocolVectorResult {
  schemaVersion: typeof RUNNER_PROTOCOL_VECTOR_RESULT_SCHEMA_VERSION
  corpusVersion: typeof RUNNER_PROTOCOL_VECTOR_SCHEMA_VERSION
  protocolVersion: typeof RUNNER_PROTOCOL_VERSION
  total: number
  passed: number
  failed: RunnerProtocolVectorFailure[]
  result: "PASS" | "FAIL"
}

// --- Parsing helpers ---

function vectorError(message: string): CoreError {
  return new CoreError("RUNNER_PROTOCOL_VECTORS_INVALID", message, {
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
  family: RunnerProtocolVectorFamily,
): RunnerProtocolVector {
  if (
    !plainRecord(value) ||
    typeof value.id !== "string" ||
    !VECTOR_ID_PATTERN.test(value.id) ||
    value.family !== family ||
    (value.description !== undefined && typeof value.description !== "string") ||
    (value.context !== undefined && !plainRecord(value.context)) ||
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
    ...(value.description ? { description: value.description as string } : {}),
    ...(value.context ? { context: value.context } : {}),
    input: value.input,
    expect: {
      kind: value.expect.kind as "accept" | "reject",
      ...(value.expect.kind === "reject"
        ? { code: value.expect.code as string }
        : {}),
      ...(value.expect.output !== undefined && plainRecord(value.expect.output)
        ? { output: value.expect.output }
        : {}),
    },
  }
}

/** Parses one corpus family file with fail-closed structural checks. */
export function parseRunnerProtocolVectorFile(
  value: unknown,
  expectedFamily: RunnerProtocolVectorFamily,
): RunnerProtocolVectorFile {
  if (
    !plainRecord(value) ||
    value.schemaVersion !== RUNNER_PROTOCOL_VECTOR_SCHEMA_VERSION ||
    value.family !== expectedFamily ||
    !Array.isArray(value.vectors)
  ) {
    throw vectorError(
      `vector file for family ${expectedFamily} is malformed`,
    )
  }
  const seen = new Set<string>()
  const vectors = value.vectors.map((entry: unknown) => {
    const vector = parseVector(entry, expectedFamily)
    if (seen.has(vector.id))
      throw vectorError(`duplicate vector id ${vector.id}`)
    seen.add(vector.id)
    return vector
  })
  return {
    schemaVersion: RUNNER_PROTOCOL_VECTOR_SCHEMA_VERSION,
    family: expectedFamily,
    vectors,
  }
}

/** Validates the manifest contract and returns it typed. */
export function parseRunnerProtocolVectorManifest(
  value: unknown,
): RunnerProtocolVectorManifest {
  if (
    !plainRecord(value) ||
    value.schemaVersion !== RUNNER_PROTOCOL_VECTOR_SCHEMA_VERSION ||
    value.protocolVersion !== RUNNER_PROTOCOL_VERSION ||
    !Array.isArray(value.families) ||
    value.families.length !== RUNNER_PROTOCOL_VECTOR_FAMILIES.length ||
    !RUNNER_PROTOCOL_VECTOR_FAMILIES.every((family) =>
      (value.families as unknown[]).includes(family),
    ) ||
    !Array.isArray(value.files) ||
    value.files.length !== RUNNER_PROTOCOL_VECTOR_FAMILIES.length ||
    !value.files.every(
      (entry: unknown) =>
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
  return value as unknown as RunnerProtocolVectorManifest
}

// --- Classification functions ---

function errorCodeOf(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "UNKNOWN_ERROR"
}

/** Reconstruct a KeyLike from a vector's key representation. */
function keyFromVector(value: unknown): KeyLike {
  if (plainRecord(value) && typeof value.data === "string") {
    return createPublicKey({
      key: Buffer.from(value.data as string, "hex"),
      format: "der",
      type: "spki",
    })
  }
  return value as KeyLike
}

function classifyCanonicalBytes(
  vector: RunnerProtocolVector,
): RunnerProtocolVectorClassification {
  const input = vector.input
  if (!plainRecord(input)) {
    return { kind: "reject", code: "RUNNER_ENVELOPE_INVALID" }
  }
  try {
    const result = canonicalRunnerJson(input.value)
    return { kind: "accept", output: { canonical: result } }
  } catch (error) {
    return { kind: "reject", code: errorCodeOf(error) }
  }
}

function classifyTaskEnvelope(
  vector: RunnerProtocolVector,
): RunnerProtocolVectorClassification {
  const input = vector.input
  if (!plainRecord(input)) {
    return { kind: "reject", code: "RUNNER_ENVELOPE_INVALID" }
  }
  const target = input.target as string | undefined

  if (target === "validate_task") {
    try {
      validateRunnerTask(input.payload)
      return { kind: "accept" }
    } catch (error) {
      return { kind: "reject", code: errorCodeOf(error) }
    }
  }
  if (target === "validate_envelope") {
    try {
      validateSignedEnvelope(input.payload)
      return { kind: "accept" }
    } catch (error) {
      return { kind: "reject", code: errorCodeOf(error) }
    }
  }
  if (target === "verify_task") {
    try {
      const publicKey = keyFromVector(input.publicKey)
      verifyRunnerTask({ envelope: input.envelope, publicKey })
      return { kind: "accept" }
    } catch (error) {
      return { kind: "reject", code: errorCodeOf(error) }
    }
  }
  return { kind: "reject", code: "RUNNER_ENVELOPE_INVALID" }
}

function classifyEventChain(
  vector: RunnerProtocolVector,
): RunnerProtocolVectorClassification {
  const input = vector.input
  if (!plainRecord(input)) {
    return { kind: "reject", code: "RUNNER_EVENT_CHAIN_INVALID" }
  }
  const target = input.target as string | undefined

  if (target === "validate_event") {
    try {
      validateRunnerEvent(input.payload)
      return { kind: "accept" }
    } catch (error) {
      return { kind: "reject", code: errorCodeOf(error) }
    }
  }
  if (target === "create_event") {
    try {
      const event = createRunnerEvent(
        input.payload as Omit<RunnerEvent, "digest">,
      )
      return { kind: "accept", output: { digest: event.digest } }
    } catch (error) {
      return { kind: "reject", code: errorCodeOf(error) }
    }
  }
  if (target === "verify_chain") {
    try {
      const events = input.events as readonly unknown[]
      const identity = input.identity as
        | Record<string, unknown>
        | undefined
      const result = verifyRunnerEventChain(events, identity as never)
      return { kind: "accept", output: { finalDigest: result.finalDigest } }
    } catch (error) {
      return { kind: "reject", code: errorCodeOf(error) }
    }
  }
  return { kind: "reject", code: "RUNNER_EVENT_CHAIN_INVALID" }
}

function classifyReceiptEnvelope(
  vector: RunnerProtocolVector,
): RunnerProtocolVectorClassification {
  const input = vector.input
  if (!plainRecord(input)) {
    return { kind: "reject", code: "RUNNER_ENVELOPE_INVALID" }
  }
  const target = input.target as string | undefined

  if (target === "validate_receipt") {
    try {
      validateRunnerReceipt(input.payload)
      return { kind: "accept" }
    } catch (error) {
      return { kind: "reject", code: errorCodeOf(error) }
    }
  }
  if (target === "verify_receipt") {
    try {
      const publicKey = keyFromVector(input.publicKey)
      verifyRunnerReceipt({ envelope: input.envelope, publicKey })
      return { kind: "accept" }
    } catch (error) {
      return { kind: "reject", code: errorCodeOf(error) }
    }
  }
  return { kind: "reject", code: "RUNNER_RECEIPT_INVALID" }
}

function classifyExecutionBundle(
  vector: RunnerProtocolVector,
): RunnerProtocolVectorClassification {
  const input = vector.input
  if (!plainRecord(input)) {
    return { kind: "reject", code: "RUNNER_RECEIPT_INVALID" }
  }
  try {
    const platformPublicKey = keyFromVector(input.platformPublicKey)
    const runnerPubKey = keyFromVector(input.runnerPublicKey)
    verifyRunnerExecutionBundle({
      taskEnvelope: input.taskEnvelope,
      platformPublicKey,
      events: input.events as readonly unknown[],
      receiptEnvelope: input.receiptEnvelope,
      runnerPublicKey: runnerPubKey,
      observedAt: input.observedAt as string,
    })
    return { kind: "accept" }
  } catch (error) {
    return { kind: "reject", code: errorCodeOf(error) }
  }
}

function classifyUsageBinding(
  vector: RunnerProtocolVector,
): RunnerProtocolVectorClassification {
  const input = vector.input
  if (!plainRecord(input)) {
    return { kind: "reject", code: "RUNNER_RECEIPT_INVALID" }
  }
  try {
    const receipt = validateRunnerReceipt(input.receipt)
    const evidence = input.evidence as
      | Record<string, unknown>
      | undefined
    if (evidence) {
      if (
        evidence.taskId !== receipt.taskId ||
        evidence.runId !== receipt.runId ||
        evidence.attempt !== receipt.attempt
      ) {
        return { kind: "reject", code: "USAGE_BINDING_MISMATCH" }
      }
    }
    return { kind: "accept" }
  } catch (error) {
    return { kind: "reject", code: errorCodeOf(error) }
  }
}

function classifyVersionNegotiation(
  vector: RunnerProtocolVector,
): RunnerProtocolVectorClassification {
  const input = vector.input
  if (!plainRecord(input)) {
    return { kind: "reject", code: "VERSION_UNSUPPORTED" }
  }
  const version = input.protocolVersion
  if (!version || typeof version !== "string") {
    return { kind: "reject", code: "VERSION_UNSUPPORTED" }
  }
  const majorMatch = version.match(
    /^digital-employee\.runner-protocol\.v(\d+)$/,
  )
  if (!majorMatch) {
    return { kind: "reject", code: "VERSION_UNSUPPORTED" }
  }
  const major = Number(majorMatch[1])
  if (major !== 1) {
    return { kind: "reject", code: "VERSION_UNSUPPORTED" }
  }
  if (input.unknownSecurityField !== undefined) {
    return { kind: "reject", code: "UNKNOWN_FIELD_UNSAFE" }
  }
  if (input.downgradeFrom !== undefined) {
    const fromVersion = input.downgradeFrom as string
    const fromMajorMatch = fromVersion.match(
      /^digital-employee\.runner-protocol\.v(\d+)$/,
    )
    if (fromMajorMatch && Number(fromMajorMatch[1]) > major) {
      return { kind: "reject", code: "DOWNGRADE_REJECTED" }
    }
  }
  return { kind: "accept" }
}

function classifyMigration(
  vector: RunnerProtocolVector,
): RunnerProtocolVectorClassification {
  const input = vector.input
  if (!plainRecord(input)) {
    return { kind: "reject", code: "MIGRATION_INVALID" }
  }
  const from = input.fromVersion as string | undefined | null
  const to = input.toVersion as string | undefined | null
  if (!from || !to || typeof from !== "string" || typeof to !== "string") {
    return { kind: "reject", code: "MIGRATION_INVALID" }
  }
  const fromMatch = from.match(
    /^digital-employee\.runner-protocol\.(preview|v\d+)$/,
  )
  const toMatch = to.match(
    /^digital-employee\.runner-protocol\.v(\d+)$/,
  )
  if (!fromMatch || !toMatch) {
    return { kind: "reject", code: "MIGRATION_INVALID" }
  }
  const toMajor = Number(toMatch[1])
  if (toMajor !== 1) {
    return { kind: "reject", code: "MIGRATION_UNSUPPORTED" }
  }
  if (fromMatch[1] === "preview") {
    if (input.payload !== undefined) {
      try {
        validateRunnerTask(input.payload)
        return { kind: "accept" }
      } catch {
        try {
          validateRunnerReceipt(input.payload)
          return { kind: "accept" }
        } catch {
          return { kind: "reject", code: "MIGRATION_PAYLOAD_INVALID" }
        }
      }
    }
    return { kind: "accept" }
  }
  if (fromMatch[1] === "v1") {
    return { kind: "accept" }
  }
  return { kind: "reject", code: "MIGRATION_UNSUPPORTED" }
}

/** Classifies one vector deterministically against the frozen v1 rules. */
export function classifyRunnerProtocolVector(
  vector: RunnerProtocolVector,
): RunnerProtocolVectorClassification {
  switch (vector.family) {
    case "canonical_bytes":
      return classifyCanonicalBytes(vector)
    case "task_envelope":
      return classifyTaskEnvelope(vector)
    case "event_chain":
      return classifyEventChain(vector)
    case "receipt_envelope":
      return classifyReceiptEnvelope(vector)
    case "execution_bundle":
      return classifyExecutionBundle(vector)
    case "usage_binding":
      return classifyUsageBinding(vector)
    case "version_negotiation":
      return classifyVersionNegotiation(vector)
    case "migration":
      return classifyMigration(vector)
    default:
      return { kind: "reject", code: "UNKNOWN_FAMILY" }
  }
}

function expectationsMatch(
  expected: RunnerProtocolVectorExpectation,
  actual: RunnerProtocolVectorClassification,
): boolean {
  if (expected.kind === "accept") return actual.kind === "accept"
  return actual.kind === "reject" && actual.code === expected.code
}

/** Runs a parsed corpus and produces the stable machine result. */
export function runRunnerProtocolVectorCorpus(
  files: readonly RunnerProtocolVectorFile[],
): RunnerProtocolVectorResult {
  const failures: RunnerProtocolVectorFailure[] = []
  let total = 0
  for (const file of files) {
    for (const vector of file.vectors) {
      total += 1
      const actual = classifyRunnerProtocolVector(vector)
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
    schemaVersion: RUNNER_PROTOCOL_VECTOR_RESULT_SCHEMA_VERSION,
    corpusVersion: RUNNER_PROTOCOL_VECTOR_SCHEMA_VERSION,
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    total,
    passed: total - failures.length,
    failed: failures,
    result: failures.length === 0 ? "PASS" : "FAIL",
  }
}
