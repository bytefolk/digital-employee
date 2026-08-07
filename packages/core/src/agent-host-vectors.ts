import { createHash } from "node:crypto"
import { CoreError } from "./contracts.js"
import { AGENT_HOST_PROTOCOL_VERSION } from "./agent-host.js"
import {
  AGENT_HOST_VECTOR_CODES,
  classifyAgentHostCompatibility,
  classifyAgentHostEventStream,
  validateAgentHostEventWire,
  validateAgentHostProbeWire,
  validateAgentHostRunRequestWire,
} from "./agent-host-wire.js"
import type { AgentHostVectorClassification } from "./agent-host-wire.js"

export const AGENT_HOST_VECTOR_SCHEMA_VERSION = "agent-host-vectors.v1"
export const AGENT_HOST_VECTOR_RESULT_SCHEMA_VERSION =
  "agent-host-vectors-result.v1"

export const AGENT_HOST_VECTOR_FAMILIES = Object.freeze([
  "probe",
  "preflight",
  "run_request",
  "event",
  "terminal_ordering",
  "cancel_deadline",
  "cleanup",
  "migration",
  "malformed",
])

export type AgentHostVectorFamily =
  (typeof AGENT_HOST_VECTOR_FAMILIES)[number]

export interface AgentHostVectorExpectation {
  kind: "accept" | "reject"
  code?: string
}

export interface AgentHostVector {
  id: string
  family: AgentHostVectorFamily
  context?: Record<string, unknown>
  input: unknown
  expect: AgentHostVectorExpectation
}

export interface AgentHostVectorFile {
  schemaVersion: string
  family: AgentHostVectorFamily
  vectors: AgentHostVector[]
}

export interface AgentHostVectorManifestEntry {
  file: string
  sha256: string
  vectorCount: number
}

export interface AgentHostVectorManifest {
  schemaVersion: string
  protocolVersion: string
  corpusDigest: string
  families: readonly string[]
  files: AgentHostVectorManifestEntry[]
}

export interface AgentHostVectorFailure {
  id: string
  family: AgentHostVectorFamily
  expected: AgentHostVectorExpectation
  actual: AgentHostVectorClassification
}

export interface AgentHostVectorResult {
  schemaVersion: string
  corpusVersion: string
  protocolVersion: string
  total: number
  passed: number
  failed: AgentHostVectorFailure[]
  result: "PASS" | "FAIL"
}

