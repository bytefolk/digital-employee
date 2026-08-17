/**
 * Integration test: Runner <-> Platform over real HTTP (bidirectional)
 *
 * Drives the full runner lifecycle (runnerStart) with HttpRunnerTransport
 * against a real local HTTP platform simulator: device enrollment, platform
 * key fetch, task claim, lease renewal over the wire, event submission, and
 * signed receipt delivery. Also covers transport error semantics
 * (401/403/400/404/429/5xx, version validation) and nonce idempotency.
 *
 * Machine-readable output: runner-http-e2e.v1
 */

import assert from "node:assert/strict"
import {
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto"
import { mkdtemp } from "node:fs/promises"
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  computeEmployeePackageDirectoryDigest,
  createEmployeePackage,
} from "../../apps/cli/employee-package.js"
import { executeOneShotRunnerTask } from "../../apps/cli/runner-executor.js"
import {
  AGENT_HOST_PROTOCOL_VERSION,
  createUnknownAgentHostCapabilities,
} from "../../packages/core/src/agent-host.js"
import type {
  AgentHostAdapter,
  AgentHostProbeResult,
} from "../../packages/core/src/agent-host.js"
import { AgentHostRegistry } from "../../packages/core/src/agent-host-registry.js"
import { InMemoryDurableStore } from "../../packages/core/src/runner-durable-store.js"
import type { DeviceKeyRecord } from "../../packages/core/src/runner-device.js"
import { HttpRunnerTransport } from "../../packages/core/src/runner-http-transport.js"
import { runnerInit, runnerStart } from "../../packages/core/src/runner-lifecycle.js"
import {
  RUNNER_PROTOCOL_VERSION,
  encodeOpaqueJson,
  signRunnerTask,
  verifyRunnerEventChain,
  verifyRunnerReceipt,
  verifyRunnerTask,
} from "../../packages/core/src/runner-protocol.js"
import type {
  RunnerEvent,
  RunnerReceiptPayload,
  RunnerTaskPayload,
  SignedEnvelope,
} from "../../packages/core/src/runner-protocol.js"
import {
  RUNNER_TRANSPORT_VERSION,
  RunnerTransportError,
} from "../../packages/core/src/runner-transport.js"
import type { HeartbeatRequest } from "../../packages/core/src/runner-transport.js"

// ---------------------------------------------------------------------------
// Local HTTP platform simulator (wire contract from runner-http-transport.ts)
// ---------------------------------------------------------------------------

interface ReceivedRequest {
  method: string
  path: string
  body: unknown
  nonce: string | null
}

interface ScriptedStatus {
  status: number
  remaining: number
  retryAfter?: string
  body?: unknown
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      if (chunks.length === 0) {
        resolve(null)
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      } catch (error) {
        reject(error)
      }
    })
    request.on("error", reject)
  })
}

function extractNonce(body: unknown): string | null {
  if (!body || typeof body !== "object") return null
  const meta = (body as { meta?: { requestNonce?: unknown } }).meta
  return typeof meta?.requestNonce === "string" ? meta.requestNonce : null
}

class PlatformHttpServer {
  readonly platformKeyPair = generateKeyPairSync("ed25519")
  readonly platformKeyId = "platform-http-key-1"
  readonly decoyKeyPair = generateKeyPairSync("ed25519")

  readonly requests: ReceivedRequest[] = []
  readonly devices: Array<{
    runnerId: string
    keyId: string
    publicKeySpki: string
  }> = []
  readonly events: unknown[] = []
  readonly receipts: SignedEnvelope[] = []
  heartbeats = 0
  claimCount = 0

  task: RunnerTaskPayload | null = null
  /** First N claims are signed with the decoy key (signature must fail). */
  wrongKeyClaims = 0
  /** Lease extension granted on each heartbeat (ms). */
  renewalMs = 20_000
  /**
   * Runner receipt public key, known to the platform out-of-band (the CLI
   * persists a dedicated receipt keypair at `runner init`, separate from the
   * enrolled device key). Receipts are verified against it.
   */
  runnerReceiptPublicKey: KeyObject | null = null
  /** One-shot scripted responses per path, consumed per request. */
  statusOverrides = new Map<string, ScriptedStatus>()

  readonly #server: Server
  url = ""

