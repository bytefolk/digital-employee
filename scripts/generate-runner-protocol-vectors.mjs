/**
 * Generates the runner-protocol-vectors golden fixture files.
 * Run with: npx tsx scripts/generate-runner-protocol-vectors.mjs
 */

import { createHash, createPrivateKey, createPublicKey, sign as ed25519Sign } from "node:crypto"
import { writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))

// RFC 8032 test key (deterministic)
const RFC8032_SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"
const RFC8032_PUBLIC = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
const PRIVATE_KEY = createPrivateKey({
  key: Buffer.from(`302e020100300506032b657004220420${RFC8032_SEED}`, "hex"),
  format: "der",
  type: "pkcs8",
})
const PUBLIC_KEY = createPublicKey({
  key: Buffer.from(`302a300506032b6570032100${RFC8032_PUBLIC}`, "hex"),
  format: "der",
  type: "spki",
})
const PUBLIC_KEY_HEX = `302a300506032b6570032100${RFC8032_PUBLIC}`

const RUNNER_PROTOCOL_VERSION = "digital-employee.runner-protocol.v1"
const RUNNER_EVENT_GENESIS_DIGEST = `sha256:${"0".repeat(64)}`
const RUNNER_TASK_DOMAIN = "digital-employee.runner-task.v1"
const RUNNER_RECEIPT_DOMAIN = "digital-employee.runner-receipt.v1"
const RUNNER_EVENT_DOMAIN = "digital-employee.runner-event.v1"
const PACKAGE_DIGEST = `sha256:${"a".repeat(64)}`
const NONCE = Buffer.alloc(16, 7).toString("base64url")

const VECTORS_DIR = join(__dirname, "../fixtures/runner-protocol-vectors/v1")
mkdirSync(VECTORS_DIR, { recursive: true })

// --- Canonical JSON (deterministic, integers-only) ---
function canonicalJson(value) {
  const encode = (entry) => {
    if (entry === null) return "null"
    if (typeof entry === "string" || typeof entry === "boolean") return JSON.stringify(entry)
    if (typeof entry === "number") return JSON.stringify(entry)
    if (Array.isArray(entry)) return `[${entry.map(encode).join(",")}]`
    const keys = Object.keys(entry).sort()
    return `{${keys.map(k => `${JSON.stringify(k)}:${encode(entry[k])}`).join(",")}}`
  }
  return encode(value)
}

function encodeOpaqueJson(value) {
  const bytes = Buffer.from(JSON.stringify(value), "utf8")
  return { mediaType: "application/json", encoding: "base64url", data: bytes.toString("base64url") }
}

function envelopeSigningBytes(domain, payload) {
  return Buffer.concat([Buffer.from(`${domain}\n`, "ascii"), payload])
}

function signEnvelope(domain, keyId, payload) {
  const payloadBuf = Buffer.from(canonicalJson(payload), "utf8")
  const signature = ed25519Sign(null, envelopeSigningBytes(domain, payloadBuf), PRIVATE_KEY)
  return {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    keyId,
    algorithm: "Ed25519",
    payload: payloadBuf.toString("base64url"),
    signature: signature.toString("base64url"),
  }
}

function hashEvent(event) {
  const json = canonicalJson(event)
  return `sha256:${createHash("sha256").update(`${RUNNER_EVENT_DOMAIN}\n`, "ascii").update(json, "utf8").digest("hex")}`
}

// --- Data builders ---
function goldenTask(overrides = {}) {
  return {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    kind: "runner.task",
    taskId: "task-golden",
    runId: "run-golden",
    attempt: 1,
    fencingToken: 1,
    leaseId: "lease-golden",
    quoteId: "quote-golden",
    reservationId: "reservation-golden",
    sellerId: "seller-golden",
    runnerId: "runner-golden",
    employee: { id: "employee-golden", version: "1.2.3", packageDigest: PACKAGE_DIGEST },
    engine: "claude-code",
    input: encodeOpaqueJson({ question: "hello" }),
    issuedAt: "2026-08-04T00:00:00.000Z",
    expiresAt: "2026-08-04T00:05:00.000Z",
    leaseExpiresAt: "2026-08-04T00:04:00.000Z",
    nonce: NONCE,
    ...overrides,
  }
}

