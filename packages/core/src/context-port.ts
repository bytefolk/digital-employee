import { createHash } from "node:crypto"

import { CoreError } from "./contracts.js"

/**
 * Strict internal contract for the workbench context plane (#179). The
 * pinned adapter consumes the public `context adapter recall` CLI/stdio
 * envelope (context repository pinned at f63f57f) and re-validates every
 * byte of the returned `context-bundle.v1` envelope before the engine may
 * project it. Recalled context is quoted untrusted data and never grants
 * authority (#179 REQ-004).
 */
export const CONTEXT_BUNDLE_SCHEMA_VERSION = "context-bundle.v1" as const
export const CONTEXT_RULE_VERSION = "workbench-rules.v1" as const
export const CONTEXT_UNTRUSTED_WARNING =
  "UNTRUSTED_CONTEXT_DATA_NOT_INSTRUCTIONS" as const

export const CONTEXT_MAX_BUNDLE_ITEMS = 64
export const CONTEXT_MAX_BUNDLE_BYTES = 64 * 1024

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/
const OPAQUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const LOCATOR_PATTERN =
  /^context:\/\/occurrences\/sha256:[a-f0-9]{64}@[1-9][0-9]*\/artifacts\/sha256:[a-f0-9]{64}$/
const ITEM_KINDS = new Set(["raw_excerpt", "entity_mention", "task_marker"])

export type ContextPortErrorCode =
  | "CONTEXT_AUTH_DENIED"
  | "CONTEXT_BUNDLE_INVALID"
  | "CONTEXT_CONFIGURATION_INVALID"
  | "CONTEXT_CORRUPT_RECORD"
  | "CONTEXT_DENIED"
  | "CONTEXT_NOT_FOUND"
  | "CONTEXT_SCOPE_MISMATCH"
  | "CONTEXT_UNAVAILABLE"

export class ContextPortError extends CoreError {
  constructor(
    code: ContextPortErrorCode,
    message: string,
    options: { retryable?: boolean; status?: number; cause?: unknown } = {},
  ) {
    super(code, message, {
      retryable: options.retryable ?? false,
      status: options.status ?? 400,
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    })
    this.name = "ContextPortError"
  }
}

export type ContextReadMode = "optional" | "required"

export interface ContextScope {
  workspaceId: string
  positionId: string
  principal: string
}

export interface ContextReadRequest extends ContextScope {
  mode: ContextReadMode
  maxItems?: number
  maxBytes?: number
}

export interface ContextBundleItem {
  kind: "raw_excerpt" | "entity_mention" | "task_marker"
  text: string
  artifactId: string
  locator: string
  sourceDigest: string
  artifactDigest: string
  sourceRevision: number
  derivedRevision: number
  ruleVersion: typeof CONTEXT_RULE_VERSION
  eventAt: string
  derivedAt: string
  trust: "untrusted-context-data"
}

export interface ContextBundle {
  schemaVersion: typeof CONTEXT_BUNDLE_SCHEMA_VERSION
  scope: ContextScope
  retrievedAt: string
  consistency: "client-observed-per-item"
  completedWatermark: {
    occurrenceRevision: number
    ruleVersion: typeof CONTEXT_RULE_VERSION
  }
  items: ContextBundleItem[]
  bundleDigest: string
  warnings: string[]
}

export interface ContextPort {
  recall(request: ContextReadRequest): Promise<ContextBundle>
}

/** Canonical JSON with sorted keys (byte-identical to the context repo). */
export function canonicalContextJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalContextJson(entry)).join(",")}]`
  }
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalContextJson(record[key])}`,
    )
    .join(",")}}`
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`
}

/** Digest over every item field except artifactDigest itself. */
export function computeContextArtifactDigest(
  item: Omit<ContextBundleItem, "artifactDigest">,
): string {
  return sha256(canonicalContextJson(item))
}

/** Digest over scope/consistency/watermark/items/warnings (not retrievedAt). */
export function computeContextBundleDigest(bundle: ContextBundle): string {
  return sha256(
    canonicalContextJson({
      schemaVersion: bundle.schemaVersion,
      scope: bundle.scope,
      consistency: bundle.consistency,
      completedWatermark: bundle.completedWatermark,
      items: bundle.items,
      warnings: bundle.warnings,
    }),
  )
}

export function deriveContextPrincipal(positionId: string): string {
  return `position.${positionId}`
}

export interface ContextBundleBounds {
  maxItems: number
  maxBytes: number
  /** Clock used for freshness checks; defaults to the system clock. */
  now?: () => Date
  /**
   * Maximum accepted age of `retrievedAt` in milliseconds (default 5 min).
   * A recall envelope is generated at read time, so a stale timestamp means
   * a replayed or forged envelope and fails closed.
   */
  maxAgeMs?: number
  /** Maximum accepted forward clock skew in milliseconds (default 60 s). */
  maxSkewMs?: number
}