  private constructor() {
    this.#server = createServer((request, response) => {
      void this.#dispatch(request, response)
    })
  }

  static async start(): Promise<PlatformHttpServer> {
    const platform = new PlatformHttpServer()
    await new Promise<void>((resolve) => {
      platform.#server.listen(0, "127.0.0.1", resolve)
    })
    const address = platform.#server.address() as AddressInfo
    platform.url = `http://127.0.0.1:${address.port}`
    return platform
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => (error ? reject(error) : resolve()))
    })
  }

  get platformPublicKeyPem(): string {
    return this.platformKeyPair.publicKey
      .export({ type: "spki", format: "pem" })
      .toString()
  }

  signTask(
    task: RunnerTaskPayload,
    keyPair: ReturnType<typeof generateKeyPairSync> = this.platformKeyPair,
  ): SignedEnvelope {
    return signRunnerTask({
      task,
      keyId: this.platformKeyId,
      privateKey: keyPair.privateKey,
    })
  }

  renewedTask(): RunnerTaskPayload {
    const task = this.task
    assert.ok(task, "no task to renew")
    return {
      ...task,
      leaseExpiresAt: new Date(
        Date.parse(task.leaseExpiresAt) + this.renewalMs,
      ).toISOString(),
    }
  }

  verifyLatestReceipt(): RunnerReceiptPayload {
    const envelope = this.receipts[this.receipts.length - 1]
    assert.ok(envelope, "no receipt received")
    assert.ok(this.runnerReceiptPublicKey, "runner receipt public key not configured")
    return verifyRunnerReceipt({
      envelope,
      publicKey: this.runnerReceiptPublicKey,
    })
  }

  #ok(response: ServerResponse, body: unknown): void {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify(body))
  }

  #err(
    response: ServerResponse,
    status: number,
    code: string,
    message: string,
  ): void {
    response.writeHead(status, { "content-type": "application/json" })
    response.end(JSON.stringify({ code, message }))
  }

  async #dispatch(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", this.url)
    const body = await readJsonBody(request).catch(() => null)
    this.requests.push({
      method: request.method ?? "",
      path: url.pathname,
      body,
      nonce: extractNonce(body),
    })

    const scripted = this.statusOverrides.get(url.pathname)
    if (scripted && scripted.remaining > 0) {
      scripted.remaining -= 1
      if (scripted.retryAfter) {
        response.setHeader("retry-after", scripted.retryAfter)
      }
      response.writeHead(scripted.status, { "content-type": "application/json" })
      response.end(
        JSON.stringify(
          scripted.body ?? { code: "scripted", message: "scripted response" },
        ),
      )
      return
    }

    if (request.method === "GET" && url.pathname === `/v1/keys/${this.platformKeyId}`) {
      this.#ok(response, {
        keyId: this.platformKeyId,
        publicKeyPem: this.platformPublicKeyPem,
      })
      return
    }
    if (request.method === "GET" && url.pathname.startsWith("/v1/keys/")) {
      this.#err(
        response,
        404,
        "not_found",
        `unknown platform key ${url.pathname.split("/").pop()}`,
      )
      return
    }
    if (request.method !== "POST") {
      this.#err(response, 405, "method_not_allowed", "POST required")
      return
    }

    switch (url.pathname) {
      case "/v1/runner/device/enroll": {
        const enrollment = (
          body as {
            enrollment?: {
              keyId?: unknown
              runnerId?: unknown
              publicKeySpki?: unknown
            }
          }
        )?.enrollment
        if (
          !enrollment ||
          typeof enrollment.keyId !== "string" ||
          typeof enrollment.publicKeySpki !== "string"
        ) {
          this.#err(response, 400, "invalid_request", "enrollment missing or malformed")
          return
        }
        this.devices.push({
          runnerId: String(enrollment.runnerId),
          keyId: enrollment.keyId,
          publicKeySpki: enrollment.publicKeySpki,
        })
        this.#ok(response, {
          version: RUNNER_TRANSPORT_VERSION,
          accepted: true,
          platformKeyId: this.platformKeyId,
          enrolledAt: new Date().toISOString(),
        })
        return
      }
      case "/v1/runner/next-task": {
        if (!this.task || this.receipts.length > 0) {
          this.#ok(response, {
            version: RUNNER_TRANSPORT_VERSION,
            hasTask: false,
            polledAt: new Date().toISOString(),
          })
          return
        }
        const task = this.task
        this.#ok(response, {
          version: RUNNER_TRANSPORT_VERSION,
          hasTask: true,
          taskId: task.taskId,
          runId: task.runId,
          attempt: task.attempt,
          fencingToken: task.fencingToken,
          polledAt: new Date().toISOString(),
        })
        return
      }
      case "/v1/runner/claim": {
        this.claimCount += 1
        const task = this.task
        if (!task) {
          this.#err(response, 409, "conflict", "no task to claim")
          return
        }
        const useDecoy = this.claimCount <= this.wrongKeyClaims
        this.#ok(response, {
          version: RUNNER_TRANSPORT_VERSION,
          taskEnvelope: this.signTask(
            task,
            useDecoy ? this.decoyKeyPair : this.platformKeyPair,
          ),
          platformKeyId: this.platformKeyId,
          grantedAt: new Date().toISOString(),
        })
        return
      }
      case "/v1/runner/heartbeat": {
        this.heartbeats += 1
        this.#ok(response, {
          version: RUNNER_TRANSPORT_VERSION,
          renewedEnvelope: this.signTask(this.renewedTask()),
          acknowledgedAt: new Date().toISOString(),
        })
        return
      }
      case "/v1/runner/events": {
        const events = (body as { events?: unknown[] })?.events
        if (!Array.isArray(events)) {
          this.#err(response, 400, "invalid_request", "events must be an array")
          return
        }
        this.events.push(...events)
        const last = events[events.length - 1] as { digest?: unknown } | undefined
        this.#ok(response, {
          version: RUNNER_TRANSPORT_VERSION,
          accepted: events.length,
          lastAcceptedDigest:
            typeof last?.digest === "string" ? last.digest : "",
          acknowledgedAt: new Date().toISOString(),
        })
        return
      }
      case "/v1/runner/receipt": {
        const signedReceipt = (body as { signedReceipt?: unknown })?.signedReceipt
        if (!signedReceipt || typeof signedReceipt !== "object") {
          this.#err(response, 400, "invalid_request", "signedReceipt missing")
          return
        }
        this.receipts.push(signedReceipt as SignedEnvelope)
        this.#ok(response, {
          version: RUNNER_TRANSPORT_VERSION,
          accepted: true,
          settledAt: new Date().toISOString(),
        })
        return
      }
      default:
        this.#err(response, 404, "not_found", `unknown endpoint ${url.pathname}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Fixture helpers
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