function vectorError(message: string): CoreError {
  return new CoreError("AGENT_HOST_VECTORS_INVALID", message, {
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
  family: AgentHostVectorFamily,
): AgentHostVector {
  if (
    !plainRecord(value) ||
    typeof value.id !== "string" ||
    !VECTOR_ID_PATTERN.test(value.id) ||
    value.family !== family ||
    (value.context !== undefined && !plainRecord(value.context)) ||
    value.input === undefined ||
    !plainRecord(value.expect) ||
    (value.expect.kind !== "accept" && value.expect.kind !== "reject") ||
    (value.expect.kind === "reject" &&
      typeof value.expect.code !== "string")
  ) {
    throw vectorError("vector entry is malformed")
  }
  return {
    id: value.id,
    family,
    ...(value.context ? { context: value.context } : {}),
    input: value.input,
    expect: {
      kind: value.expect.kind,
      ...(value.expect.kind === "reject"
        ? { code: value.expect.code as string }
        : {}),
    },
  }
}

/** Parses one corpus family file with fail-closed structural checks. */
export function parseAgentHostVectorFile(
  value: unknown,
  expectedFamily: AgentHostVectorFamily,
): AgentHostVectorFile {
  if (
    !plainRecord(value) ||
    value.schemaVersion !== AGENT_HOST_VECTOR_SCHEMA_VERSION ||
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
    if (seen.has(vector.id)) throw vectorError(`duplicate vector id ${vector.id}`)
    seen.add(vector.id)
    return vector
  })
  return { schemaVersion: AGENT_HOST_VECTOR_SCHEMA_VERSION, family: expectedFamily, vectors }
}

/**
 * Computes the corpus aggregate digest: sha256 over the sorted
 * "filename:filedigest" entries joined by newlines.
 */
export function computeCorpusDigest(
  files: readonly { file: string; sha256: string }[],
): string {
  const entries = files.map((f) => `${f.file}:${f.sha256}`).sort()
  return createHash("sha256").update(entries.join("\n")).digest("hex")
}

/** Validates the manifest contract and returns it typed. */
export function parseAgentHostVectorManifest(
  value: unknown,
): AgentHostVectorManifest {
  if (
    !plainRecord(value) ||
    value.schemaVersion !== AGENT_HOST_VECTOR_SCHEMA_VERSION ||
    value.protocolVersion !== AGENT_HOST_PROTOCOL_VERSION ||
    typeof value.corpusDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.corpusDigest) ||
    !Array.isArray(value.families) ||
    value.families.length !== AGENT_HOST_VECTOR_FAMILIES.length ||
    !AGENT_HOST_VECTOR_FAMILIES.every((family) =>
      (value.families as unknown[]).includes(family),
    ) ||
    !Array.isArray(value.files) ||
    value.files.length !== AGENT_HOST_VECTOR_FAMILIES.length ||
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
  const files = value.files as Array<{ file: string; sha256: string }>
  const expectedDigest = computeCorpusDigest(files)
  if (value.corpusDigest !== expectedDigest) {
    throw vectorError(
      "vector manifest corpusDigest does not match file entries",
    )
  }
  return value as unknown as AgentHostVectorManifest
}

const CLEANUP_TERMINAL_MARKER = "terminal"
const CLEANUP_START_MARKER = "run_started"
const CLEANUP_PROCESS_MARKER = "process_cleanup"

function classifyCleanupVector(input: unknown): AgentHostVectorClassification {
  if (!plainRecord(input) || !Array.isArray(input.markers)) {
    return {
      kind: "reject",
      code: AGENT_HOST_VECTOR_CODES.terminalContractViolated,
    }
  }
  const markers = input.markers
  if (!markers.every((marker) => typeof marker === "string")) {
    return {
      kind: "reject",
      code: AGENT_HOST_VECTOR_CODES.terminalContractViolated,
    }
  }
  const terminalIndexes = markers
    .map((marker, index) => (marker === CLEANUP_TERMINAL_MARKER ? index : -1))
    .filter((index) => index !== -1)
  const startIndex = markers.indexOf(CLEANUP_START_MARKER)
  const cleanupIndex = markers.lastIndexOf(CLEANUP_PROCESS_MARKER)
  const valid =
    terminalIndexes.length === 1 &&
    startIndex !== -1 &&
    cleanupIndex !== -1 &&
    startIndex < terminalIndexes[0] &&
    terminalIndexes[0] < cleanupIndex
  return valid
    ? { kind: "accept" }
    : {
        kind: "reject",
        code: AGENT_HOST_VECTOR_CODES.terminalContractViolated,
      }
}

function expectedHostIdOf(vector: AgentHostVector): string {
  const context = vector.context ?? {}
  return typeof context.expectedHostId === "string"
    ? context.expectedHostId
    : "fixture"
}

function classifyMalformedVector(
  vector: AgentHostVector,
): AgentHostVectorClassification {
  const input = vector.input
  if (!plainRecord(input)) {
    return { kind: "reject", code: AGENT_HOST_VECTOR_CODES.streamFailed }
  }
  const target = input.target
  const payload = input.payload
  if (target === "probe") {
    try {
      validateAgentHostProbeWire(payload, expectedHostIdOf(vector))
      return { kind: "accept" }
    } catch {
      return { kind: "reject", code: AGENT_HOST_VECTOR_CODES.probeInvalid }
    }
  }
  if (target === "run_request") {
    try {
      validateAgentHostRunRequestWire(payload)
      return { kind: "accept" }
    } catch {
      return {
        kind: "reject",
        code: AGENT_HOST_VECTOR_CODES.preflightInvalid,
      }
    }
  }
  if (target === "event") {
    try {
      validateAgentHostEventWire(payload)
      return { kind: "accept" }
    } catch {
      return { kind: "reject", code: AGENT_HOST_VECTOR_CODES.streamFailed }
    }
  }
  return { kind: "reject", code: AGENT_HOST_VECTOR_CODES.streamFailed }
}

/** Classifies one vector deterministically against the frozen v1 rules. */
export function classifyAgentHostVector(
  vector: AgentHostVector,
): AgentHostVectorClassification {
  switch (vector.family) {
    case "probe":
    case "preflight": {
      try {
        validateAgentHostProbeWire(vector.input, expectedHostIdOf(vector))
        return { kind: "accept" }
      } catch {
        return { kind: "reject", code: AGENT_HOST_VECTOR_CODES.probeInvalid }
      }
    }
    case "run_request": {
      try {
        validateAgentHostRunRequestWire(vector.input)
        return { kind: "accept" }
      } catch {
        return {
          kind: "reject",
          code: AGENT_HOST_VECTOR_CODES.preflightInvalid,
        }
      }
    }
    case "event": {
      try {
        validateAgentHostEventWire(vector.input)
        return { kind: "accept" }
      } catch {
        return { kind: "reject", code: AGENT_HOST_VECTOR_CODES.streamFailed }
      }
    }
    case "terminal_ordering":
    case "cancel_deadline": {
      const input = plainRecord(vector.input) ? vector.input : {}
      const events = Array.isArray(input.events) ? input.events : []
      const context = plainRecord(input.context) ? input.context : {}
      return classifyAgentHostEventStream(events, {
        cancelled: context.cancelled === true,
        deadlineExpired: context.deadlineExpired === true,
      })
    }
    case "cleanup":
      return classifyCleanupVector(vector.input)
    case "migration": {
      const input = plainRecord(vector.input) ? vector.input : {}
      const requiredCapabilities = Array.isArray(input.requiredCapabilities)
        ? (input.requiredCapabilities.filter(
            (entry) => typeof entry === "string",
          ) as string[])
        : []
      return classifyAgentHostCompatibility(
        input.probe,
        requiredCapabilities,
        expectedHostIdOf(vector),
      )
    }
    case "malformed":
      return classifyMalformedVector(vector)
    default:
      return { kind: "reject", code: AGENT_HOST_VECTOR_CODES.streamFailed }
  }
}

function expectationsMatch(
  expected: AgentHostVectorExpectation,
  actual: AgentHostVectorClassification,
): boolean {
  if (expected.kind === "accept") return actual.kind === "accept"
  return actual.kind === "reject" && actual.code === expected.code
}

/** Runs a parsed corpus and produces the stable machine result. */
export function runAgentHostVectorCorpus(
  files: readonly AgentHostVectorFile[],
): AgentHostVectorResult {
  const failures: AgentHostVectorFailure[] = []
  let total = 0
  for (const file of files) {
    for (const vector of file.vectors) {
      total += 1
      const actual = classifyAgentHostVector(vector)
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
    schemaVersion: AGENT_HOST_VECTOR_RESULT_SCHEMA_VERSION,
    corpusVersion: AGENT_HOST_VECTOR_SCHEMA_VERSION,
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    total,
    passed: total - failures.length,
    failed: failures,
    result: failures.length === 0 ? "PASS" : "FAIL",
  }
}
