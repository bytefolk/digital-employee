import assert from "node:assert/strict"
import test from "node:test"

import {
  RUNNER_TRANSPORT_VERSION,
  RUNNER_TRANSPORT_MAX_RETRIES,
  RUNNER_TRANSPORT_BASE_BACKOFF_MS,
  RUNNER_TRANSPORT_MAX_BACKOFF_MS,
  RunnerTransportError,
  FakeRunnerTransport,
  computeTransportBackoff,
} from "../../packages/core/index.js"
import type {
  ClaimRequest,
  HeartbeatRequest,
  SignedEnvelope,
} from "../../packages/core/index.js"

function makeEnvelope(overrides?: Partial<SignedEnvelope>): SignedEnvelope {
  return {
    protocolVersion: "digital-employee.runner-protocol.v1",
    keyId: "platform-key-1",
    algorithm: "Ed25519",
    payload: "eyJ0ZXN0IjoidHJ1ZSJ9",
    signature: "c2lnbmF0dXJl",
    ...overrides,
  }
}

function makeMeta() {
  return {
    deviceKeyId: "device:abc123",
    requestNonce: "nonce-001",
    requestedAt: new Date().toISOString(),
    runnerId: "runner-001",
  }
}

test("FakeRunnerTransport claim returns task envelope", async () => {
  const envelope = makeEnvelope()
  const transport = new FakeRunnerTransport({
    platformKeyId: "platform-key-1",
    produceTaskEnvelope: () => envelope,
    produceRenewal: () => envelope,
  })

  const request: ClaimRequest = {
    version: RUNNER_TRANSPORT_VERSION,
    meta: makeMeta(),
    taskId: "task-001",
    runId: "run-001",
    attempt: 1,
    fencingToken: 1,
  }

  const response = await transport.claim(request)
  assert.equal(response.version, RUNNER_TRANSPORT_VERSION)
  assert.deepEqual(response.taskEnvelope, envelope)
  assert.equal(response.platformKeyId, "platform-key-1")
})

test("FakeRunnerTransport heartbeat returns renewed envelope", async () => {
  const renewed = makeEnvelope({ payload: "cmVuZXdlZA" })
  const transport = new FakeRunnerTransport({
    platformKeyId: "platform-key-1",
    produceTaskEnvelope: () => makeEnvelope(),
    produceRenewal: () => renewed,
  })

  const request: HeartbeatRequest = {
    version: RUNNER_TRANSPORT_VERSION,
    meta: makeMeta(),
    leaseId: "lease-001",
    taskId: "task-001",
    currentFencingToken: 1,
    eventDigests: [],
  }

  const response = await transport.heartbeat(request)
  assert.equal(response.version, RUNNER_TRANSPORT_VERSION)
  assert.deepEqual(response.renewedEnvelope, renewed)
})

test("FakeRunnerTransport appendEvents accumulates events", async () => {
  const transport = new FakeRunnerTransport({
    platformKeyId: "pk",
    produceTaskEnvelope: () => makeEnvelope(),
    produceRenewal: () => makeEnvelope(),
  })

  const event = {
    protocolVersion: "digital-employee.runner-protocol.v1" as const,
    kind: "runner.event" as const,
    taskId: "task-001",
    runId: "run-001",
    attempt: 1,
    fencingToken: 1,
    leaseId: "lease-001",
    quoteId: "quote-001",
    runnerId: "runner-001",
    employeeId: "emp-001",
    packageDigest: "sha256:" + "a".repeat(64),
    sequence: 1,
    timestamp: "2026-08-07T00:00:00.000Z",
    type: "progress",
    data: { mediaType: "application/json", encoding: "base64url" as const, data: "e30" },
    previousDigest: "sha256:" + "0".repeat(64),
    digest: "sha256:" + "b".repeat(64),
  }

  const response = await transport.appendEvents({
    version: RUNNER_TRANSPORT_VERSION,
    meta: makeMeta(),
    leaseId: "lease-001",
    taskId: "task-001",
    events: [event],
  })

  assert.equal(response.accepted, 1)
  assert.equal(transport.submittedEvents.length, 1)
  assert.equal(response.lastAcceptedDigest, event.digest)
})

test("FakeRunnerTransport submitReceipt stores receipt", async () => {
  const transport = new FakeRunnerTransport({
    platformKeyId: "pk",
    produceTaskEnvelope: () => makeEnvelope(),
    produceRenewal: () => makeEnvelope(),
  })

  const receipt = makeEnvelope({ payload: "cmVjZWlwdA" })
  const response = await transport.submitReceipt({
    version: RUNNER_TRANSPORT_VERSION,
    meta: makeMeta(),
    leaseId: "lease-001",
    signedReceipt: receipt,
  })

  assert.equal(response.accepted, true)
  assert.deepEqual(transport.submittedReceipt, receipt)
})