/**
 * Slow synthetic host: keeps the run alive long enough for the heartbeat
 * loop to renew the lease over the wire (events span ~4.8s).
 */
function createSlowHostRegistry(options: { delayMs?: number } = {}): {
  registry: AgentHostRegistry
  runCount: () => number
} {
  const delayMs = options.delayMs ?? 1500
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  let runs = 0
  const adapter: AgentHostAdapter = {
    hostId: "fixture-host",
    async probe() {
      return readyProbe()
    },
    async preflight() {
      return readyProbe()
    },
    async *run(request) {
      runs += 1
      yield { type: "run.started", runId: request.runId, timestamp: new Date().toISOString() }
      await sleep(delayMs)
      yield {
        type: "usage",
        runId: request.runId,
        timestamp: new Date().toISOString(),
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      }
      await sleep(delayMs)
      yield {
        type: "tool.completed",
        runId: request.runId,
        timestamp: new Date().toISOString(),
        toolCallId: "call-1",
        toolName: "knowledge.search",
        output: { matches: 1 },
        isError: false,
      }
      await sleep(delayMs)
      yield {
        type: "run.completed",
        runId: request.runId,
        timestamp: new Date().toISOString(),
        output: { status: "answered", answer: "http answer", citations: [] },
      }
    },
  }
  const registry = new AgentHostRegistry().register({
    id: "fixture-host",
    probe: () => adapter.probe(),
    createAdapter: () => adapter,
  })
  return { registry, runCount: () => runs }
}

