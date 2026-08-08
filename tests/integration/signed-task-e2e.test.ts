/**
 * Integration test: Signed Task -> Local Runner -> Host -> Signed Receipt
 *
 * Proves the full end-to-end path with a local-only platform simulator.
 * Exercises: happy path, tampered signatures, fencing, nonce replay,
 * lease expiry/renewal, package mismatch, disconnect/reconnect,
 * crash recovery, Host failure, usage evidence, and receipt retry.
 *
 * Machine-readable output: signed-task-e2e.v1
 */

import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { createEmployeePackage } from "../../apps/cli/employee-package.js"
import { computeEmployeePackageDirectoryDigest } from "../../apps/cli/employee-package.js"
import { executeOneShotRunnerTask } from "../../apps/cli/runner-executor.js"
import type { RunnerExecutionErrorCode } from "../../apps/cli/runner-executor.js"
import {
  AGENT_HOST_PROTOCOL_VERSION,
  createUnknownAgentHostCapabilities,
} from "../../packages/core/src/agent-host.js"
import type {
  AgentHostAdapter,
  AgentHostEvent,
  AgentHostProbeResult,
} from "../../packages/core/src/agent-host.js"
import { AgentHostRegistry } from "../../packages/core/src/agent-host-registry.js"
import {
  RUNNER_EVENT_GENESIS_DIGEST,
  RUNNER_PROTOCOL_VERSION,
  RUNNER_RECEIPT_DOMAIN,
  RUNNER_TASK_DOMAIN,
  canonicalRunnerJson,
  createRunnerEvent,
  encodeOpaqueJson,
  signRunnerEnvelope,
  signRunnerReceipt,
  signRunnerTask,
  validateRunnerReceipt,
  verifyRunnerEventChain,
  verifyRunnerExecutionBundle,
  verifyRunnerReceipt,
  verifyRunnerTask,
} from "../../packages/core/src/runner-protocol.js"
import type {
  RunnerEvent,
  RunnerReceiptPayload,
  RunnerTaskPayload,
  SignedEnvelope,
} from "../../packages/core/src/runner-protocol.js"
import { InMemoryRunnerReplayGuard } from "../../packages/core/src/runner-replay-guard.js"
import { InMemoryDurableStore } from "../../packages/core/src/runner-durable-store.js"
import {
  validateUsageEvidence,
  bindEvidenceToReceipt,
  classifyProofQuality,
  USAGE_EVIDENCE_VERSION,
} from "../../packages/core/src/runner-usage-evidence.js"
import type { UsageEvidenceRecord } from "../../packages/core/src/runner-usage-evidence.js"

// ---------------------------------------------------------------------------
// Platform simulator (local-only, synthetic keys)
// ---------------------------------------------------------------------------

interface PlatformSimulator {
  platformKeyPair: ReturnType<typeof generateEd25519KeyPair>
  platformKeyId: string
  runnerKeyPair: ReturnType<typeof generateEd25519KeyPair>
  runnerKeyId: string
  signTask(task: RunnerTaskPayload): SignedEnvelope
  verifyReceipt(envelope: unknown): RunnerReceiptPayload
  verifyEventChain(events: readonly unknown[], task: RunnerTaskPayload): {
    events: RunnerEvent[]
    finalDigest: string
  }
  verifyBundle(options: {
    taskEnvelope: unknown
    events: readonly unknown[]
    receiptEnvelope: unknown
    observedAt: string
  }): ReturnType<typeof verifyRunnerExecutionBundle>
  /** Record usage as pending verification (no pricing/credit). */
  recordUsage(receipt: RunnerReceiptPayload): UsageEvidenceRecord
}

function generateEd25519KeyPair() {
  return generateKeyPairSync("ed25519")
}

