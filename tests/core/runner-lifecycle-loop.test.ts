/**
 * Runner loop integration tests: claim -> lease -> execute -> heartbeat ->
 * events -> receipt, driven through the real RunnerStart loop with the real
 * one-shot executor and a synthetic Agent Host.
 *
 * Machine-readable output: runner-loop-e2e.v1
 */

import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  computeEmployeePackageDirectoryDigest,
  createEmployeePackage,
} from "../../apps/cli/employee-package.js"
import { executeOneShotRunnerTask } from "../../apps/cli/runner-executor.js"
import { AgentHostRegistry } from "../../packages/core/src/agent-host-registry.js"
import {
  AGENT_HOST_PROTOCOL_VERSION,
  createUnknownAgentHostCapabilities,
} from "../../packages/core/src/agent-host.js"
import type {
  AgentHostAdapter,
  AgentHostProbeResult,
} from "../../packages/core/src/agent-host.js"
import { InMemoryDurableStore } from "../../packages/core/src/runner-durable-store.js"
import type { RunnerDurableStorePort } from "../../packages/core/src/runner-durable-store.js"
import { runnerStart } from "../../packages/core/src/runner-lifecycle.js"
import type { RunnerStartOptions } from "../../packages/core/src/runner-lifecycle.js"
import { RUNNER_TRANSPORT_VERSION, FakeRunnerTransport } from "../../packages/core/src/runner-transport.js"
import type {
  ClaimRequest,
  HeartbeatRequest,
  NextTaskRequest,
} from "../../packages/core/src/runner-transport.js"
import {
  RUNNER_PROTOCOL_VERSION,
  encodeOpaqueJson,
  signRunnerReceipt,
  signRunnerTask,
  verifyRunnerEventChain,
  verifyRunnerReceipt,
} from "../../packages/core/src/runner-protocol.js"
import type {
  RunnerEvent,
  RunnerReceiptPayload,
  RunnerTaskPayload,
  SignedEnvelope,
} from "../../packages/core/src/runner-protocol.js"
import { FileDeviceKeyStore } from "../../packages/core/src/runner-file-device-key-store.js"
import type { DeviceKeyRecord } from "../../packages/core/src/runner-device.js"
import type { KeyObject } from "node:crypto"

// ---------------------------------------------------------------------------
// Platform simulator (local-only, synthetic keys)
// ---------------------------------------------------------------------------

function generateEd25519KeyPair() {
  return generateKeyPairSync("ed25519")
}

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
}