function goldenReceipt(overrides = {}) {
  return {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    kind: "runner.receipt",
    taskId: "task-golden",
    runId: "run-golden",
    attempt: 1,
    fencingToken: 1,
    leaseId: "lease-golden",
    quoteId: "quote-golden",
    reservationId: "reservation-golden",
    sellerId: "seller-golden",
    runnerId: "runner-golden",
    employee: { id: "employee-golden", version: "1.2.3", packageDigest: PACKAGE_DIGEST },
    engine: "claude-code",
    startedAt: "2026-08-04T00:00:01.000Z",
    completedAt: "2026-08-04T00:00:02.000Z",
    eventCount: 0,
    finalEventDigest: RUNNER_EVENT_GENESIS_DIGEST,
    usage: { inputTokens: 10, outputTokens: 5, durationMilliseconds: 1000, actions: [{ name: "knowledge.search", count: 1 }] },
    outcome: { status: "completed", output: encodeOpaqueJson({ answer: "ok" }) },
    ...overrides,
  }
}

function goldenEventBase(overrides = {}) {
  return {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    kind: "runner.event",
    taskId: "task-golden",
    runId: "run-golden",
    attempt: 1,
    fencingToken: 1,
    leaseId: "lease-golden",
    quoteId: "quote-golden",
    runnerId: "runner-golden",
    employeeId: "employee-golden",
    packageDigest: PACKAGE_DIGEST,
    sequence: 1,
    timestamp: "2026-08-04T00:00:01.000Z",
    type: "run.started",
    data: { mediaType: "application/json", encoding: "base64url", data: "" },
    previousDigest: RUNNER_EVENT_GENESIS_DIGEST,
    ...overrides,
  }
}

// Create events with digests
const event1Base = goldenEventBase()
const event1Digest = hashEvent(event1Base)
const event1 = { ...event1Base, digest: event1Digest }

const event2Base = goldenEventBase({
  sequence: 2,
  timestamp: "2026-08-04T00:00:02.000Z",
  type: "usage",
  data: encodeOpaqueJson({ inputTokens: 10, outputTokens: 5 }),
  previousDigest: event1Digest,
})
const event2Digest = hashEvent(event2Base)
const event2 = { ...event2Base, digest: event2Digest }

// --- Vectors ---