function createMemoryDeviceKeyStore() {
  const records: DeviceKeyRecord[] = []
  let keyPair: { privateKey: KeyObject; publicKey: KeyObject } | null = null
  return {
    async loadActiveKey() {
      const active = records.find(
        (record) => record.status === "active" || record.status === "rotating",
      )
      return active ? { ...active } : null
    },
    async loadKey() {
      return null
    },
    async loadHistory() {
      return records.map((record) => ({ ...record }))
    },
    async saveKey(record: DeviceKeyRecord) {
      const index = records.findIndex((entry) => entry.keyId === record.keyId)
      if (index >= 0) records[index] = { ...record }
      else records.push({ ...record })
    },
    async loadPrivateKey() {
      return keyPair?.privateKey ?? null
    },
    async saveKeyPair(_keyId: string, privateKey: KeyObject, publicKey: KeyObject) {
      keyPair = { privateKey, publicKey }
    },
    async deletePrivateKey() {
      keyPair = null
    },
  }
}

async function createPackageFixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "runner-http-e2e-"))
  const directory = path.join(parent, "answer-agent")
  await createEmployeePackage(directory)
  const packageDigest = await computeEmployeePackageDirectoryDigest(directory)
  return { directory, packageDigest }
}

function makeTask(
  now: Date,
  packageDigest: string,
  nonceFill: number,
  leaseSeconds: number,
): RunnerTaskPayload {
  return {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    kind: "runner.task",
    taskId: "http-task-1",
    runId: "http-run-1",
    attempt: 1,
    fencingToken: 1,
    leaseId: "http-lease-1",
    quoteId: "http-quote-1",
    reservationId: "http-res-1",
    sellerId: "seller-http-1",
    runnerId: "runner-http-1",
    employee: { id: "answer-agent", version: "0.1.0", packageDigest },
    engine: "fixture-host",
    input: encodeOpaqueJson({ message: "http e2e" }),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 120_000).toISOString(),
    leaseExpiresAt: new Date(now.getTime() + leaseSeconds * 1000).toISOString(),
    nonce: Buffer.alloc(16, nonceFill).toString("base64url"),
  }
}

function eventIdentity(task: RunnerTaskPayload) {
  return {
    taskId: task.taskId,
    runId: task.runId,
    attempt: task.attempt,
    fencingToken: task.fencingToken,
    leaseId: task.leaseId,
    quoteId: task.quoteId,
    runnerId: task.runnerId,
    employeeId: task.employee.id,
    packageDigest: task.employee.packageDigest,
  }
}

async function startRunner(options: {
  directory: string
  packageDigest: string
  platform: PlatformHttpServer
  task: RunnerTaskPayload
  deviceKeyStore: ReturnType<typeof createMemoryDeviceKeyStore>
  durableStore: InMemoryDurableStore
  registry: AgentHostRegistry
  receiptKeyId: string
  receiptPrivateKey: KeyObject
}) {
  const transport = new HttpRunnerTransport({
    endpoint: options.platform.url,
    maxRetries: 2,
    timeoutMs: 10_000,
  })
  const init = runnerInit({
    runnerId: options.task.runnerId,
    sellerId: options.task.sellerId,
    platformEndpoint: options.platform.url,
  })
  return runnerStart({
    config: init.config,
    deviceKeyStore: options.deviceKeyStore,
    durableStore: options.durableStore,
    transport,
    resolvePlatformPublicKey: (keyId) => transport.platformKey(keyId),
    resolveLocalPackage: () => options.directory,
    hostRegistry: options.registry,
    receiptKeyId: options.receiptKeyId,
    receiptPrivateKey: options.receiptPrivateKey,
    executeTask: (execution) => executeOneShotRunnerTask(execution),
    once: true,
  })
}

// ---------------------------------------------------------------------------
// FULL ROUND TRIP OVER REAL HTTP
// ---------------------------------------------------------------------------

