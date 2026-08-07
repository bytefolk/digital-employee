/**
 * Provider-neutral usage evidence semantics for runner billing attestation.
 *
 * IMPORTANT constraints:
 * - Evidence must NOT contain Credit, price, currency, rate, discount, or settlement authority
 * - Evidence must NOT store prompts, completions, chain-of-thought, credentials
 * - Runner self-report is "unverified" — cannot become billable by signature alone
 */

export const USAGE_EVIDENCE_VERSION = "usage-evidence.v1" as const

// --- Types ---

export type UsageEvidenceSource =
  | "runner_self_report"
  | "provider_signed"
  | "gateway_trusted"
  | "unknown"

export type UsageEvidenceProofQuality =
  | "unverified"
  | "runner_attested"
  | "provider_signed"
  | "gateway_verified"

export interface UsageEvidenceProvider {
  id: string
  model: string
  region?: string
  [key: string]: unknown // Extension: unknown fields preserved
}

export interface UsageEvidenceTokens {
  input: number
  output: number
  cached?: number
}

export interface UsageEvidenceRequests {
  count: number
  toolCalls?: number
}

export interface UsageEvidenceTimeBounds {
  startedAt: string
  completedAt: string
}

export interface UsageEvidenceRecord {
  evidenceId: string
  version: typeof USAGE_EVIDENCE_VERSION
  taskId: string
  runId: string
  attempt: number
  runnerId: string
  timestamp: string
  provider: UsageEvidenceProvider
  tokens: UsageEvidenceTokens
  requests: UsageEvidenceRequests
  timeBounds: UsageEvidenceTimeBounds
  source: UsageEvidenceSource
  proofQuality: UsageEvidenceProofQuality
  proofReference?: string
  redactions?: string[]
}

export interface UsageEvidenceNormalization {
  monotonicity: boolean
  aggregatedCount: number
  violations: string[]
}

// --- Validation ---

const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/

const VALID_SOURCES: readonly UsageEvidenceSource[] = [
  "runner_self_report",
  "provider_signed",
  "gateway_trusted",
  "unknown",
]

const VALID_PROOF_QUALITIES: readonly UsageEvidenceProofQuality[] = [
  "unverified",
  "runner_attested",
  "provider_signed",
  "gateway_verified",
]

function assertString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new UsageEvidenceError(`${field} must be a non-empty string`)
  }
  return value
}

function assertId(value: unknown, field: string): string {
  const s = assertString(value, field)
  if (!ID_PATTERN.test(s)) {
    throw new UsageEvidenceError(`${field} has invalid format`)
  }
  return s
}

function assertTimestamp(value: unknown, field: string): string {
  const s = assertString(value, field)
  if (!ISO_TIMESTAMP_PATTERN.test(s)) {
    throw new UsageEvidenceError(`${field} must be an ISO 8601 UTC timestamp`)
  }
  return s
}

function assertNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new UsageEvidenceError(`${field} must be a non-negative integer`)
  }
  return value
}

function assertPositiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new UsageEvidenceError(`${field} must be a positive integer`)
  }
  return value
}

export class UsageEvidenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsageEvidenceError"
  }
}