const canonicalBytesVectors = [
  { id: "sorted-keys", family: "canonical_bytes", description: "Object keys are sorted lexicographically", input: { value: { z: 1, a: 2, m: 3 } }, expect: { kind: "accept", output: { canonical: '{"a":2,"m":3,"z":1}' } } },
  { id: "nested-sorted", family: "canonical_bytes", description: "Nested objects have keys sorted recursively", input: { value: { outer: { z: true, a: false } } }, expect: { kind: "accept", output: { canonical: '{"outer":{"a":false,"z":true}}' } } },
  { id: "array-preserved", family: "canonical_bytes", description: "Array element order is preserved", input: { value: [3, 1, 2] }, expect: { kind: "accept", output: { canonical: "[3,1,2]" } } },
  { id: "string-unicode", family: "canonical_bytes", description: "Unicode strings are preserved", input: { value: { key: "\u4f60\u597d" } }, expect: { kind: "accept", output: { canonical: '{"key":"\u4f60\u597d"}' } } },
  { id: "integer-boundary-max-safe", family: "canonical_bytes", description: "MAX_SAFE_INTEGER is valid", input: { value: { n: 9007199254740991 } }, expect: { kind: "accept", output: { canonical: '{"n":9007199254740991}' } } },
  { id: "integer-negative", family: "canonical_bytes", description: "Negative integers are valid", input: { value: { n: -42 } }, expect: { kind: "accept", output: { canonical: '{"n":-42}' } } },
  { id: "integer-zero", family: "canonical_bytes", description: "Zero is valid", input: { value: { n: 0 } }, expect: { kind: "accept", output: { canonical: '{"n":0}' } } },
  { id: "null-value", family: "canonical_bytes", description: "null serializes as 'null'", input: { value: null }, expect: { kind: "accept", output: { canonical: "null" } } },
  { id: "boolean-values", family: "canonical_bytes", description: "Booleans serialize correctly", input: { value: { f: false, t: true } }, expect: { kind: "accept", output: { canonical: '{"f":false,"t":true}' } } },
  { id: "empty-object", family: "canonical_bytes", description: "Empty object serializes to '{}'", input: { value: {} }, expect: { kind: "accept", output: { canonical: "{}" } } },
  { id: "empty-array", family: "canonical_bytes", description: "Empty array serializes to '[]'", input: { value: [] }, expect: { kind: "accept", output: { canonical: "[]" } } },
  { id: "deeply-nested", family: "canonical_bytes", description: "Deep nesting serializes deterministically", input: { value: { a: { b: { c: [1, 2, { z: true, a: false }] } } } }, expect: { kind: "accept", output: { canonical: '{"a":{"b":{"c":[1,2,{"a":false,"z":true}]}}}' } } },
]

const taskEnvelopeVectors = [
  { id: "valid-task-payload", family: "task_envelope", description: "Valid task payload passes validation", input: { target: "validate_task", payload: goldenTask() }, expect: { kind: "accept" } },
  { id: "reject-extra-field", family: "task_envelope", description: "Unknown field is rejected (fail-closed)", input: { target: "validate_task", payload: { ...goldenTask(), unknownField: true } }, expect: { kind: "reject", code: "RUNNER_TASK_INVALID" } },
  { id: "reject-wrong-protocol-version", family: "task_envelope", description: "Unsupported protocol version rejected", input: { target: "validate_task", payload: goldenTask({ protocolVersion: "digital-employee.runner-protocol.v2" }) }, expect: { kind: "reject", code: "RUNNER_TASK_INVALID" } },
  { id: "reject-short-nonce", family: "task_envelope", description: "Nonce shorter than 16 bytes rejected", input: { target: "validate_task", payload: goldenTask({ nonce: Buffer.alloc(8, 1).toString("base64url") }) }, expect: { kind: "reject", code: "RUNNER_TASK_INVALID" } },
  { id: "reject-non-iso-timestamp", family: "task_envelope", description: "Timestamp without milliseconds rejected", input: { target: "validate_task", payload: goldenTask({ issuedAt: "2026-08-04T00:00:00Z" }) }, expect: { kind: "reject", code: "RUNNER_TASK_INVALID" } },
  { id: "reject-lease-too-short", family: "task_envelope", description: "Lease below MIN_RUNNER_LEASE_MILLISECONDS rejected", input: { target: "validate_task", payload: goldenTask({ leaseExpiresAt: "2026-08-04T00:00:09.999Z" }) }, expect: { kind: "reject", code: "RUNNER_TASK_INVALID" } },
  { id: "reject-attempt-exceeds-max", family: "task_envelope", description: "Attempt > MAX_RUNNER_ATTEMPTS rejected", input: { target: "validate_task", payload: goldenTask({ attempt: 33 }) }, expect: { kind: "reject", code: "RUNNER_TASK_INVALID" } },
  { id: "reject-invalid-semver", family: "task_envelope", description: "Invalid SemVer rejected", input: { target: "validate_task", payload: goldenTask({ employee: { id: "employee-golden", version: "1.0.0-01", packageDigest: PACKAGE_DIGEST } }) }, expect: { kind: "reject", code: "RUNNER_TASK_INVALID" } },
  { id: "valid-envelope-structure", family: "task_envelope", description: "Signed envelope structure is valid", input: { target: "validate_envelope", payload: signEnvelope(RUNNER_TASK_DOMAIN, "platform-rfc8032-1", goldenTask()) }, expect: { kind: "accept" } },
  { id: "reject-empty-payload", family: "task_envelope", description: "Empty payload rejected", input: { target: "validate_envelope", payload: { protocolVersion: RUNNER_PROTOCOL_VERSION, keyId: "key-1", algorithm: "Ed25519", payload: "", signature: Buffer.alloc(64).toString("base64url") } }, expect: { kind: "reject", code: "RUNNER_ENVELOPE_INVALID" } },
  { id: "reject-wrong-signature-length", family: "task_envelope", description: "Non-64-byte signature rejected", input: { target: "validate_envelope", payload: { protocolVersion: RUNNER_PROTOCOL_VERSION, keyId: "key-1", algorithm: "Ed25519", payload: Buffer.from("{}").toString("base64url"), signature: Buffer.alloc(32).toString("base64url") } }, expect: { kind: "reject", code: "RUNNER_ENVELOPE_INVALID" } },
  { id: "verify-task-valid", family: "task_envelope", description: "Signed task verifies with correct public key", input: { target: "verify_task", envelope: signEnvelope(RUNNER_TASK_DOMAIN, "platform-rfc8032-1", goldenTask()), publicKey: { format: "der", type: "spki", data: PUBLIC_KEY_HEX } }, expect: { kind: "accept" } },
]