test(
  "runner-http e2e: enroll -> key fetch -> claim -> lease renewal -> events -> receipt over real HTTP",
  { timeout: 30_000 },
  async (t) => {
    const { directory, packageDigest } = await createPackageFixture()
    const platform = await PlatformHttpServer.start()
    t.after(() => platform.stop())
    const receiptKeyPair = generateKeyPairSync("ed25519")
    const receiptKeyId = "runner-receipt-key-1"
    const task = makeTask(new Date(), packageDigest, 0x41, 12)
    platform.task = task
    platform.runnerReceiptPublicKey = receiptKeyPair.publicKey

    const { registry, runCount } = createSlowHostRegistry()
    const process = await startRunner({
      directory,
      packageDigest,
      platform,
      task,
      deviceKeyStore: createMemoryDeviceKeyStore(),
      durableStore: new InMemoryDurableStore(),
      registry,
      receiptKeyId,
      receiptPrivateKey: receiptKeyPair.privateKey,
    })
    t.after(() => process.stop())
    await process.done

    // Runner finished one task successfully
    const status = process.status()
    assert.equal(status.processStatus, "stopped")
    assert.equal(status.tasksCompleted, 1)
    assert.equal(status.tasksFailed, 0)
    assert.equal(status.platformReachable, true)
    assert.ok(status.lastSuccessAt)

    // Device enrolled over HTTP with a fresh keypair
    assert.equal(platform.devices.length, 1)
    assert.equal(platform.devices[0].runnerId, task.runnerId)
    const deviceKeyId = platform.devices[0].keyId
    assert.ok(deviceKeyId.length > 0)

    // Wire contract: expected endpoints hit, versions correct, nonces unique
    const paths = platform.requests.map((request) => request.path)
    assert.ok(paths.includes(`/v1/keys/${platform.platformKeyId}`), "platform key fetched over HTTP")
    for (const expected of [
      "/v1/runner/device/enroll",
      "/v1/runner/next-task",
      "/v1/runner/claim",
      "/v1/runner/heartbeat",
      "/v1/runner/events",
      "/v1/runner/receipt",
    ]) {
      assert.ok(paths.includes(expected), `expected endpoint ${expected}`)
    }
    for (const request of platform.requests) {
      if (request.method !== "POST") continue
      const body = request.body as { version?: unknown }
      assert.equal(body.version, RUNNER_TRANSPORT_VERSION, `version on ${request.path}`)
      if (request.nonce !== null) {
        const meta = request.body as { meta?: { deviceKeyId?: unknown } }
        assert.equal(meta.meta?.deviceKeyId, deviceKeyId, `device key on ${request.path}`)
      }
    }
    const nonces = platform.requests
      .map((request) => request.nonce)
      .filter((nonce): nonce is string => nonce !== null)
    assert.equal(new Set(nonces).size, nonces.length, "request nonces must be unique")

    // Lease renewed over the wire while the run was in progress
    assert.ok(platform.heartbeats >= 1, "at least one heartbeat renewal")

    // Host ran exactly once
    assert.equal(runCount(), 1)

    // Events delivered in order and form a valid chain
    assert.ok(platform.events.length >= 4, "all run events delivered")
    const chain = verifyRunnerEventChain(
      platform.events as RunnerEvent[],
      eventIdentity(task),
    )
    assert.equal(chain.finalDigest, (platform.events.at(-1) as { digest: string }).digest)

    // Receipt signed by the runner receipt key and verifiable by the platform
    const receipt = platform.verifyLatestReceipt()
    assert.equal(receipt.outcome.status, "completed")
    assert.equal(receipt.taskId, task.taskId)
    assert.equal(receipt.runId, task.runId)
    assert.equal(receipt.attempt, task.attempt)
    assert.equal(receipt.eventCount, platform.events.length)
    assert.equal(receipt.finalEventDigest, chain.finalDigest)
    assert.equal(receipt.usage.inputTokens, 10)
    assert.equal(receipt.usage.outputTokens, 5)
    assert.deepEqual(receipt.usage.actions, [
      { name: "knowledge.search", count: 1 },
    ])
  },
)

// ---------------------------------------------------------------------------
// UNTRUSTED CLAIM SIGNATURE -> REJECT -> RECOVERY
// ---------------------------------------------------------------------------