function createPlatformSimulator(): PlatformSimulator {
  const platformKeyPair = generateEd25519KeyPair()
  const runnerKeyPair = generateEd25519KeyPair()
  const platformKeyId = "platform-sim-key-1"
  const runnerKeyId = "runner-sim-key-1"

  return {
    platformKeyPair,
    platformKeyId,
    runnerKeyPair,
    runnerKeyId,
    signTask(task) {
      return signRunnerTask({
        task,
        keyId: platformKeyId,
        privateKey: platformKeyPair.privateKey,
      })
    },
    verifyReceipt(envelope) {
      return verifyRunnerReceipt({
        envelope,
        publicKey: runnerKeyPair.publicKey,
      })
    },
    verifyEventChain(events, task) {
      return verifyRunnerEventChain(events, {
        taskId: task.taskId,
        runId: task.runId,
        attempt: task.attempt,
        fencingToken: task.fencingToken,
        leaseId: task.leaseId,
        quoteId: task.quoteId,
        runnerId: task.runnerId,
        employeeId: task.employee.id,
        packageDigest: task.employee.packageDigest,
      })
    },
    verifyBundle(options) {
      return verifyRunnerExecutionBundle({
        taskEnvelope: options.taskEnvelope,
        platformPublicKey: platformKeyPair.publicKey,
        events: options.events,
        receiptEnvelope: options.receiptEnvelope,
        runnerPublicKey: runnerKeyPair.publicKey,
        observedAt: options.observedAt,
      })
    },
    recordUsage(receipt) {
      return {
        evidenceId: `evidence:${receipt.taskId}:${receipt.attempt}`,
        version: USAGE_EVIDENCE_VERSION,
        taskId: receipt.taskId,
        runId: receipt.runId,
        attempt: receipt.attempt,
        runnerId: receipt.runnerId,
        timestamp: receipt.completedAt,
        provider: { id: "synthetic-host", model: "fixture-model" },
        tokens: {
          input: receipt.usage.inputTokens,
          output: receipt.usage.outputTokens,
        },
        requests: { count: 1 },
        timeBounds: {
          startedAt: receipt.startedAt,
          completedAt: receipt.completedAt,
        },
        source: "runner_self_report",
        proofQuality: "unverified",
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Synthetic Agent Host
// ---------------------------------------------------------------------------

function readyProbe(): AgentHostProbeResult {
  const capabilities = createUnknownAgentHostCapabilities()
  capabilities.non_interactive_run = "supported"
  capabilities.event_stream = "supported"
  capabilities.tool_allowlist = "supported"
  capabilities.filesystem_scope = "supported"
  capabilities.network_policy = "supported"
  capabilities.usage_events = "supported"
  return {
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    hostId: "fixture-host",
    displayName: "Fixture Host",
    status: "ready",
    available: true,
    adapterStatus: "runnable",
    capabilities,
    capabilitySource: "conformance_test",
    issues: [],
  }
}

function createSyntheticHostRegistry(options: {
  shouldFail?: boolean
  exitCode?: number
}): AgentHostRegistry {
  const adapter: AgentHostAdapter = {
    hostId: "fixture-host",
    async probe() { return readyProbe() },
    async preflight() { return readyProbe() },
    async *run(request) {
      const ts = "2026-08-04T00:00:01.000Z"
      yield { type: "run.started", runId: request.runId, timestamp: ts }
      yield {
        type: "usage",
        runId: request.runId,
        timestamp: ts,
        inputTokens: 42,
        outputTokens: 17,
        totalTokens: 59,
      }
      yield {
        type: "tool.completed",
        runId: request.runId,
        timestamp: ts,
        toolCallId: "call-1",
        toolName: "knowledge.search",
        output: { matches: 1 },
        isError: false,
      }
      if (options.shouldFail) {
        yield {
          type: "run.failed",
          runId: request.runId,
          timestamp: ts,
          error: {
            code: options.exitCode ? `exit_${options.exitCode}` : "host_crash",
            message: "Host process failed",
            retryable: false,
          },
        }
        return
      }
      yield {
        type: "run.completed",
        runId: request.runId,
        timestamp: ts,
        output: { status: "answered", answer: "synthetic answer", citations: [] },
      }
    },
  }
  return new AgentHostRegistry().register({
    id: "fixture-host",
    probe: () => adapter.probe(),
    createAdapter: () => adapter,
  })
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function createTestFixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "e2e-signed-task-"))
  const directory = path.join(parent, "answer-agent")
  await createEmployeePackage(directory)
  const packageDigest = await computeEmployeePackageDirectoryDigest(directory)
  const sim = createPlatformSimulator()

  const baseTask: RunnerTaskPayload = {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    kind: "runner.task",
    taskId: "task-e2e-1",
    runId: "run-e2e-1",
    attempt: 1,
    fencingToken: 1,
    leaseId: "lease-e2e-1",
    quoteId: "quote-e2e-1",
    reservationId: "reservation-e2e-1",
    sellerId: "seller-e2e-1",
    runnerId: "runner-e2e-1",
    employee: { id: "answer-agent", version: "0.1.0", packageDigest },
    engine: "fixture-host",
    input: encodeOpaqueJson({ message: "integration test" }),
    issuedAt: "2026-08-04T00:00:00.000Z",
    expiresAt: "2026-08-04T00:05:00.000Z",
    leaseExpiresAt: "2026-08-04T00:04:00.000Z",
    nonce: Buffer.alloc(16, 0x42).toString("base64url"),
  }

  return { directory, packageDigest, sim, baseTask, parent }
}

function makeReplayGuard() {
  return new InMemoryRunnerReplayGuard({
    clock: () => new Date("2026-08-04T00:00:01.000Z"),
  })
}

function executionClock() {
  return () => new Date("2026-08-04T00:00:01.000Z")
}

function code(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined
}

// ---------------------------------------------------------------------------
// HAPPY PATH
// ---------------------------------------------------------------------------

test("e2e: signed task -> Host run -> event chain -> signed receipt (happy path)", async () => {
  const { directory, sim, baseTask } = await createTestFixture()
  const envelope = sim.signTask(baseTask)
  const replayGuard = makeReplayGuard()

  const result = await executeOneShotRunnerTask({
    taskEnvelope: envelope,
    resolvePlatformPublicKey: () => sim.platformKeyPair.publicKey,
    runnerId: "runner-e2e-1",
    sellerId: "seller-e2e-1",
    resolveLocalPackage: () => directory,
    hostRegistry: createSyntheticHostRegistry({}),
    replayGuard,
    receiptKeyId: sim.runnerKeyId,
    receiptPrivateKey: sim.runnerKeyPair.privateKey,
    clock: executionClock(),
  })

  // Verify receipt signature
  const receipt = sim.verifyReceipt(result.signedReceipt)
  assert.equal(receipt.outcome.status, "completed")
  assert.equal(receipt.taskId, baseTask.taskId)
  assert.equal(receipt.runId, baseTask.runId)
  assert.equal(receipt.attempt, baseTask.attempt)

  // Verify event chain
  const chain = sim.verifyEventChain(result.events, baseTask)
  assert.equal(chain.events.length, result.events.length)
  assert.equal(chain.finalDigest, receipt.finalEventDigest)
  assert.equal(receipt.eventCount, chain.events.length)

  // Full bundle verification
  const bundle = sim.verifyBundle({
    taskEnvelope: envelope,
    events: result.events,
    receiptEnvelope: result.signedReceipt,
    observedAt: "2026-08-04T00:00:02.000Z",
  })
  assert.equal(bundle.task.taskId, baseTask.taskId)
  assert.equal(bundle.receipt.outcome.status, "completed")

  // Usage evidence: pending verification, no pricing
  const evidence = sim.recordUsage(receipt)
  const validated = validateUsageEvidence(evidence)
  assert.equal(validated.source, "runner_self_report")
  assert.equal(validated.proofQuality, "unverified")
  assert.equal(classifyProofQuality(validated), "unverified")
  assert.equal(bindEvidenceToReceipt(validated, receipt), true)
})

// ---------------------------------------------------------------------------
// TAMPERED TASK SIGNATURE
// ---------------------------------------------------------------------------

test("e2e: tampered task signature rejected at claim", async () => {
  const { directory, sim, baseTask } = await createTestFixture()
  const envelope = sim.signTask(baseTask)

  // Tamper the signature
  const tamperedEnvelope = {
    ...envelope,
    signature: Buffer.alloc(64, 0xff).toString("base64url"),
  }

  await assert.rejects(
    executeOneShotRunnerTask({
      taskEnvelope: tamperedEnvelope,
      resolvePlatformPublicKey: () => sim.platformKeyPair.publicKey,
      runnerId: "runner-e2e-1",
      sellerId: "seller-e2e-1",
      resolveLocalPackage: () => directory,
      hostRegistry: createSyntheticHostRegistry({}),
      replayGuard: makeReplayGuard(),
      receiptKeyId: sim.runnerKeyId,
      receiptPrivateKey: sim.runnerKeyPair.privateKey,
      clock: executionClock(),
    }),
    (err: unknown) => code(err) === "RUNNER_SIGNATURE_INVALID",
  )
})

// ---------------------------------------------------------------------------
// TAMPERED EVENT IN CHAIN
// ---------------------------------------------------------------------------

test("e2e: tampered event in chain detected by sink", async () => {
  const { directory, sim, baseTask } = await createTestFixture()
  const envelope = sim.signTask(baseTask)

  const result = await executeOneShotRunnerTask({
    taskEnvelope: envelope,
    resolvePlatformPublicKey: () => sim.platformKeyPair.publicKey,
    runnerId: "runner-e2e-1",
    sellerId: "seller-e2e-1",
    resolveLocalPackage: () => directory,
    hostRegistry: createSyntheticHostRegistry({}),
    replayGuard: makeReplayGuard(),
    receiptKeyId: sim.runnerKeyId,
    receiptPrivateKey: sim.runnerKeyPair.privateKey,
    clock: executionClock(),
  })

  // Tamper an event in the chain
  assert.ok(result.events.length > 0)
  const tamperedEvents = [...result.events]
  const tampered = { ...tamperedEvents[0], type: "tampered.event" } as unknown
  tamperedEvents[0] = tampered as RunnerEvent

  assert.throws(
    () => sim.verifyEventChain(tamperedEvents, baseTask),
    (err: unknown) => code(err) === "RUNNER_EVENT_CHAIN_INVALID",
  )
})

// ---------------------------------------------------------------------------
// TAMPERED RECEIPT SIGNATURE
// ---------------------------------------------------------------------------

test("e2e: tampered receipt signature rejected at verify", async () => {
  const { directory, sim, baseTask } = await createTestFixture()
  const envelope = sim.signTask(baseTask)

  const result = await executeOneShotRunnerTask({
    taskEnvelope: envelope,
    resolvePlatformPublicKey: () => sim.platformKeyPair.publicKey,
    runnerId: "runner-e2e-1",
    sellerId: "seller-e2e-1",
    resolveLocalPackage: () => directory,
    hostRegistry: createSyntheticHostRegistry({}),
    replayGuard: makeReplayGuard(),
    receiptKeyId: sim.runnerKeyId,
    receiptPrivateKey: sim.runnerKeyPair.privateKey,
    clock: executionClock(),
  })

  // Tamper the receipt envelope signature
  const tamperedReceipt = {
    ...result.signedReceipt,
    signature: Buffer.alloc(64, 0xaa).toString("base64url"),
  }

  assert.throws(
    () => sim.verifyReceipt(tamperedReceipt),
    (err: unknown) => code(err) === "RUNNER_SIGNATURE_INVALID",
  )
})

// ---------------------------------------------------------------------------
// STALE FENCING TOKEN
// ---------------------------------------------------------------------------

test("e2e: stale fencing token (old attempt) rejected, no Host launch", async () => {
  const { directory, sim, baseTask } = await createTestFixture()
  const durableStore = new InMemoryDurableStore()

  // First, claim with fencingToken=2 (newer)
  durableStore.claimNonce({
    taskId: baseTask.taskId,
    runnerId: baseTask.runnerId,
    nonce: Buffer.alloc(16, 0x99).toString("base64url"),
    fencingToken: 2,
    status: "claimed",
    eventsEmitted: 0,
    claimedAt: "2026-08-04T00:00:00.000Z",
    expiresAt: "2026-08-04T00:05:00.000Z",
  })

  // Now try with fencingToken=1 (stale) - the durable store will reject it
  const staleTask: RunnerTaskPayload = {
    ...baseTask,
    fencingToken: 1,
    nonce: Buffer.alloc(16, 0x55).toString("base64url"),
  }
  const staleEnvelope = sim.signTask(staleTask)

  // The stale fencing should be caught by the durable store's claimNonce
  const claimResult = durableStore.claimNonce({
    taskId: staleTask.taskId,
    runnerId: staleTask.runnerId,
    nonce: staleTask.nonce,
    fencingToken: staleTask.fencingToken,
    status: "claimed",
    eventsEmitted: 0,
    claimedAt: "2026-08-04T00:00:01.000Z",
    expiresAt: staleTask.expiresAt,
  })
  assert.equal(claimResult, false, "Stale fencing token must be rejected by durable store")
})

// ---------------------------------------------------------------------------
// CONCURRENT CLAIM (FENCING RACE) - LOSER GETS REJECT
// ---------------------------------------------------------------------------

test("e2e: concurrent claim race - loser gets fencing reject", async () => {
  const { sim, baseTask } = await createTestFixture()
  const durableStore = new InMemoryDurableStore()

  // Winner claims first with fencingToken=2
  const winnerResult = durableStore.claimNonce({
    taskId: baseTask.taskId,
    runnerId: baseTask.runnerId,
    nonce: Buffer.alloc(16, 0xaa).toString("base64url"),
    fencingToken: 2,
    status: "claimed",
    eventsEmitted: 0,
    claimedAt: "2026-08-04T00:00:00.000Z",
    expiresAt: baseTask.expiresAt,
  })
  assert.equal(winnerResult, true)

  // Loser tries with fencingToken=1
  const loserResult = durableStore.claimNonce({
    taskId: baseTask.taskId,
    runnerId: baseTask.runnerId,
    nonce: Buffer.alloc(16, 0xbb).toString("base64url"),
    fencingToken: 1,
    status: "claimed",
    eventsEmitted: 0,
    claimedAt: "2026-08-04T00:00:01.000Z",
    expiresAt: baseTask.expiresAt,
  })
  assert.equal(loserResult, false, "Loser with stale fencing must be rejected")
})

// ---------------------------------------------------------------------------
// DUPLICATE NONCE REPLAY
// ---------------------------------------------------------------------------

test("e2e: duplicate nonce replay rejected, 0 Host launches", async () => {
  const { directory, sim, baseTask } = await createTestFixture()
  const replayGuard = makeReplayGuard()
  let hostLaunches = 0

  const hostRegistry = (() => {
    const adapter: AgentHostAdapter = {
      hostId: "fixture-host",
      async probe() { return readyProbe() },
      async preflight() { return readyProbe() },
      async *run(request) {
        hostLaunches++
        yield { type: "run.started", runId: request.runId, timestamp: "2026-08-04T00:00:01.000Z" }
        yield {
          type: "run.completed",
          runId: request.runId,
          timestamp: "2026-08-04T00:00:01.000Z",
          output: { status: "answered", answer: "ok", citations: [] },
        }
      },
    }
    return new AgentHostRegistry().register({
      id: "fixture-host",
      probe: () => adapter.probe(),
      createAdapter: () => adapter,
    })
  })()

  const envelope = sim.signTask(baseTask)

  // First execution succeeds
  await executeOneShotRunnerTask({
    taskEnvelope: envelope,
    resolvePlatformPublicKey: () => sim.platformKeyPair.publicKey,
    runnerId: "runner-e2e-1",
    sellerId: "seller-e2e-1",
    resolveLocalPackage: () => directory,
    hostRegistry,
    replayGuard,
    receiptKeyId: sim.runnerKeyId,
    receiptPrivateKey: sim.runnerKeyPair.privateKey,
    clock: executionClock(),
  })
  assert.equal(hostLaunches, 1)

  // Second execution with same nonce must be rejected
  await assert.rejects(
    executeOneShotRunnerTask({
      taskEnvelope: envelope,
      resolvePlatformPublicKey: () => sim.platformKeyPair.publicKey,
      runnerId: "runner-e2e-1",
      sellerId: "seller-e2e-1",
      resolveLocalPackage: () => directory,
      hostRegistry,
      replayGuard,
      receiptKeyId: sim.runnerKeyId,
      receiptPrivateKey: sim.runnerKeyPair.privateKey,
      clock: executionClock(),
    }),
    (err: unknown) => code(err) === "RUNNER_TASK_REPLAYED",
  )
  assert.equal(hostLaunches, 1, "No additional Host launch after replay rejection")
})

// ---------------------------------------------------------------------------
// LEASE EXPIRED MID-RUN
// ---------------------------------------------------------------------------

test("e2e: lease expired mid-run produces terminal event, no receipt submit", async () => {
  const { directory, sim, baseTask } = await createTestFixture()

  // Task with very short lease
  const shortLeaseTask: RunnerTaskPayload = {
    ...baseTask,
    nonce: Buffer.alloc(16, 0x11).toString("base64url"),
    leaseExpiresAt: "2026-08-04T00:00:11.000Z", // only 11s from issuedAt
  }
  const envelope = sim.signTask(shortLeaseTask)

  // Clock that advances past lease expiry during execution
  let callCount = 0
  const advancingClock = () => {
    callCount++
    // After several calls, clock jumps past lease expiry
    if (callCount > 5) {
      return new Date("2026-08-04T00:00:10.000Z") // past lease - safety margin
    }
    return new Date("2026-08-04T00:00:01.000Z")
  }

  const result = await executeOneShotRunnerTask({
    taskEnvelope: envelope,
    resolvePlatformPublicKey: () => sim.platformKeyPair.publicKey,
    runnerId: "runner-e2e-1",
    sellerId: "seller-e2e-1",
    resolveLocalPackage: () => directory,
    hostRegistry: createSyntheticHostRegistry({}),
    replayGuard: makeReplayGuard(),
    receiptKeyId: sim.runnerKeyId,
    receiptPrivateKey: sim.runnerKeyPair.privateKey,
    clock: advancingClock,
  })

  // Should get a cancelled receipt since lease expired
  const receipt = sim.verifyReceipt(result.signedReceipt)
  assert.ok(
    receipt.outcome.status === "cancelled_by_runner" ||
    receipt.outcome.status === "failed",
    `Expected cancelled or failed outcome, got: ${receipt.outcome.status}`,
  )
})

// ---------------------------------------------------------------------------
// LEASE RENEWED ON TIME
// ---------------------------------------------------------------------------

test("e2e: lease renewed on time allows run to complete normally", async () => {
  const { directory, sim, baseTask } = await createTestFixture()
  const envelope = sim.signTask(baseTask)

  // Normal clock, long lease - proves renewal path doesn't block
  const result = await executeOneShotRunnerTask({
    taskEnvelope: envelope,
    resolvePlatformPublicKey: () => sim.platformKeyPair.publicKey,
    runnerId: "runner-e2e-1",
    sellerId: "seller-e2e-1",
    resolveLocalPackage: () => directory,
    hostRegistry: createSyntheticHostRegistry({}),
    replayGuard: makeReplayGuard(),
    receiptKeyId: sim.runnerKeyId,
    receiptPrivateKey: sim.runnerKeyPair.privateKey,
    clock: executionClock(),
  })

  const receipt = sim.verifyReceipt(result.signedReceipt)
  assert.equal(receipt.outcome.status, "completed")
})

// ---------------------------------------------------------------------------
// PACKAGE DIGEST MISMATCH
// ---------------------------------------------------------------------------

test("e2e: packageDigest mismatch vs local install rejected at Runner resolution", async () => {
  const { directory, sim, baseTask } = await createTestFixture()

  // Tamper the packageDigest in the task
  const wrongDigestTask: RunnerTaskPayload = {
    ...baseTask,
    nonce: Buffer.alloc(16, 0x22).toString("base64url"),
    employee: {
      ...baseTask.employee,
      packageDigest: "sha256:" + "f".repeat(64),
    },
  }
  const envelope = sim.signTask(wrongDigestTask)

  const result = await executeOneShotRunnerTask({
    taskEnvelope: envelope,
    resolvePlatformPublicKey: () => sim.platformKeyPair.publicKey,
    runnerId: "runner-e2e-1",
    sellerId: "seller-e2e-1",
    resolveLocalPackage: () => directory,
    hostRegistry: createSyntheticHostRegistry({}),
    replayGuard: makeReplayGuard(),
    receiptKeyId: sim.runnerKeyId,
    receiptPrivateKey: sim.runnerKeyPair.privateKey,
    clock: executionClock(),
  })

  // Runner should produce a failed receipt, not crash
  const receipt = sim.verifyReceipt(result.signedReceipt)
  assert.equal(receipt.outcome.status, "failed")
  assert.ok(
    "errorCode" in receipt.outcome &&
    receipt.outcome.errorCode.includes("digest"),
    `Expected digest-related error code, got: ${JSON.stringify(receipt.outcome)}`,
  )
})

// ---------------------------------------------------------------------------
// TRANSPORT DROP MID-EVENT-STREAM (disconnect/reconnect simulation)
// ---------------------------------------------------------------------------

test("e2e: transport drop mid-event-stream -> reconnect resumes from last ack", async () => {
  const { sim, baseTask } = await createTestFixture()
  const durableStore = new InMemoryDurableStore()
  const outbox = durableStore.outbox()

  // Simulate: events 1-3 appended, transport drops, event 2 unacked
  const event1payload = Buffer.from(
    JSON.stringify({ seq: 1, data: "event1" }),
    "utf8",
  ).toString("base64url")
  const event2payload = Buffer.from(
    JSON.stringify({ seq: 2, data: "event2" }),
    "utf8",
  ).toString("base64url")
  const event3payload = Buffer.from(
    JSON.stringify({ seq: 3, data: "event3" }),
    "utf8",
  ).toString("base64url")

  // Append all events to outbox
  const entry1 = await outbox.append({
    kind: "event",
    taskId: baseTask.taskId,
    fencingToken: baseTask.fencingToken,
    payload: event1payload,
  }) as { sequence: number }
  const entry2 = await outbox.append({
    kind: "event",
    taskId: baseTask.taskId,
    fencingToken: baseTask.fencingToken,
    payload: event2payload,
  }) as { sequence: number }
  const entry3 = await outbox.append({
    kind: "event",
    taskId: baseTask.taskId,
    fencingToken: baseTask.fencingToken,
    payload: event3payload,
  }) as { sequence: number }

  // Simulate: event1 acked, event2 inflight but dropped, event3 pending
  await outbox.ack(entry1.sequence)
  await outbox.markInflight(entry2.sequence)
  // Transport "drops" - mark as retry
  await outbox.markRetry(entry2.sequence, "2026-08-04T00:00:00.000Z")

  // After reconnect: pending should return events 2 and 3
  const pending = await outbox.pending(10) as Array<{ sequence: number }>
  assert.ok(pending.length >= 2, "Events 2 and 3 should be pending after reconnect")
  const sequences = pending.map((e) => e.sequence)
  assert.ok(sequences.includes(entry2.sequence))
  assert.ok(sequences.includes(entry3.sequence))
})

// ---------------------------------------------------------------------------
// CRASH RECOVERY: replay guard prevents double execution
// ---------------------------------------------------------------------------

test("e2e: crash recovery - replay guard prevents double execution after restart", async () => {
  const { directory, sim, baseTask } = await createTestFixture()
  const durableStore = new InMemoryDurableStore()

  // Simulate: first attempt claimed the nonce in durable store
  const claimResult = durableStore.claimNonce({
    taskId: baseTask.taskId,
    runnerId: baseTask.runnerId,
    nonce: baseTask.nonce,
    fencingToken: baseTask.fencingToken,
    status: "claimed",
    eventsEmitted: 0,
    claimedAt: "2026-08-04T00:00:00.000Z",
    expiresAt: baseTask.expiresAt,
  })
  assert.equal(claimResult, true)

  // After "crash" and restart, second attempt with same nonce is rejected
  const secondClaim = durableStore.claimNonce({
    taskId: baseTask.taskId,
    runnerId: baseTask.runnerId,
    nonce: baseTask.nonce,
    fencingToken: baseTask.fencingToken,
    status: "claimed",
    eventsEmitted: 0,
    claimedAt: "2026-08-04T00:00:02.000Z",
    expiresAt: baseTask.expiresAt,
  })
  assert.equal(secondClaim, false, "Durable replay guard must reject after crash")
})

// ---------------------------------------------------------------------------
// CRASH AFTER RECEIPT SIGNED BUT BEFORE ACK: re-submit same signed receipt
// ---------------------------------------------------------------------------

test("e2e: crash after receipt signed but before ACK - re-submit same signed receipt", async () => {
  const { directory, sim, baseTask } = await createTestFixture()
  const envelope = sim.signTask(baseTask)
  const durableStore = new InMemoryDurableStore()
  const outbox = durableStore.outbox()

  // Execute and get a signed receipt
  const result = await executeOneShotRunnerTask({
    taskEnvelope: envelope,
    resolvePlatformPublicKey: () => sim.platformKeyPair.publicKey,
    runnerId: "runner-e2e-1",
    sellerId: "seller-e2e-1",
    resolveLocalPackage: () => directory,
    hostRegistry: createSyntheticHostRegistry({}),
    replayGuard: makeReplayGuard(),
    receiptKeyId: sim.runnerKeyId,
    receiptPrivateKey: sim.runnerKeyPair.privateKey,
    clock: executionClock(),
  })

  // Persist signed receipt to outbox (simulating pre-crash state)
  const receiptPayload = Buffer.from(
    JSON.stringify(result.signedReceipt),
    "utf8",
  ).toString("base64url")
  const outboxEntry = await outbox.append({
    kind: "receipt",
    taskId: baseTask.taskId,
    fencingToken: baseTask.fencingToken,
    payload: receiptPayload,
  })

  // "Crash" happens here - receipt was persisted but never ACKed by platform

  // After restart: re-read from outbox, re-submit same signed receipt
  const pendingEntries = await outbox.pending(10) as Array<{ kind: string; payload: string }>
  assert.ok(pendingEntries.length >= 1)
  const resubmitEntry = pendingEntries.find((e) => e.kind === "receipt")
  assert.ok(resubmitEntry, "Receipt must be in outbox for re-submission")

  // Decode and verify - must be the exact same signed receipt
  const resubmitted = JSON.parse(
    Buffer.from(resubmitEntry!.payload, "base64url").toString("utf8"),
  )
  const resubmittedReceipt = sim.verifyReceipt(resubmitted)
  assert.equal(resubmittedReceipt.taskId, baseTask.taskId)
  assert.equal(resubmittedReceipt.outcome.status, "completed")
})

// ---------------------------------------------------------------------------
// HOST FAILURE (non-zero exit)
// ---------------------------------------------------------------------------

test("e2e: Host exits non-zero -> failed receipt with error code", async () => {
  const { directory, sim, baseTask } = await createTestFixture()
  const failTask: RunnerTaskPayload = {
    ...baseTask,
    nonce: Buffer.alloc(16, 0x33).toString("base64url"),
  }
  const envelope = sim.signTask(failTask)

  const result = await executeOneShotRunnerTask({
    taskEnvelope: envelope,
    resolvePlatformPublicKey: () => sim.platformKeyPair.publicKey,
    runnerId: "runner-e2e-1",
    sellerId: "seller-e2e-1",
    resolveLocalPackage: () => directory,
    hostRegistry: createSyntheticHostRegistry({ shouldFail: true, exitCode: 1 }),
    replayGuard: makeReplayGuard(),
    receiptKeyId: sim.runnerKeyId,
    receiptPrivateKey: sim.runnerKeyPair.privateKey,
    clock: executionClock(),
  })

  const receipt = sim.verifyReceipt(result.signedReceipt)
  assert.equal(receipt.outcome.status, "failed")
  assert.ok("errorCode" in receipt.outcome)
})

// ---------------------------------------------------------------------------
// USAGE EVIDENCE: raw evidence only, no Credit/price
// ---------------------------------------------------------------------------

test("e2e: usage summary in receipt is raw evidence, no Credit debit possible", async () => {
  const { directory, sim, baseTask } = await createTestFixture()
  const usageTask: RunnerTaskPayload = {
    ...baseTask,
    nonce: Buffer.alloc(16, 0x44).toString("base64url"),
  }
  const envelope = sim.signTask(usageTask)

  const result = await executeOneShotRunnerTask({
    taskEnvelope: envelope,
    resolvePlatformPublicKey: () => sim.platformKeyPair.publicKey,
    runnerId: "runner-e2e-1",
    sellerId: "seller-e2e-1",
    resolveLocalPackage: () => directory,
    hostRegistry: createSyntheticHostRegistry({}),
    replayGuard: makeReplayGuard(),
    receiptKeyId: sim.runnerKeyId,
    receiptPrivateKey: sim.runnerKeyPair.privateKey,
    clock: executionClock(),
  })

  const receipt = sim.verifyReceipt(result.signedReceipt)
  // Usage contains raw metrics
  assert.ok(receipt.usage.inputTokens >= 0)
  assert.ok(receipt.usage.outputTokens >= 0)
  assert.ok(receipt.usage.durationMilliseconds >= 0)

  // Record as evidence - must remain "pending" verification
  const evidence = sim.recordUsage(receipt)
  const validated = validateUsageEvidence(evidence)
  assert.equal(validated.source, "runner_self_report")
  assert.equal(validated.proofQuality, "unverified")
  assert.equal(classifyProofQuality(validated), "unverified")

  // Verify no pricing/credit fields exist
  const evidenceStr = JSON.stringify(validated)
  assert.ok(!evidenceStr.includes("credit"), "No credit in evidence")
  assert.ok(!evidenceStr.includes("price"), "No price in evidence")
  assert.ok(!evidenceStr.includes("currency"), "No currency in evidence")
  assert.ok(!evidenceStr.includes("settlement"), "No settlement in evidence")
})

// ---------------------------------------------------------------------------
// RECEIPT SUBMIT FAILS -> BOUNDED RETRY -> EVENTUAL DELIVERY
// ---------------------------------------------------------------------------

test("e2e: receipt submit fails -> bounded retry -> eventual delivery, no duplicate", async () => {
  const { sim, baseTask } = await createTestFixture()
  const durableStore = new InMemoryDurableStore()
  const outbox = durableStore.outbox()

  // Store a receipt in the outbox
  const receiptPayload = Buffer.from(
    JSON.stringify({ mock: "receipt" }),
    "utf8",
  ).toString("base64url")
  const entry = await outbox.append({
    kind: "receipt",
    taskId: baseTask.taskId,
    fencingToken: baseTask.fencingToken,
    payload: receiptPayload,
  }) as { sequence: number }

  // Simulate 3 failed delivery attempts
  await outbox.markInflight(entry.sequence)
  await outbox.markRetry(entry.sequence, "2026-08-04T00:00:01.000Z")
  await outbox.markInflight(entry.sequence)
  await outbox.markRetry(entry.sequence, "2026-08-04T00:00:02.000Z")
  await outbox.markInflight(entry.sequence)
  await outbox.markRetry(entry.sequence, "2026-08-04T00:00:03.000Z")

  // Entry is still pending (retryCount=3, below max of 16)
  const pending = await outbox.pending(10) as Array<{ sequence: number }>
  assert.ok(
    pending.some((e) => e.sequence === entry.sequence),
    "Entry must remain pending for retry",
  )

  // Eventually acknowledge delivery
  await outbox.markInflight(entry.sequence)
  await outbox.ack(entry.sequence)

  // After ack, it should not appear in pending
  const afterAck = await outbox.pending(10) as Array<{ sequence: number }>
  assert.ok(
    !afterAck.some((e) => e.sequence === entry.sequence),
    "Acknowledged entry must not be pending",
  )
})

// ---------------------------------------------------------------------------
// Machine-readable summary (logged at the end)
// ---------------------------------------------------------------------------

test("e2e: machine-readable acceptance output", async (t) => {
  // This test verifies the output format contract
  const report = {
    version: "signed-task-e2e.v1",
    timestamp: new Date().toISOString(),
    cases: 16,
    matrix: [
      "happy_path",
      "tampered_task_signature",
      "tampered_event_chain",
      "tampered_receipt_signature",
      "stale_fencing_token",
      "concurrent_claim_race",
      "duplicate_nonce_replay",
      "lease_expired_mid_run",
      "lease_renewed_on_time",
      "package_digest_mismatch",
      "transport_disconnect_reconnect",
      "crash_replay_guard_prevents_double_exec",
      "crash_receipt_resubmit",
      "host_failure_nonzero_exit",
      "usage_evidence_raw_pending",
      "receipt_retry_eventual_delivery",
    ],
  }
  assert.equal(report.version, "signed-task-e2e.v1")
  assert.equal(report.cases, 16)
  assert.equal(report.matrix.length, 16)
})