export function validateUsageEvidence(input: unknown): UsageEvidenceRecord {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new UsageEvidenceError("Evidence must be a plain object")
  }
  const raw = input as Record<string, unknown>

  const evidenceId = assertId(raw.evidenceId, "evidenceId")
  const version = assertString(raw.version, "version")
  if (version !== USAGE_EVIDENCE_VERSION) {
    throw new UsageEvidenceError(
      `version must be "${USAGE_EVIDENCE_VERSION}", got "${version}"`,
    )
  }
  const taskId = assertId(raw.taskId, "taskId")
  const runId = assertId(raw.runId, "runId")
  const attempt = assertPositiveInt(raw.attempt, "attempt")
  const runnerId = assertId(raw.runnerId, "runnerId")
  const timestamp = assertTimestamp(raw.timestamp, "timestamp")

  // Provider
  if (raw.provider === null || typeof raw.provider !== "object" || Array.isArray(raw.provider)) {
    throw new UsageEvidenceError("provider must be a plain object")
  }
  const providerRaw = raw.provider as Record<string, unknown>
  const providerId = assertString(providerRaw.id, "provider.id")
  const providerModel = assertString(providerRaw.model, "provider.model")
  const providerRegion =
    providerRaw.region !== undefined ? assertString(providerRaw.region, "provider.region") : undefined

  // Preserve unknown provider fields
  const provider: UsageEvidenceProvider = { ...providerRaw, id: providerId, model: providerModel }
  if (providerRegion !== undefined) {
    provider.region = providerRegion
  } else {
    delete provider.region
  }

  // Tokens
  if (raw.tokens === null || typeof raw.tokens !== "object" || Array.isArray(raw.tokens)) {
    throw new UsageEvidenceError("tokens must be a plain object")
  }
  const tokensRaw = raw.tokens as Record<string, unknown>
  const tokens: UsageEvidenceTokens = {
    input: assertNonNegativeInt(tokensRaw.input, "tokens.input"),
    output: assertNonNegativeInt(tokensRaw.output, "tokens.output"),
  }
  if (tokensRaw.cached !== undefined) {
    tokens.cached = assertNonNegativeInt(tokensRaw.cached, "tokens.cached")
  }

  // Requests
  if (raw.requests === null || typeof raw.requests !== "object" || Array.isArray(raw.requests)) {
    throw new UsageEvidenceError("requests must be a plain object")
  }
  const requestsRaw = raw.requests as Record<string, unknown>
  const requests: UsageEvidenceRequests = {
    count: assertPositiveInt(requestsRaw.count, "requests.count"),
  }
  if (requestsRaw.toolCalls !== undefined) {
    requests.toolCalls = assertNonNegativeInt(requestsRaw.toolCalls, "requests.toolCalls")
  }

  // TimeBounds
  if (raw.timeBounds === null || typeof raw.timeBounds !== "object" || Array.isArray(raw.timeBounds)) {
    throw new UsageEvidenceError("timeBounds must be a plain object")
  }
  const timeBoundsRaw = raw.timeBounds as Record<string, unknown>
  const timeBounds: UsageEvidenceTimeBounds = {
    startedAt: assertTimestamp(timeBoundsRaw.startedAt, "timeBounds.startedAt"),
    completedAt: assertTimestamp(timeBoundsRaw.completedAt, "timeBounds.completedAt"),
  }
  if (new Date(timeBounds.completedAt).getTime() < new Date(timeBounds.startedAt).getTime()) {
    throw new UsageEvidenceError("timeBounds.completedAt must not be before timeBounds.startedAt")
  }

  // Source
  const source = assertString(raw.source, "source") as UsageEvidenceSource
  if (!VALID_SOURCES.includes(source)) {
    throw new UsageEvidenceError(
      `source must be one of: ${VALID_SOURCES.join(", ")}`,
    )
  }

  // ProofQuality
  const proofQuality = assertString(raw.proofQuality, "proofQuality") as UsageEvidenceProofQuality
  if (!VALID_PROOF_QUALITIES.includes(proofQuality)) {
    throw new UsageEvidenceError(
      `proofQuality must be one of: ${VALID_PROOF_QUALITIES.join(", ")}`,
    )
  }

  // ProofReference (optional)
  const proofReference =
    raw.proofReference !== undefined ? assertString(raw.proofReference, "proofReference") : undefined

  // Redactions (optional)
  let redactions: string[] | undefined
  if (raw.redactions !== undefined) {
    if (!Array.isArray(raw.redactions)) {
      throw new UsageEvidenceError("redactions must be an array")
    }
    redactions = raw.redactions.map((r: unknown, i: number) => assertString(r, `redactions[${i}]`))
  }

  const record: UsageEvidenceRecord = {
    evidenceId,
    version: USAGE_EVIDENCE_VERSION,
    taskId,
    runId,
    attempt,
    runnerId,
    timestamp,
    provider,
    tokens,
    requests,
    timeBounds,
    source,
    proofQuality,
  }
  if (proofReference !== undefined) record.proofReference = proofReference
  if (redactions !== undefined) record.redactions = redactions

  return record
}

// --- Normalization ---