test(
  "runner-http e2e: untrusted claim signature rejected without execution, recovers on next poll",
  { timeout: 30_000 },
  async (t) => {
    const { directory, packageDigest } = await createPackageFixture()
    const platform = await PlatformHttpServer.start()
    t.after(() => platform.stop())
    const receiptKeyPair = generateKeyPairSync("ed25519")
    const task = makeTask(new Date(), packageDigest, 0x42, 15)
    platform.task = task
    platform.wrongKeyClaims = 1
    platform.runnerReceiptPublicKey = receiptKeyPair.publicKey

    const { registry, runCount } = createSlowHostRegistry()
    const process = await startRunner({
      directory,
      packageDigest,
      platform,
      task,
      deviceKeyStore: createMemoryDeviceKeyStore(),
      durableStore: new InMemoryDurableStore(),
      registry,
      receiptKeyId: "runner-receipt-key-2",
      receiptPrivateKey: receiptKeyPair.privateKey,
    })
    t.after(() => process.stop())
    await process.done

    const status = process.status()
    assert.equal(status.tasksFailed, 1, "decoy claim must count as a failure")
    assert.equal(status.tasksCompleted, 1, "runner must recover on the next poll")
    assert.equal(platform.receipts.length, 1)
    assert.equal(runCount(), 1, "host must run exactly once")

    const receipt = platform.verifyLatestReceipt()
    assert.equal(receipt.outcome.status, "completed")
    assert.equal(receipt.taskId, task.taskId)
  },
)

// ---------------------------------------------------------------------------
// TRANSPORT ERROR SEMANTICS (direct HttpRunnerTransport calls)
// ---------------------------------------------------------------------------

test(
  "runner-http e2e: transport error mapping (401/403/400/404/429/5xx/version)",
  { timeout: 30_000 },
  async (t) => {
    const platform = await PlatformHttpServer.start()
    t.after(() => platform.stop())

    async function errorFor(
      path: string,
      call: () => Promise<unknown>,
      override?: { status: number; retryAfter?: string; body?: unknown },
    ) {
      if (override) {
        platform.statusOverrides.set(path, { ...override, remaining: 1 })
      }
      let error: unknown
      try {
        await call()
      } catch (caught) {
        error = caught
      }
      assert.ok(error !== undefined, `expected ${path} to fail`)
      return error
    }

    const noRetry = new HttpRunnerTransport({
      endpoint: platform.url,
      maxRetries: 0,
      timeoutMs: 5_000,
    })
    const meta = {
      deviceKeyId: "device-key-1",
      requestNonce: "req-err-1",
      requestedAt: new Date().toISOString(),
      runnerId: "runner-http-1",
    }

    // 401 -> UNAUTHORIZED (not retryable)
    const unauthorized = await errorFor(
      "/v1/runner/next-task",
      () => noRetry.nextTask({ version: RUNNER_TRANSPORT_VERSION, meta }),
      { status: 401 },
    )
    assert.ok(unauthorized instanceof RunnerTransportError)
    assert.equal(unauthorized.code, "RUNNER_TRANSPORT_UNAUTHORIZED")
    assert.equal(unauthorized.retryable, false)

    // 403 -> FORBIDDEN
    const forbidden = await errorFor(
      "/v1/runner/next-task",
      () => noRetry.nextTask({ version: RUNNER_TRANSPORT_VERSION, meta }),
      { status: 403 },
    )
    assert.ok(forbidden instanceof RunnerTransportError)
    assert.equal(forbidden.code, "RUNNER_TRANSPORT_FORBIDDEN")

    // 400 -> PAYLOAD_REJECTED
    const rejected = await errorFor(
      "/v1/runner/next-task",
      () => noRetry.nextTask({ version: RUNNER_TRANSPORT_VERSION, meta }),
      { status: 400 },
    )
    assert.ok(rejected instanceof RunnerTransportError)
    assert.equal(rejected.code, "RUNNER_TRANSPORT_PAYLOAD_REJECTED")

    // Unknown platform key -> 404 -> PAYLOAD_REJECTED (built-in route)
    const keyError = await errorFor(
      "/v1/keys/unknown-key",
      () => noRetry.platformKey("unknown-key"),
    )
    assert.ok(keyError instanceof RunnerTransportError)
    assert.equal(keyError.code, "RUNNER_TRANSPORT_PAYLOAD_REJECTED")

    // 429 + Retry-After -> RATE_LIMITED with retryAfterMs
    const rateLimited = await errorFor(
      "/v1/runner/next-task",
      () => noRetry.nextTask({ version: RUNNER_TRANSPORT_VERSION, meta }),
      { status: 429, retryAfter: "1" },
    )
    assert.ok(rateLimited instanceof RunnerTransportError)
    assert.equal(rateLimited.code, "RUNNER_TRANSPORT_RATE_LIMITED")
    assert.equal(rateLimited.retryAfterMs, 1000)

    // 200 with missing version -> PAYLOAD_REJECTED
    const versionError = await errorFor(
      "/v1/runner/next-task",
      () => noRetry.nextTask({ version: RUNNER_TRANSPORT_VERSION, meta }),
      { status: 200, body: { hasTask: false } },
    )
    assert.ok(versionError instanceof RunnerTransportError)
    assert.equal(versionError.code, "RUNNER_TRANSPORT_PAYLOAD_REJECTED")

    // 503 -> UNAVAILABLE (retryable)
    const unavailable = await errorFor(
      "/v1/runner/next-task",
      () => noRetry.nextTask({ version: RUNNER_TRANSPORT_VERSION, meta }),
      { status: 503 },
    )
    assert.ok(unavailable instanceof RunnerTransportError)
    assert.equal(unavailable.code, "RUNNER_TRANSPORT_UNAVAILABLE")
    assert.equal(unavailable.retryable, true)

    // Transient failure -> retry -> success (same request, fresh attempt)
    const retrying = new HttpRunnerTransport({
      endpoint: platform.url,
      maxRetries: 3,
      timeoutMs: 5_000,
    })
    const before = platform.requests.filter(
      (request) => request.path === "/v1/runner/next-task",
    ).length
    platform.statusOverrides.set("/v1/runner/next-task", { status: 503, remaining: 1 })
    const next = await retrying.nextTask({ version: RUNNER_TRANSPORT_VERSION, meta })
    assert.equal(next.hasTask, false)
    const after = platform.requests.filter(
      (request) => request.path === "/v1/runner/next-task",
    ).length
    assert.equal(after - before, 2, "failed attempt must be retried")
  },
)