const eventChainVectors = [
  { id: "valid-single-event", family: "event_chain", description: "Single valid event with correct digest", input: { target: "validate_event", payload: event1 }, expect: { kind: "accept" } },
  { id: "valid-event-digest", family: "event_chain", description: "createRunnerEvent produces deterministic digest", input: { target: "create_event", payload: event1Base }, expect: { kind: "accept", output: { digest: event1Digest } } },
  { id: "reject-tampered-digest", family: "event_chain", description: "Incorrect digest rejected", input: { target: "validate_event", payload: { ...event1, digest: `sha256:${"b".repeat(64)}` } }, expect: { kind: "reject", code: "RUNNER_EVENT_INVALID" } },
  { id: "reject-invalid-type-case", family: "event_chain", description: "Uppercase type rejected (machine code)", input: { target: "create_event", payload: goldenEventBase({ type: "Run.Started" }) }, expect: { kind: "reject", code: "RUNNER_EVENT_INVALID" } },
  { id: "valid-two-event-chain", family: "event_chain", description: "Two-event chain verifies", input: { target: "verify_chain", events: [event1, event2], identity: { taskId: "task-golden", runId: "run-golden", attempt: 1, fencingToken: 1, leaseId: "lease-golden", quoteId: "quote-golden", runnerId: "runner-golden", employeeId: "employee-golden", packageDigest: PACKAGE_DIGEST } }, expect: { kind: "accept", output: { finalDigest: event2Digest } } },
  { id: "reject-out-of-order-chain", family: "event_chain", description: "Wrong order fails chain verification", input: { target: "verify_chain", events: [event2, event1] }, expect: { kind: "reject", code: "RUNNER_EVENT_CHAIN_INVALID" } },
  { id: "reject-identity-mismatch", family: "event_chain", description: "Wrong taskId fails chain verification", input: { target: "verify_chain", events: [event1], identity: { taskId: "task-wrong", runId: "run-golden", attempt: 1, fencingToken: 1, leaseId: "lease-golden", quoteId: "quote-golden", runnerId: "runner-golden", employeeId: "employee-golden", packageDigest: PACKAGE_DIGEST } }, expect: { kind: "reject", code: "RUNNER_EVENT_CHAIN_INVALID" } },
  { id: "valid-empty-chain", family: "event_chain", description: "Empty chain valid with genesis digest", input: { target: "verify_chain", events: [] }, expect: { kind: "accept", output: { finalDigest: RUNNER_EVENT_GENESIS_DIGEST } } },
]