function failBundle(message: string): never {
  throw new ContextPortError("CONTEXT_BUNDLE_INVALID", message)
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string") failBundle(message)
  return value
}

function requireSafeInteger(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    failBundle(message)
  }
  return value
}

function hasExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(record).sort()
  const expected = [...keys].sort()
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  )
}

function validateTimestamp(value: unknown, message: string): string {
  const text = requireString(value, message)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text) || !Number.isFinite(Date.parse(text))) {
    failBundle(message)
  }
  return text
}

function validateScopeValue(value: unknown): ContextScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failBundle("context bundle scope is invalid")
  }
  const record = value as Record<string, unknown>
  if (!hasExactKeys(record, ["workspaceId", "positionId", "principal"])) {
    failBundle("context bundle scope is invalid")
  }
  const workspaceId = requireString(
    record.workspaceId,
    "context bundle scope is invalid",
  )
  const positionId = requireString(
    record.positionId,
    "context bundle scope is invalid",
  )
  const principal = requireString(
    record.principal,
    "context bundle scope is invalid",
  )
  if (
    !OPAQUE_PATTERN.test(workspaceId) ||
    !OPAQUE_PATTERN.test(positionId) ||
    !OPAQUE_PATTERN.test(principal)
  ) {
    failBundle("context bundle scope is invalid")
  }
  return { workspaceId, positionId, principal }
}

function validateItem(value: unknown): ContextBundleItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failBundle("context bundle item is invalid")
  }
  const record = value as Record<string, unknown>
  if (
    !hasExactKeys(record, [
      "kind",
      "text",
      "artifactId",
      "locator",
      "sourceDigest",
      "artifactDigest",
      "sourceRevision",
      "derivedRevision",
      "ruleVersion",
      "eventAt",
      "derivedAt",
      "trust",
    ])
  ) {
    failBundle("context bundle item is invalid")
  }
  const kind = requireString(record.kind, "context bundle item is invalid")
  if (!ITEM_KINDS.has(kind)) failBundle("context bundle item is invalid")
  const text = requireString(record.text, "context bundle item is invalid")
  const artifactId = requireString(
    record.artifactId,
    "context bundle item is invalid",
  )
  const locator = requireString(
    record.locator,
    "context bundle item is invalid",
  )
  const sourceDigest = requireString(
    record.sourceDigest,
    "context bundle item is invalid",
  )
  const artifactDigest = requireString(
    record.artifactDigest,
    "context bundle item is invalid",
  )
  if (
    !SHA256_PATTERN.test(artifactId) ||
    !SHA256_PATTERN.test(sourceDigest) ||
    !SHA256_PATTERN.test(artifactDigest) ||
    !LOCATOR_PATTERN.test(locator)
  ) {
    failBundle("context bundle item is invalid")
  }
  const sourceRevision = requireSafeInteger(
    record.sourceRevision,
    "context bundle item is invalid",
  )
  const derivedRevision = requireSafeInteger(
    record.derivedRevision,
    "context bundle item is invalid",
  )
  if (sourceRevision < 1 || derivedRevision < 1) {
    failBundle("context bundle item is invalid")
  }
  const ruleVersion = requireString(
    record.ruleVersion,
    "context bundle item is invalid",
  )
  if (ruleVersion !== CONTEXT_RULE_VERSION) {
    failBundle("context bundle item carries an unexpected rule version")
  }
  const eventAt = validateTimestamp(record.eventAt, "context bundle item is invalid")
  const derivedAt = validateTimestamp(
    record.derivedAt,
    "context bundle item is invalid",
  )
  const trust = requireString(record.trust, "context bundle item is invalid")
  if (trust !== "untrusted-context-data") {
    failBundle("context bundle item carries an unexpected trust label")
  }
  return {
    kind: kind as ContextBundleItem["kind"],
    text,
    artifactId,
    locator,
    sourceDigest,
    artifactDigest,
    sourceRevision,
    derivedRevision,
    ruleVersion: CONTEXT_RULE_VERSION,
    eventAt,
    derivedAt,
    trust: "untrusted-context-data",
  }
}

/**
 * Strict validator for one `context-bundle.v1` envelope (#179 REQ-001).
 * Every field is exact; digests are recomputed; the scope must match the
 * pinned expected scope; bounds and freshness are enforced. Any violation
 * fails closed with a typed ContextPortError.
 */