// ---------------------------------------------------------------------------
// NONCE IDEMPOTENCY (duplicate request with same nonce is safe)
// ---------------------------------------------------------------------------

test(
  "runner-http e2e: duplicate heartbeat with same nonce is safe over the wire",
  { timeout: 15_000 },
  async (t) => {
    const platform = await PlatformHttpServer.start()
    t.after(() => platform.stop())
    const now = new Date()
    platform.task = makeTask(now, "sha256:" + "0".repeat(64), 0x44, 60)

    const transport = new HttpRunnerTransport({
      endpoint: platform.url,
      maxRetries: 0,
      timeoutMs: 5_000,
    })
    const request: HeartbeatRequest = {
      version: RUNNER_TRANSPORT_VERSION,
      meta: {
        deviceKeyId: "device-key-1",
        requestNonce: "req-duplicate-1",
        requestedAt: now.toISOString(),
        runnerId: "runner-http-1",
      },
      leaseId: "http-lease-1",
      taskId: "http-task-1",
      currentFencingToken: 1,
      eventDigests: [],
    }

    const first = await transport.heartbeat(request)
    const second = await transport.heartbeat(request)
    assert.equal(first.renewedEnvelope.keyId, platform.platformKeyId)
    assert.equal(second.renewedEnvelope.keyId, platform.platformKeyId)

    // Both renewals verify against the platform key and extend the lease
    const renewed = verifyRunnerTask({
      envelope: second.renewedEnvelope,
      publicKey: platform.platformKeyPair.publicKey,
    })
    assert.ok(
      Date.parse(renewed.leaseExpiresAt) > Date.parse(platform.task.leaseExpiresAt),
      "renewal must extend the lease",
    )

    // The identical nonce arrived twice: idempotency is a server-side
    // guarantee; the client must not invent a new nonce for a replay.
    assert.equal(platform.heartbeats, 2)
    const nonces = platform.requests
      .filter((request) => request.path === "/v1/runner/heartbeat")
      .map((request) => request.nonce)
    assert.deepEqual(nonces, ["req-duplicate-1", "req-duplicate-1"])
  },
)

// ---------------------------------------------------------------------------
// Machine-readable summary (logged at the end)
// ---------------------------------------------------------------------------

test("runner-http e2e: machine-readable acceptance output", () => {
  const report = {
    version: "runner-http-e2e.v1",
    timestamp: new Date().toISOString(),
    cases: 4,
    matrix: [
      "full_round_trip_over_http",
      "untrusted_claim_recovery",
      "transport_error_semantics",
      "nonce_idempotency",
    ],
  }
  assert.equal(report.version, "runner-http-e2e.v1")
  assert.equal(report.cases, 4)
  assert.equal(report.matrix.length, 4)
})