const receiptEnvelopeVectors = [
  { id: "valid-receipt-completed", family: "receipt_envelope", description: "Valid completed receipt passes", input: { target: "validate_receipt", payload: goldenReceipt() }, expect: { kind: "accept" } },
  { id: "valid-receipt-failed", family: "receipt_envelope", description: "Valid failed receipt passes", input: { target: "validate_receipt", payload: goldenReceipt({ outcome: { status: "failed", errorCode: "timeout" } }) }, expect: { kind: "accept" } },
  { id: "valid-receipt-cancelled", family: "receipt_envelope", description: "Valid cancelled_by_runner receipt passes", input: { target: "validate_receipt", payload: goldenReceipt({ outcome: { status: "cancelled_by_runner", reasonCode: "resource.exhausted" } }) }, expect: { kind: "accept" } },
  { id: "reject-user-cancelled-outcome", family: "receipt_envelope", description: "user_cancelled outcome rejected", input: { target: "validate_receipt", payload: goldenReceipt({ outcome: { status: "user_cancelled" } }) }, expect: { kind: "reject", code: "RUNNER_RECEIPT_INVALID" } },
  { id: "reject-unsorted-actions", family: "receipt_envelope", description: "Unsorted actions rejected", input: { target: "validate_receipt", payload: goldenReceipt({ usage: { inputTokens: 10, outputTokens: 5, durationMilliseconds: 1000, actions: [{ name: "z.action", count: 1 }, { name: "a.action", count: 1 }] } }) }, expect: { kind: "reject", code: "RUNNER_RECEIPT_INVALID" } },
  { id: "reject-event-count-digest-mismatch", family: "receipt_envelope", description: "eventCount > 0 with genesis digest rejected", input: { target: "validate_receipt", payload: goldenReceipt({ eventCount: 1, finalEventDigest: RUNNER_EVENT_GENESIS_DIGEST }) }, expect: { kind: "reject", code: "RUNNER_RECEIPT_INVALID" } },
  { id: "reject-zero-count-nongenesis", family: "receipt_envelope", description: "eventCount 0 with non-genesis rejected", input: { target: "validate_receipt", payload: goldenReceipt({ eventCount: 0, finalEventDigest: `sha256:${"b".repeat(64)}` }) }, expect: { kind: "reject", code: "RUNNER_RECEIPT_INVALID" } },
  { id: "reject-completed-before-started", family: "receipt_envelope", description: "completedAt < startedAt rejected", input: { target: "validate_receipt", payload: goldenReceipt({ startedAt: "2026-08-04T00:00:02.000Z", completedAt: "2026-08-04T00:00:01.000Z" }) }, expect: { kind: "reject", code: "RUNNER_RECEIPT_INVALID" } },
  { id: "reject-extra-field-receipt", family: "receipt_envelope", description: "Unknown field rejected", input: { target: "validate_receipt", payload: { ...goldenReceipt(), billing: { amount: 100 } } }, expect: { kind: "reject", code: "RUNNER_RECEIPT_INVALID" } },
]

// Execution bundle vectors
const bundleReceipt = goldenReceipt({ eventCount: 1, finalEventDigest: event1Digest })
const bundleTaskEnvelope = signEnvelope(RUNNER_TASK_DOMAIN, "platform-rfc8032-1", goldenTask())
const bundleReceiptEnvelope = signEnvelope(RUNNER_RECEIPT_DOMAIN, "runner-key-1", bundleReceipt)

