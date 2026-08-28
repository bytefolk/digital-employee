import { createHash } from "node:crypto"

import type { SafeValue } from "../../core/src/contracts.js"

import type { BudgetUsage } from "./budget.js"
import type { EscalationCause } from "./escalation.js"
import type {
  PermissionDecisionSummary,
  PermissionDenialAttempt,
} from "./org-permissions.js"

export const TURN_EVIDENCE_VERSION = "turn-evidence.v1" as const

/**
 * Per-turn evidence record under the repository evidence standard.
 *
 * Hard content rule: the record carries digests, counters, and bounded
 * identifiers only — never prompt text, model completions, chain-of-thought,
 * or credentials. A turn without evidence is a failed turn; the executor
 * writes this record in the same atomic sequence as the terminal event.
 */

export interface TurnEvidenceBudget {
  turn: {
    iterationsUsed: number
    tokensUsed: number
    maxIterations: number
    maxTokens?: number
  }
  position?: BudgetUsage
}

export interface TurnEvidenceTerminal {
  status: "completed" | "failed"
  reason: string
  errorCode?: string
}

/**
 * Approval chain link for turns settled through the #187 approval gate.
 * Bounded identifiers only — verdict text and action descriptions stay out
 * of evidence. A denied settlement must carry this reference together with
 * the terminal reason (#187 AC-003).
 */
export interface TurnEvidenceApprovalRef {
  approvalId: string
  previewId?: string
  outcome: "requested" | "granted" | "denied" | "expired"
}

/**
 * Per-turn permission decision evidence (#159 REQ-005). Carries the decision
 * summary plus every denial attempt. Denial attempts carry the position, the
 * requested path or tool name, the stable code, and the redirect target — and
 * NEVER any content from the denied resource. This family is disjoint from
 * the approval settlement fields; both are present where applicable.
 */
export interface TurnEvidencePermissions {
  summary: PermissionDecisionSummary
  denials: PermissionDenialAttempt[]
}

/**
 * Digest-only evidence for one recalled memory item (#180 memory-recall
 * seam, consumed through #209). Raw recall text never enters evidence:
 * items are untrusted data with authority "none"; only digests, locators,
 * and bounded counters are recorded. Provenance enters as a digest over the
 * canonical provenance block — never as raw provenance fields (#209
 * REQ-001).
 */
export interface TurnEvidenceMemoryItem {
  digest: string
  locator: string
  kind: string
  stateVersion: number
  byteLength: number
  /** sha256 over the canonical provenance block of the recalled item. */
  provenanceDigest: string
}

export interface TurnEvidenceMemoryWarning {
  code: string
}

/**
 * Digest-only memory-consumption evidence (#209 REQ-001): effective mode,
 * retrievedAt, adapter identity, and per-item locators/state versions/
 * content digests/provenance digests. Never raw recall content, never
 * credentials.
 */
export interface TurnEvidenceMemory {
  mode: "optional" | "required"
  /** Bounded machine identity of the pinned adapter, e.g. "mem-http.v1". */
  adapterIdentity: string
  retrievedAt: string
  itemCount: number
  totalBytes: number
  items: TurnEvidenceMemoryItem[]
  warnings: TurnEvidenceMemoryWarning[]
}

/**
 * Digest-only evidence for one recalled workbench context item (#179).
 * Raw context text never enters evidence: items are untrusted data with
 * trust "untrusted-context-data"; only artifact digests, locators, and
 * bounded counters are recorded.
 */
export interface TurnEvidenceContextItem {
  artifactDigest: string
  locator: string
  kind: string
  sourceRevision: number
  derivedRevision: number
  byteLength: number
}

export interface TurnEvidenceContextWarning {
  code: string
}

/**
 * Digest-only context-consumption evidence (#179 REQ-005): effective mode,
 * adapter identity, bundle digest, completed watermark, and per-item
 * artifact digests/locators. Never raw context content, never credentials.
 */
export interface TurnEvidenceContext {
  mode: "optional" | "required"
  /** Bounded machine identity of the pinned adapter, e.g. "context-cli.v1". */
  adapterIdentity: string
  retrievedAt: string
  /** sha256 bundle digest covering scope/watermark/items/warnings. */
  bundleDigest: string
  /** Completed watermark occurrence revision at recall time. */
  watermarkRevision: number
  itemCount: number
  totalBytes: number
  items: TurnEvidenceContextItem[]
  warnings: TurnEvidenceContextWarning[]
}

export interface TurnEvidenceRecord {
  schemaVersion: typeof TURN_EVIDENCE_VERSION
  evidenceId: string
  workspaceRef: string
  positionId: string
  turnId: string
  runId: string
  engineVersion: string
  /** sha256 over the canonical assembled-context serialization. */
  inputDigest: string
  /** sha256 over the terminal output JSON. */
  outputDigest: string
  budget: TurnEvidenceBudget
  terminal: TurnEvidenceTerminal
  escalationRef?: string
  approvalRef?: TurnEvidenceApprovalRef
  /** Permission decision summary + zero-content denial attempts (#159). */
  permissions?: TurnEvidencePermissions
  /** Digest-only memory-recall consumption evidence (#180 seam). */
  memory?: TurnEvidenceMemory
  /** Digest-only workbench-context consumption evidence (#179 seam). */
  context?: TurnEvidenceContext
  /** Assembly manifest digest from context-assembly.v1. */
  assemblyManifestDigest: string
  timeBounds: {
    startedAt: string
    completedAt: string
  }
}

export interface EvidenceSinkPort {
  write(record: TurnEvidenceRecord): Promise<void>
}

export interface InMemoryEvidenceSink extends EvidenceSinkPort {
  records: readonly TurnEvidenceRecord[]
}

export function createInMemoryEvidenceSink(): InMemoryEvidenceSink {
  const stored: TurnEvidenceRecord[] = []
  return {
    records: stored,
    async write(record) {
      stored.push(record)
    },
  }
}

export function digestOutputValue(output: SafeValue): string {
  const json = JSON.stringify(output)
  return createHash("sha256").update(json ?? "null", "utf8").digest("hex")
}

/**
 * Sentinel assembly digest for turns denied before any context assembly happens
 * (permission pre-check denials, #159 REQ-004(a)).
 */
export const NO_ASSEMBLY_DIGEST = createHash("sha256")
  .update("[]", "utf8")
  .digest("hex")

/**
 * Digest-shaped sentinel recorded as `bundleDigest` when an optional-mode
 * context outage degrades to an empty context (#179 REQ-005): no bundle was
 * observed, so no real bundle digest exists.
 */
export const NO_CONTEXT_BUNDLE_DIGEST = createHash("sha256")
  .update("context-bundle.v1:empty", "utf8")
  .digest("hex")

/**
 * Static content audit for a record: proves the forbidden material classes
 * are absent from the serialized evidence itself.
 */
export function evidenceRecordContainsForbiddenMaterial(
  record: TurnEvidenceRecord,
  probes: readonly string[],
): boolean {
  const serialized = JSON.stringify(record)
  return probes.some(
    (probe) => probe.length > 0 && serialized.includes(probe),
  )
}

export type { EscalationCause }