test("FakeRunnerTransport enrollDevice succeeds", async () => {
  const transport = new FakeRunnerTransport({
    platformKeyId: "pk-1",
    produceTaskEnvelope: () => makeEnvelope(),
    produceRenewal: () => makeEnvelope(),
  })

  const response = await transport.enrollDevice({
    version: RUNNER_TRANSPORT_VERSION,
    enrollment: {
      version: "runner-device.v1",
      runnerId: "runner-001",
      sellerId: "seller-001",
      keyId: "device:abc",
      publicKeySpki: "MFkwEwYHKoZIzj...",
      enrolledAt: new Date().toISOString(),
    },
  })

  assert.equal(response.accepted, true)
  assert.equal(response.platformKeyId, "pk-1")
})

test("FakeRunnerTransport rotateKey returns ack with overlap window", async () => {
  const transport = new FakeRunnerTransport({
    platformKeyId: "pk",
    produceTaskEnvelope: () => makeEnvelope(),
    produceRenewal: () => makeEnvelope(),
  })

  const response = await transport.rotateKey({
    version: RUNNER_TRANSPORT_VERSION,
    meta: makeMeta(),
    rotation: {
      version: "runner-device.v1",
      runnerId: "runner-001",
      currentKeyId: "device:old",
      nextKeyId: "device:new",
      nextPublicKeySpki: "MFkw...",
      requestedAt: new Date().toISOString(),
    },
  })

  assert.equal(response.ack.currentKeyId, "device:old")
  assert.equal(response.ack.nextKeyId, "device:new")
  assert.ok(response.ack.overlapExpiresAt)
})

test("computeTransportBackoff retries transient errors", () => {
  const error = new RunnerTransportError("RUNNER_TRANSPORT_UNAVAILABLE")
  const { shouldRetry, delayMs } = computeTransportBackoff(error, 0)
  assert.equal(shouldRetry, true)
  assert.ok(delayMs >= 0)
  assert.ok(delayMs <= RUNNER_TRANSPORT_BASE_BACKOFF_MS * 2)
})

test("computeTransportBackoff stops after max retries", () => {
  const error = new RunnerTransportError("RUNNER_TRANSPORT_UNAVAILABLE")
  const { shouldRetry } = computeTransportBackoff(
    error,
    RUNNER_TRANSPORT_MAX_RETRIES,
  )
  assert.equal(shouldRetry, false)
})

test("computeTransportBackoff does not retry non-retryable errors", () => {
  const error = new RunnerTransportError("RUNNER_TRANSPORT_FORBIDDEN")
  const { shouldRetry } = computeTransportBackoff(error, 0)
  assert.equal(shouldRetry, false)
})

test("computeTransportBackoff respects retryAfterMs", () => {
  const error = new RunnerTransportError("RUNNER_TRANSPORT_RATE_LIMITED", undefined, {
    retryAfterMs: 5000,
  })
  const { shouldRetry, delayMs } = computeTransportBackoff(error, 0)
  assert.equal(shouldRetry, true)
  // Should use 5000 as base, so delay should be around 5000 ± 25%
  assert.ok(delayMs >= 3750)
  assert.ok(delayMs <= 6250)
})

test("computeTransportBackoff caps at max backoff", () => {
  const error = new RunnerTransportError("RUNNER_TRANSPORT_TIMEOUT")
  // At attempt 4 with base 500ms: 500 * 2^4 = 8000, still under cap
  // At attempt with very high retryAfter it should cap
  const highRetry = new RunnerTransportError("RUNNER_TRANSPORT_TIMEOUT", undefined, {
    retryAfterMs: 60_000,
  })
  const { delayMs } = computeTransportBackoff(highRetry, 2)
  assert.ok(delayMs <= RUNNER_TRANSPORT_MAX_BACKOFF_MS * 1.25)
})

test("RunnerTransportError marks retryable codes correctly", () => {
  const unavailable = new RunnerTransportError("RUNNER_TRANSPORT_UNAVAILABLE")
  assert.equal(unavailable.retryable, true)

  const timeout = new RunnerTransportError("RUNNER_TRANSPORT_TIMEOUT")
  assert.equal(timeout.retryable, true)

  const rateLimited = new RunnerTransportError("RUNNER_TRANSPORT_RATE_LIMITED")
  assert.equal(rateLimited.retryable, true)

  const forbidden = new RunnerTransportError("RUNNER_TRANSPORT_FORBIDDEN")
  assert.equal(forbidden.retryable, false)

  const unauthorized = new RunnerTransportError("RUNNER_TRANSPORT_UNAUTHORIZED")
  assert.equal(unauthorized.retryable, false)

  const conflict = new RunnerTransportError("RUNNER_TRANSPORT_CONFLICT")
  assert.equal(conflict.retryable, false)
})