const executionBundleVectors = [
  { id: "valid-bundle", family: "execution_bundle", description: "Complete valid execution bundle verifies", input: { taskEnvelope: bundleTaskEnvelope, platformPublicKey: { format: "der", type: "spki", data: PUBLIC_KEY_HEX }, events: [event1], receiptEnvelope: bundleReceiptEnvelope, runnerPublicKey: { format: "der", type: "spki", data: PUBLIC_KEY_HEX }, observedAt: "2026-08-04T00:00:03.000Z" }, expect: { kind: "accept" } },
  { id: "reject-receipt-runner-mismatch", family: "execution_bundle", description: "Receipt with wrong runnerId fails binding", input: { taskEnvelope: bundleTaskEnvelope, platformPublicKey: { format: "der", type: "spki", data: PUBLIC_KEY_HEX }, events: [event1], receiptEnvelope: signEnvelope(RUNNER_RECEIPT_DOMAIN, "runner-key-1", { ...bundleReceipt, runnerId: "foreign-runner" }), runnerPublicKey: { format: "der", type: "spki", data: PUBLIC_KEY_HEX }, observedAt: "2026-08-04T00:00:03.000Z" }, expect: { kind: "reject", code: "RUNNER_RECEIPT_INVALID" } },
  { id: "reject-completed-at-lease-expiry", family: "execution_bundle", description: "completedAt at lease expiry fails", input: { taskEnvelope: bundleTaskEnvelope, platformPublicKey: { format: "der", type: "spki", data: PUBLIC_KEY_HEX }, events: [event1], receiptEnvelope: signEnvelope(RUNNER_RECEIPT_DOMAIN, "runner-key-1", { ...bundleReceipt, completedAt: "2026-08-04T00:04:00.000Z" }), runnerPublicKey: { format: "der", type: "spki", data: PUBLIC_KEY_HEX }, observedAt: "2026-08-04T00:04:00.000Z" }, expect: { kind: "reject", code: "RUNNER_RECEIPT_INVALID" } },
]

const usageBindingVectors = [
  { id: "valid-binding", family: "usage_binding", description: "Evidence identity matches receipt", input: { receipt: goldenReceipt(), evidence: { taskId: "task-golden", runId: "run-golden", attempt: 1 } }, expect: { kind: "accept" } },
  { id: "reject-task-mismatch", family: "usage_binding", description: "Evidence with different taskId fails", input: { receipt: goldenReceipt(), evidence: { taskId: "task-wrong", runId: "run-golden", attempt: 1 } }, expect: { kind: "reject", code: "USAGE_BINDING_MISMATCH" } },
  { id: "reject-attempt-mismatch", family: "usage_binding", description: "Evidence with different attempt fails", input: { receipt: goldenReceipt(), evidence: { taskId: "task-golden", runId: "run-golden", attempt: 2 } }, expect: { kind: "reject", code: "USAGE_BINDING_MISMATCH" } },
  { id: "valid-no-evidence", family: "usage_binding", description: "Receipt without evidence is valid", input: { receipt: goldenReceipt() }, expect: { kind: "accept" } },
]

const versionNegotiationVectors = [
  { id: "accept-v1", family: "version_negotiation", description: "Protocol version v1 accepted", input: { protocolVersion: "digital-employee.runner-protocol.v1" }, expect: { kind: "accept" } },
  { id: "reject-v2", family: "version_negotiation", description: "Unsupported major v2 rejected", input: { protocolVersion: "digital-employee.runner-protocol.v2" }, expect: { kind: "reject", code: "VERSION_UNSUPPORTED" } },
  { id: "reject-v0", family: "version_negotiation", description: "Version v0 rejected", input: { protocolVersion: "digital-employee.runner-protocol.v0" }, expect: { kind: "reject", code: "VERSION_UNSUPPORTED" } },
  { id: "reject-missing-version", family: "version_negotiation", description: "Missing version rejected", input: {}, expect: { kind: "reject", code: "VERSION_UNSUPPORTED" } },
  { id: "reject-invalid-format", family: "version_negotiation", description: "Non-standard format rejected", input: { protocolVersion: "runner.v1" }, expect: { kind: "reject", code: "VERSION_UNSUPPORTED" } },
  { id: "reject-unknown-security-field", family: "version_negotiation", description: "Unknown security field triggers fail-closed", input: { protocolVersion: "digital-employee.runner-protocol.v1", unknownSecurityField: "bypass-auth" }, expect: { kind: "reject", code: "UNKNOWN_FIELD_UNSAFE" } },
  { id: "reject-downgrade-v2-to-v1", family: "version_negotiation", description: "Downgrade from v2 to v1 rejected", input: { protocolVersion: "digital-employee.runner-protocol.v1", downgradeFrom: "digital-employee.runner-protocol.v2" }, expect: { kind: "reject", code: "DOWNGRADE_REJECTED" } },
]