export function validateContextBundle(
  value: unknown,
  expected: ContextScope,
  bounds: ContextBundleBounds,
): ContextBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failBundle("context bundle envelope is invalid")
  }
  const record = value as Record<string, unknown>
  if (
    !hasExactKeys(record, [
      "schemaVersion",
      "scope",
      "retrievedAt",
      "consistency",
      "completedWatermark",
      "items",
      "bundleDigest",
      "warnings",
    ])
  ) {
    failBundle("context bundle envelope is invalid")
  }
  if (record.schemaVersion !== CONTEXT_BUNDLE_SCHEMA_VERSION) {
    failBundle("context bundle carries an unexpected schema version")
  }
  const scope = validateScopeValue(record.scope)
  if (
    scope.workspaceId !== expected.workspaceId ||
    scope.positionId !== expected.positionId ||
    scope.principal !== expected.principal
  ) {
    throw new ContextPortError(
      "CONTEXT_SCOPE_MISMATCH",
      "The recalled context bundle does not match the pinned scope.",
      { status: 403 },
    )
  }
  const retrievedAt = validateTimestamp(
    record.retrievedAt,
    "context bundle retrievedAt is invalid",
  )
  const now = (bounds.now ?? (() => new Date()))()
  const maxAgeMs = bounds.maxAgeMs ?? 5 * 60_000
  const maxSkewMs = bounds.maxSkewMs ?? 60_000
  const retrievedMs = Date.parse(retrievedAt)
  if (
    retrievedMs > now.getTime() + maxSkewMs ||
    retrievedMs < now.getTime() - maxAgeMs
  ) {
    failBundle("context bundle freshness is outside the accepted window")
  }
  if (record.consistency !== "client-observed-per-item") {
    failBundle("context bundle consistency label is invalid")
  }
  if (
    !record.completedWatermark ||
    typeof record.completedWatermark !== "object" ||
    Array.isArray(record.completedWatermark)
  ) {
    failBundle("context bundle watermark is invalid")
  }
  const watermark = record.completedWatermark as Record<string, unknown>
  if (!hasExactKeys(watermark, ["occurrenceRevision", "ruleVersion"])) {
    failBundle("context bundle watermark is invalid")
  }
  const occurrenceRevision = requireSafeInteger(
    watermark.occurrenceRevision,
    "context bundle watermark is invalid",
  )
  if (occurrenceRevision < 0) failBundle("context bundle watermark is invalid")
  if (watermark.ruleVersion !== CONTEXT_RULE_VERSION) {
    throw new ContextPortError(
      "CONTEXT_CORRUPT_RECORD",
      "The stored context watermark carries an unexpected rule version.",
    )
  }
  if (!Array.isArray(record.items)) failBundle("context bundle items are invalid")
  if (record.items.length > bounds.maxItems) {
    failBundle("context bundle exceeds the requested item bound")
  }
  const items = record.items.map((entry) => validateItem(entry))
  let usedBytes = 0
  for (const item of items) {
    usedBytes += Buffer.byteLength(item.text, "utf8")
    if (usedBytes > bounds.maxBytes) {
      failBundle("context bundle exceeds the requested byte bound")
    }
  }
  if (!Array.isArray(record.warnings)) {
    failBundle("context bundle warnings are invalid")
  }
  const warnings = record.warnings.map((entry) =>
    requireString(entry, "context bundle warnings are invalid"),
  )
  if (!warnings.includes(CONTEXT_UNTRUSTED_WARNING)) {
    failBundle("context bundle is missing the untrusted-data warning")
  }
  const bundleDigest = requireString(
    record.bundleDigest,
    "context bundle digest is invalid",
  )
  if (!SHA256_PATTERN.test(bundleDigest)) {
    failBundle("context bundle digest is invalid")
  }
  const bundle: ContextBundle = {
    schemaVersion: CONTEXT_BUNDLE_SCHEMA_VERSION,
    scope,
    retrievedAt,
    consistency: "client-observed-per-item",
    completedWatermark: {
      occurrenceRevision,
      ruleVersion: CONTEXT_RULE_VERSION,
    },
    items,
    bundleDigest,
    warnings,
  }
  // Digest recomputation fails closed on any payload tamper (#179 AC-002).
  for (const item of items) {
    const recomputed = computeContextArtifactDigest({
      kind: item.kind,
      text: item.text,
      artifactId: item.artifactId,
      locator: item.locator,
      sourceDigest: item.sourceDigest,
      sourceRevision: item.sourceRevision,
      derivedRevision: item.derivedRevision,
      ruleVersion: item.ruleVersion,
      eventAt: item.eventAt,
      derivedAt: item.derivedAt,
      trust: item.trust,
    })
    if (recomputed !== item.artifactDigest) {
      throw new ContextPortError(
        "CONTEXT_CORRUPT_RECORD",
        "A recalled context artifact digest does not match its payload.",
      )
    }
  }
  if (computeContextBundleDigest(bundle) !== bundleDigest) {
    throw new ContextPortError(
      "CONTEXT_CORRUPT_RECORD",
      "The recalled context bundle digest does not match its payload.",
    )
  }
  return bundle
}