function createPlatformSimulator(): PlatformSimulator {
  const platformKeyPair = generateEd25519KeyPair()
  const runnerKeyPair = generateEd25519KeyPair()
  const platformKeyId = "platform-loop-key-1"
  const runnerKeyId = "runner-loop-key-1"
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

function createSyntheticHostRegistry(options: { slowMs?: number } = {}) {
  const adapter: AgentHostAdapter = {
    hostId: "fixture-host",
    async probe() {
      return readyProbe()
    },
    async preflight() {
      return readyProbe()
    },
    async *run(request) {
      const ts = () => new Date().toISOString()
      yield { type: "run.started", runId: request.runId, timestamp: ts() }
      yield {
        type: "usage",
        runId: request.runId,
        timestamp: ts(),
        inputTokens: 42,
        outputTokens: 17,
        totalTokens: 59,
      }
      yield {
        type: "tool.completed",
        runId: request.runId,
        timestamp: ts(),
        toolCallId: "call-1",
        toolName: "knowledge.search",
        output: { matches: 1 },
        isError: false,
      }
      if (options.slowMs) {
        await new Promise((resolve) => setTimeout(resolve, options.slowMs))
      }
      yield {
        type: "run.completed",
        runId: request.runId,
        timestamp: ts(),
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

async function createPackageFixture(t: test.TestContext) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "runner-loop-e2e-"))
  t.after(async () => {
    await rm(parent, { recursive: true, force: true })
  })
  const directory = path.join(parent, "answer-agent")
  await createEmployeePackage(directory)
  const packageDigest = await computeEmployeePackageDirectoryDigest(directory)
  return { directory, packageDigest }
}

function makeTask(packageDigest: string, overrides?: Partial<RunnerTaskPayload>): RunnerTaskPayload {
  const now = Date.now()
  return {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    kind: "runner.task",
    taskId: "task-loop-1",
    runId: "run-loop-1",
    attempt: 1,
    fencingToken: 1,
    leaseId: "lease-loop-1",
    quoteId: "quote-loop-1",
    reservationId: "reservation-loop-1",
    sellerId: "seller-loop-1",
    runnerId: "runner-loop-001",
    employee: { id: "answer-agent", version: "0.1.0", packageDigest },
    engine: "fixture-host",
    input: encodeOpaqueJson({ message: "runner loop test" }),
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 10 * 60_000).toISOString(),
    leaseExpiresAt: new Date(now + 5 * 60_000).toISOString(),
    nonce: Buffer.alloc(16, 0x42).toString("base64url"),
    ...overrides,
  }
}

function coordinates(task: RunnerTaskPayload) {
  return {
    taskId: task.taskId,
    runId: task.runId,
    attempt: task.attempt,
    fencingToken: task.fencingToken,
  }
}

function fakeDeviceKeyStore(activeKey: DeviceKeyRecord | null = {
  keyId: "device:loop-test",
  status: "active",
  activeSince: "2026-08-04T00:00:00.000Z",
}): {
  loadActiveKey(): Promise<DeviceKeyRecord | null>
  loadKey(): Promise<DeviceKeyRecord | null>
  loadHistory(): Promise<DeviceKeyRecord[]>
  saveKey(): Promise<void>
  loadPrivateKey(): Promise<KeyObject | null>
  saveKeyPair(): Promise<void>
  deletePrivateKey(): Promise<void>
} {
  return {
    async loadActiveKey() {
      return activeKey ? { ...activeKey } : null
    },
    async loadKey() {
      return activeKey ? { ...activeKey } : null
    },
    async loadHistory() {
      return activeKey ? [{ ...activeKey }] : []
    },
    async saveKey() {},
    async loadPrivateKey() {
      return null
    },
    async saveKeyPair() {},
    async deletePrivateKey() {},
  }
}

function makeStartOptions(
  overrides: Partial<RunnerStartOptions> & {
    durableStore: RunnerDurableStorePort
    transport: FakeRunnerTransport
    packageDigest: string
    directory: string
    sim: PlatformSimulator
  },
): RunnerStartOptions {
  return {
    config: {
      version: "runner-lifecycle.v1",
      runnerId: "runner-loop-001",
      sellerId: "seller-loop-1",
      platformEndpoint: "https://platform.example.com",
      createdAt: "2026-08-04T00:00:00.000Z",
    },
    deviceKeyStore: fakeDeviceKeyStore(),
    resolvePlatformPublicKey: () => overrides.sim.platformKeyPair.publicKey,
    resolveLocalPackage: () => overrides.directory,
    hostRegistry: createSyntheticHostRegistry(),
    receiptKeyId: overrides.sim.runnerKeyId,
    receiptPrivateKey: overrides.sim.runnerKeyPair.privateKey,
    executeTask: (execution) => executeOneShotRunnerTask(execution),
    once: true,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Happy path: claim -> execute -> events -> receipt (once mode)
// ---------------------------------------------------------------------------

test("loop executes a signed task end-to-end and submits the receipt (once mode)", async (t) => {
  const { directory, packageDigest } = await createPackageFixture(t)
  const sim = createPlatformSimulator()
  const task = makeTask(packageDigest)
  const store = new InMemoryDurableStore()

  let claimed = false
  const transport = new FakeRunnerTransport({
    platformKeyId: sim.platformKeyId,
    produceTaskEnvelope: (_request: ClaimRequest) => {
      claimed = true
      return sim.signTask(task)
    },
    produceRenewal: (request: HeartbeatRequest) => sim.signTask(task),
    nextTask: (_request: NextTaskRequest) =>
      claimed
        ? null
        : {
            version: RUNNER_TRANSPORT_VERSION,
            hasTask: true,
            ...coordinates(task),
            polledAt: new Date().toISOString(),
          },
  })

  const proc = runnerStart(
    makeStartOptions({ durableStore: store, transport, packageDigest, directory, sim }),
  )
  await proc.done

  const status = proc.status()
  assert.equal(status.processStatus, "stopped")
  assert.equal(status.tasksCompleted, 1)
  assert.equal(status.tasksFailed, 0)
  assert.equal(status.platformReachable, true)
  assert.ok(status.lastSuccessAt)

  // Receipt is signed by the runner key and matches the task
  const receiptEnvelope = transport.submittedReceipt
  assert.ok(receiptEnvelope, "receipt must have been submitted")
  const receipt = sim.verifyReceipt(receiptEnvelope)
  assert.equal(receipt.outcome.status, "completed")
  assert.equal(receipt.taskId, task.taskId)
  assert.equal(receipt.runId, task.runId)
  assert.equal(receipt.attempt, task.attempt)
  assert.equal(receipt.usage.inputTokens, 42)
  assert.equal(receipt.usage.outputTokens, 17)

  // Event chain was delivered and hashes into the receipt
  assert.ok(transport.submittedEvents.length >= 3)
  const chain = sim.verifyEventChain(transport.submittedEvents, task)
  assert.equal(chain.events.length, transport.submittedEvents.length)
  assert.equal(chain.finalDigest, receipt.finalEventDigest)
  assert.equal(receipt.eventCount, chain.events.length)

  // Attempt is durably recorded (replay protection survived the session)
  const attempt = store.getAttempt(task.taskId, task.nonce)
  assert.ok(attempt, "attempt must be recorded in the durable store")

  // Outbox drained: nothing pending remains
  const pending = await store.outbox().pending(100)
  assert.equal(pending.length, 0)
})

// ---------------------------------------------------------------------------
// Replay protection across runner sessions
// ---------------------------------------------------------------------------

test("duplicate nonce is rejected as a replay and never submits a receipt", async (t) => {
  const { directory, packageDigest } = await createPackageFixture(t)
  const sim = createPlatformSimulator()
  const task = makeTask(packageDigest)
  const store = new InMemoryDurableStore()

  // First runner completes the task
  let claimed = false
  const firstTransport = new FakeRunnerTransport({
    platformKeyId: sim.platformKeyId,
    produceTaskEnvelope: () => {
      claimed = true
      return sim.signTask(task)
    },
    produceRenewal: () => sim.signTask(task),
    nextTask: () =>
      claimed ? null : { version: RUNNER_TRANSPORT_VERSION, hasTask: true, ...coordinates(task), polledAt: new Date().toISOString() },
  })
  const first = runnerStart(
    makeStartOptions({ durableStore: store, transport: firstTransport, packageDigest, directory, sim }),
  )
  await first.done
  assert.equal(first.status().tasksCompleted, 1)

  // Second runner claims the same task again: replay guard must refuse
  const secondTransport = new FakeRunnerTransport({
    platformKeyId: sim.platformKeyId,
    produceTaskEnvelope: () => sim.signTask(task),
    produceRenewal: () => sim.signTask(task),
    nextTask: () => ({ version: RUNNER_TRANSPORT_VERSION, hasTask: true, ...coordinates(task), polledAt: new Date().toISOString() }),
  })
  const controller = new AbortController()
  const second = runnerStart(
    makeStartOptions({
      durableStore: store,
      transport: secondTransport,
      packageDigest,
      directory,
      sim,
      once: false,
      signal: controller.signal,
    }),
  )
  setTimeout(() => controller.abort(new Error("test abort")), 400)
  await second.done

  assert.ok(second.status().tasksFailed >= 1, "replayed task must fail")
  assert.equal(second.status().tasksCompleted, 0)
  assert.equal(secondTransport.submittedReceipt, null, "no receipt for a replayed task")
})

// ---------------------------------------------------------------------------
// Heartbeat renewal during a long execution
// ---------------------------------------------------------------------------

test("heartbeat renews the lease while a task is executing", async (t) => {
  const { directory, packageDigest } = await createPackageFixture(t)
  const sim = createPlatformSimulator()
  const task = makeTask(packageDigest, {
    leaseExpiresAt: new Date(Date.now() + 10_000).toISOString(),
  })
  const store = new InMemoryDurableStore()

  let renewals = 0
  let claimed = false
  const transport = new FakeRunnerTransport({
    platformKeyId: sim.platformKeyId,
    produceTaskEnvelope: () => {
      claimed = true
      return sim.signTask(task)
    },
    produceRenewal: () => {
      renewals += 1
      return sim.signTask({
        ...task,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
    },
    nextTask: () =>
      claimed ? null : { version: RUNNER_TRANSPORT_VERSION, hasTask: true, ...coordinates(task), polledAt: new Date().toISOString() },
  })

  const proc = runnerStart(
    makeStartOptions({
      durableStore: store,
      transport,
      packageDigest,
      directory,
      sim,
      hostRegistry: createSyntheticHostRegistry({ slowMs: 3_500 }),
    }),
  )
  await proc.done

  assert.ok(renewals >= 1, "lease must have been renewed at least once")
  const status = proc.status()
  assert.equal(status.tasksCompleted, 1)
  assert.equal(status.tasksFailed, 0)

  const receipt = sim.verifyReceipt(transport.submittedReceipt!)
  assert.equal(receipt.outcome.status, "completed")
  assert.equal(receipt.taskId, task.taskId)
})

// ---------------------------------------------------------------------------
// Device self-enrollment into the real file key store
// ---------------------------------------------------------------------------

test("runner self-enrolls a device key when the key store is empty", async (t) => {
  const { directory, packageDigest } = await createPackageFixture(t)
  const sim = createPlatformSimulator()
  const store = new InMemoryDurableStore()
  const keysDir = await mkdtemp(path.join(os.tmpdir(), "runner-loop-keys-"))
  t.after(async () => {
    await rm(keysDir, { recursive: true, force: true })
  })
  const keyStore = new FileDeviceKeyStore(keysDir)

  const transport = new FakeRunnerTransport({
    platformKeyId: sim.platformKeyId,
    produceTaskEnvelope: () => sim.signTask(makeTask(packageDigest)),
    produceRenewal: () => sim.signTask(makeTask(packageDigest)),
  })

  const controller = new AbortController()
  const proc = runnerStart(
    makeStartOptions({
      durableStore: store,
      transport,
      packageDigest,
      directory,
      sim,
      deviceKeyStore: keyStore,
      once: false,
      signal: controller.signal,
    }),
  )
  setTimeout(() => controller.abort(new Error("test abort")), 300)
  await proc.done

  const active = await keyStore.loadActiveKey()
  assert.ok(active, "a device key must have been enrolled")
  assert.equal(active.status, "active")
  assert.ok(await keyStore.loadPrivateKey(active.keyId), "private key material must be persisted")
})