const migrationVectors = [
  { id: "preview-to-v1-valid", family: "migration", description: "Preview to v1 migration supported", input: { fromVersion: "digital-employee.runner-protocol.preview", toVersion: "digital-employee.runner-protocol.v1" }, expect: { kind: "accept" } },
  { id: "preview-to-v1-with-payload", family: "migration", description: "Preview payload validates as v1", input: { fromVersion: "digital-employee.runner-protocol.preview", toVersion: "digital-employee.runner-protocol.v1", payload: goldenTask() }, expect: { kind: "accept" } },
  { id: "v1-to-v1-noop", family: "migration", description: "v1 to v1 identity migration", input: { fromVersion: "digital-employee.runner-protocol.v1", toVersion: "digital-employee.runner-protocol.v1" }, expect: { kind: "accept" } },
  { id: "reject-v2-to-v1", family: "migration", description: "v2 to v1 downgrade not supported", input: { fromVersion: "digital-employee.runner-protocol.v2", toVersion: "digital-employee.runner-protocol.v1" }, expect: { kind: "reject", code: "MIGRATION_UNSUPPORTED" } },
  { id: "reject-v1-to-v2", family: "migration", description: "v1 to v2 not yet supported", input: { fromVersion: "digital-employee.runner-protocol.v1", toVersion: "digital-employee.runner-protocol.v2" }, expect: { kind: "reject", code: "MIGRATION_UNSUPPORTED" } },
  { id: "reject-missing-versions", family: "migration", description: "Missing version fields rejected", input: { fromVersion: null, toVersion: null }, expect: { kind: "reject", code: "MIGRATION_INVALID" } },
]

// --- Write ---

function sha256Hex(content) {
  return createHash("sha256").update(content, "utf8").digest("hex")
}

function writeVectorFile(filename, family, vectors) {
  const content = JSON.stringify({ schemaVersion: "runner-protocol-vectors.v1", family, vectors }, null, 2) + "\n"
  writeFileSync(join(VECTORS_DIR, filename), content)
  return { file: filename, sha256: sha256Hex(content), vectorCount: vectors.length }
}

const FAMILIES = ["canonical_bytes", "task_envelope", "event_chain", "receipt_envelope", "execution_bundle", "usage_binding", "version_negotiation", "migration"]

const files = [
  writeVectorFile("canonical_bytes.json", "canonical_bytes", canonicalBytesVectors),
  writeVectorFile("task_envelope.json", "task_envelope", taskEnvelopeVectors),
  writeVectorFile("event_chain.json", "event_chain", eventChainVectors),
  writeVectorFile("receipt_envelope.json", "receipt_envelope", receiptEnvelopeVectors),
  writeVectorFile("execution_bundle.json", "execution_bundle", executionBundleVectors),
  writeVectorFile("usage_binding.json", "usage_binding", usageBindingVectors),
  writeVectorFile("version_negotiation.json", "version_negotiation", versionNegotiationVectors),
  writeVectorFile("migration.json", "migration", migrationVectors),
]

const manifest = { schemaVersion: "runner-protocol-vectors.v1", protocolVersion: RUNNER_PROTOCOL_VERSION, families: FAMILIES, files }
writeFileSync(join(VECTORS_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")

console.log("Generated runner-protocol-vectors:")
for (const f of files) console.log(`  ${f.file}: ${f.vectorCount} vectors`)
console.log("  manifest.json")