export function normalizeUsageEvidence(events: UsageEvidenceRecord[]): UsageEvidenceRecord {
  if (events.length === 0) {
    throw new UsageEvidenceError("Cannot normalize empty evidence array")
  }
  if (events.length === 1) {
    return events[0]
  }

  // All events must share the same identity
  const first = events[0]
  for (const e of events) {
    if (e.taskId !== first.taskId || e.runId !== first.runId || e.attempt !== first.attempt) {
      throw new UsageEvidenceError(
        "All evidence records must share taskId, runId, and attempt for normalization",
      )
    }
  }

  // Sort by timestamp for monotonicity check
  const sorted = [...events].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  )

  // Monotonicity: tokens can only increase within an attempt
  const violations: string[] = []
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]
    const curr = sorted[i]
    if (curr.tokens.input < prev.tokens.input) {
      violations.push(
        `tokens.input decreased from ${prev.tokens.input} to ${curr.tokens.input} at ${curr.evidenceId}`,
      )
    }
    if (curr.tokens.output < prev.tokens.output) {
      violations.push(
        `tokens.output decreased from ${prev.tokens.output} to ${curr.tokens.output} at ${curr.evidenceId}`,
      )
    }
  }

  // Aggregate: take the maximum token counts, sum requests, widest time bounds
  const last = sorted[sorted.length - 1]
  const aggregatedTokens: UsageEvidenceTokens = {
    input: Math.max(...sorted.map((e) => e.tokens.input)),
    output: Math.max(...sorted.map((e) => e.tokens.output)),
  }
  const cachedValues = sorted.map((e) => e.tokens.cached).filter((v): v is number => v !== undefined)
  if (cachedValues.length > 0) {
    aggregatedTokens.cached = Math.max(...cachedValues)
  }

  const aggregatedRequests: UsageEvidenceRequests = {
    count: sorted.reduce((sum, e) => sum + e.requests.count, 0),
  }
  const toolCallValues = sorted.map((e) => e.requests.toolCalls).filter((v): v is number => v !== undefined)
  if (toolCallValues.length > 0) {
    aggregatedRequests.toolCalls = toolCallValues.reduce((a, b) => a + b, 0)
  }

  const startedAts = sorted.map((e) => new Date(e.timeBounds.startedAt).getTime())
  const completedAts = sorted.map((e) => new Date(e.timeBounds.completedAt).getTime())

  // Best proof quality
  const qualityRank: Record<UsageEvidenceProofQuality, number> = {
    unverified: 0,
    runner_attested: 1,
    provider_signed: 2,
    gateway_verified: 3,
  }
  const bestQuality = sorted.reduce(
    (best, e) => (qualityRank[e.proofQuality] > qualityRank[best] ? e.proofQuality : best),
    sorted[0].proofQuality,
  )

  return {
    evidenceId: last.evidenceId,
    version: USAGE_EVIDENCE_VERSION,
    taskId: first.taskId,
    runId: first.runId,
    attempt: first.attempt,
    runnerId: first.runnerId,
    timestamp: last.timestamp,
    provider: last.provider,
    tokens: aggregatedTokens,
    requests: aggregatedRequests,
    timeBounds: {
      startedAt: new Date(Math.min(...startedAts)).toISOString(),
      completedAt: new Date(Math.max(...completedAts)).toISOString(),
    },
    source: last.source,
    proofQuality: violations.length > 0 ? "unverified" : bestQuality,
    proofReference: last.proofReference,
    redactions: last.redactions,
  }
}

// --- Proof Quality Classification ---

export function classifyProofQuality(record: UsageEvidenceRecord): UsageEvidenceProofQuality {
  // Runner self-report can never be higher than unverified
  if (record.source === "runner_self_report") {
    return "unverified"
  }
  if (record.source === "unknown") {
    return "unverified"
  }
  if (record.source === "provider_signed") {
    return record.proofQuality === "provider_signed" ? "provider_signed" : "runner_attested"
  }
  if (record.source === "gateway_trusted") {
    return record.proofQuality === "gateway_verified" ? "gateway_verified" : "runner_attested"
  }
  return "unverified"
}

// --- Receipt Binding ---

export function bindEvidenceToReceipt(
  evidence: UsageEvidenceRecord,
  receipt: { taskId: string; runId: string; attempt: number },
): boolean {
  return (
    evidence.taskId === receipt.taskId &&
    evidence.runId === receipt.runId &&
    evidence.attempt === receipt.attempt
  )
}
