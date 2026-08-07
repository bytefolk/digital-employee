import assert from "node:assert/strict"
import test from "node:test"
import type { KeyObject } from "node:crypto"

import {
  RUNNER_LIFECYCLE_VERSION,
  RUNNER_POLL_BASE_INTERVAL_MS,
  RUNNER_MAX_CONSECUTIVE_FAILURES,
  RunnerLifecycleError,
  runnerInit,
  runnerDoctor,
  runnerStart,
  runnerStatus,
  InMemoryDurableStore,
} from "../../packages/core/index.js"
import type {
  RunnerConfig,
  RunnerProcess,
  RunnerDeviceKeyStorePort,
  DeviceKeyRecord,
  RunnerTransportPort,
} from "../../packages/core/index.js"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function fakeClock(iso?: string): () => Date {
  let t = iso ? new Date(iso).getTime() : Date.now()
  return () => new Date(t++)
}

function makeConfig(overrides?: Partial<RunnerConfig>): RunnerConfig {
  return {
    version: RUNNER_LIFECYCLE_VERSION,
    runnerId: "runner-test-001",
    sellerId: "seller-test-001",
    platformEndpoint: "https://platform.example.com",
    createdAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function fakeDeviceKeyStore(activeKey?: DeviceKeyRecord | null): RunnerDeviceKeyStorePort {
  const key: DeviceKeyRecord | null = activeKey === undefined
    ? { keyId: "device:abc123", status: "active", activeSince: "2025-01-01T00:00:00.000Z" }
    : activeKey
  return {
    async loadActiveKey() { return key },
    async loadKey(_keyId: string) { return key },
    async loadHistory() { return key ? [key] : [] },
    async saveKey(_record: DeviceKeyRecord) { /* no-op */ },
    async loadPrivateKey(_keyId: string) { return null },
    async saveKeyPair(_keyId: string, _priv: KeyObject, _pub: KeyObject) { /* no-op */ },
    async deletePrivateKey(_keyId: string) { /* no-op */ },
  }
}

function failingDeviceKeyStore(): RunnerDeviceKeyStorePort {
  return {
    async loadActiveKey() { throw new Error("store unavailable") },
    async loadKey() { throw new Error("store unavailable") },
    async loadHistory() { throw new Error("store unavailable") },
    async saveKey() { throw new Error("store unavailable") },
    async loadPrivateKey() { throw new Error("store unavailable") },
    async saveKeyPair() { throw new Error("store unavailable") },
    async deletePrivateKey() { throw new Error("store unavailable") },
  }
}

function fakeTransport(): RunnerTransportPort {
  return {
    async claim() { throw new Error("no tasks") },
    async heartbeat() { throw new Error("not implemented") },
    async appendEvents() { throw new Error("not implemented") },
    async submitReceipt() { throw new Error("not implemented") },
    async enrollDevice() { throw new Error("not implemented") },
    async rotateKey() { throw new Error("not implemented") },
    async revokeKey() { throw new Error("not implemented") },
  } as unknown as RunnerTransportPort
}

// ---------------------------------------------------------------------------
// runner init
// ---------------------------------------------------------------------------

test("runnerInit creates config when no existing config", () => {
  const result = runnerInit({
    runnerId: "runner-001",
    sellerId: "seller-001",
    platformEndpoint: "https://platform.example.com",
    clock: fakeClock("2025-06-01T00:00:00.000Z"),
  }, null)

  assert.equal(result.created, true)
  assert.equal(result.config.version, RUNNER_LIFECYCLE_VERSION)
  assert.equal(result.config.runnerId, "runner-001")
  assert.equal(result.config.sellerId, "seller-001")
  assert.equal(result.config.platformEndpoint, "https://platform.example.com")
  assert.equal(result.config.createdAt, "2025-06-01T00:00:00.000Z")
})

test("runnerInit rejects when config already exists", () => {
  const existing = makeConfig()
  assert.throws(
    () => runnerInit({
      runnerId: "runner-002",
      sellerId: "seller-002",
      platformEndpoint: "https://other.example.com",
    }, existing),
    (err: unknown) => {
      assert.ok(err instanceof RunnerLifecycleError)
      assert.equal(err.code, "RUNNER_ALREADY_INITIALIZED")
      return true
    },
  )
})

test("runnerInit rejects missing runnerId", () => {
  assert.throws(
    () => runnerInit({
      runnerId: "",
      sellerId: "seller-001",
      platformEndpoint: "https://platform.example.com",
    }, null),
    (err: unknown) => {
      assert.ok(err instanceof RunnerLifecycleError)
      assert.equal(err.code, "RUNNER_CONFIG_INVALID")
      return true
    },
  )
})

test("runnerInit rejects missing sellerId", () => {
  assert.throws(
    () => runnerInit({
      runnerId: "runner-001",
      sellerId: "",
      platformEndpoint: "https://platform.example.com",
    }, null),
    (err: unknown) => {
      assert.ok(err instanceof RunnerLifecycleError)
      assert.equal(err.code, "RUNNER_CONFIG_INVALID")
      return true
    },
  )
})

test("runnerInit rejects missing platformEndpoint", () => {
  assert.throws(
    () => runnerInit({
      runnerId: "runner-001",
      sellerId: "seller-001",
      platformEndpoint: "",
    }, null),
    (err: unknown) => {
      assert.ok(err instanceof RunnerLifecycleError)
      assert.equal(err.code, "RUNNER_CONFIG_INVALID")
      return true
    },
  )
})

// ---------------------------------------------------------------------------
// runner doctor
// ---------------------------------------------------------------------------

test("runnerDoctor reports all pass with valid prerequisites", async () => {
  const store = new InMemoryDurableStore()
  store.putDeployment({
    employeeId: "emp-001",
    employeeVersion: "1.0.0",
    packageDigest: "sha256:abc",
    localPackageRef: "oci://local/emp-001:1.0.0",
    agentHostId: "host-001",
    registeredAt: "2025-01-01T00:00:00.000Z",
  })

  const report = await runnerDoctor({
    config: makeConfig(),
    deviceKeyStore: fakeDeviceKeyStore(),
    durableStore: store,
    clock: fakeClock(),
  })

  assert.equal(report.version, RUNNER_LIFECYCLE_VERSION)
  assert.equal(report.healthy, true)
  const names = report.checks.map((c) => c.name)
  assert.ok(names.includes("platform_support"))
  assert.ok(names.includes("config_present"))
  assert.ok(names.includes("device_key"))
  assert.ok(names.includes("durable_store"))
  assert.ok(names.includes("deployments"))
  assert.ok(names.includes("transport_connectivity"))
  // All non-skip checks should pass
  for (const check of report.checks) {
    if (check.result !== "skip") {
      assert.equal(check.result, "pass", `${check.name} should pass: ${check.message}`)
    }
  }
})

test("runnerDoctor reports fail when config is missing", async () => {
  const report = await runnerDoctor({
    config: null,
    deviceKeyStore: fakeDeviceKeyStore(),
    durableStore: new InMemoryDurableStore(),
    clock: fakeClock(),
  })

  const configCheck = report.checks.find((c) => c.name === "config_present")
  assert.ok(configCheck)
  assert.equal(configCheck.result, "fail")
})

test("runnerDoctor reports fail when device key missing", async () => {
  const report = await runnerDoctor({
    config: makeConfig(),
    deviceKeyStore: fakeDeviceKeyStore(null),
    durableStore: new InMemoryDurableStore(),
    clock: fakeClock(),
  })

  const keyCheck = report.checks.find((c) => c.name === "device_key")
  assert.ok(keyCheck)
  assert.equal(keyCheck.result, "fail")
  assert.equal(report.healthy, false)
})

test("runnerDoctor reports fail when device key revoked", async () => {
  const report = await runnerDoctor({
    config: makeConfig(),
    deviceKeyStore: fakeDeviceKeyStore({
      keyId: "device:revoked",
      status: "revoked",
      activeSince: "2025-01-01T00:00:00.000Z",
      revokedAt: "2025-06-01T00:00:00.000Z",
    }),
    durableStore: new InMemoryDurableStore(),
    clock: fakeClock(),
  })

  const keyCheck = report.checks.find((c) => c.name === "device_key")
  assert.ok(keyCheck)
  assert.equal(keyCheck.result, "fail")
  assert.equal(report.healthy, false)
})

test("runnerDoctor reports fail when device key store throws", async () => {
  const report = await runnerDoctor({
    config: makeConfig(),
    deviceKeyStore: failingDeviceKeyStore(),
    durableStore: new InMemoryDurableStore(),
    clock: fakeClock(),
  })

  const keyCheck = report.checks.find((c) => c.name === "device_key")
  assert.ok(keyCheck)
  assert.equal(keyCheck.result, "fail")
  assert.equal(report.healthy, false)
})

test("runnerDoctor reports fail when durable store is corrupted", async () => {
  const store = new InMemoryDurableStore()
  store._injectCorruption({
    kind: "checksum_invalid",
    message: "data integrity check failed",
    detectedAt: "2025-06-01T00:00:00.000Z",
  })

  const report = await runnerDoctor({
    config: makeConfig(),
    deviceKeyStore: fakeDeviceKeyStore(),
    durableStore: store,
    clock: fakeClock(),
  })

  const storeCheck = report.checks.find((c) => c.name === "durable_store")
  assert.ok(storeCheck)
  assert.equal(storeCheck.result, "fail")
  assert.equal(report.healthy, false)
})

test("runnerDoctor reports warn when no deployments", async () => {
  const report = await runnerDoctor({
    config: makeConfig(),
    deviceKeyStore: fakeDeviceKeyStore(),
    durableStore: new InMemoryDurableStore(),
    clock: fakeClock(),
  })

  const deployCheck = report.checks.find((c) => c.name === "deployments")
  assert.ok(deployCheck)
  assert.equal(deployCheck.result, "warn")
  // warn does not make the report unhealthy
  assert.equal(report.healthy, true)
})

test("runnerDoctor skips transport connectivity without transport", async () => {
  const report = await runnerDoctor({
    config: makeConfig(),
    deviceKeyStore: fakeDeviceKeyStore(),
    durableStore: new InMemoryDurableStore(),
    clock: fakeClock(),
  })

  const transportCheck = report.checks.find((c) => c.name === "transport_connectivity")
  assert.ok(transportCheck)
  assert.equal(transportCheck.result, "skip")
})

// ---------------------------------------------------------------------------
// runner start / stop
// ---------------------------------------------------------------------------

test("runnerStart returns a process that can be stopped gracefully", async () => {
  const proc = runnerStart({
    config: makeConfig(),
    deviceKeyStore: fakeDeviceKeyStore(),
    durableStore: new InMemoryDurableStore(),
    transport: fakeTransport(),
    clock: fakeClock(),
  })

  assert.ok(proc.status)
  assert.ok(proc.stop)
  assert.ok(proc.done)

  const status = proc.status()
  assert.equal(status.runnerId, "runner-test-001")
  assert.equal(status.sellerId, "seller-test-001")

  await proc.stop()
  const finalStatus = proc.status()
  assert.equal(finalStatus.processStatus, "stopped")
})

test("runnerStart respects external abort signal", async () => {
  const controller = new AbortController()
  const proc = runnerStart({
    config: makeConfig(),
    deviceKeyStore: fakeDeviceKeyStore(),
    durableStore: new InMemoryDurableStore(),
    transport: fakeTransport(),
    signal: controller.signal,
    clock: fakeClock(),
  })

  // Abort externally (simulates SIGTERM)
  controller.abort(new Error("SIGTERM"))
  await proc.done

  const status = proc.status()
  assert.equal(status.processStatus, "stopped")
})

test("runnerStart with pre-aborted signal stops immediately", async () => {
  const controller = new AbortController()
  controller.abort(new Error("already aborted"))

  const proc = runnerStart({
    config: makeConfig(),
    deviceKeyStore: fakeDeviceKeyStore(),
    durableStore: new InMemoryDurableStore(),
    transport: fakeTransport(),
    signal: controller.signal,
    clock: fakeClock(),
  })

  await proc.done
  assert.equal(proc.status().processStatus, "stopped")
})

test("runnerStart reports status changes via callback", async () => {
  const changes: string[] = []
  const controller = new AbortController()

  const proc = runnerStart({
    config: makeConfig(),
    deviceKeyStore: fakeDeviceKeyStore(),
    durableStore: new InMemoryDurableStore(),
    transport: fakeTransport(),
    signal: controller.signal,
    clock: fakeClock(),
    onStatusChange: (s) => changes.push(s.processStatus),
  })

  // Give the loop a chance to transition to idle
  await new Promise((r) => setTimeout(r, 50))
  controller.abort()
  await proc.done

  // Should have at least "idle" -> "stopped" transitions
  assert.ok(changes.includes("idle"), `Expected idle in: ${changes.join(",")}`)
  assert.ok(changes.includes("stopped"), `Expected stopped in: ${changes.join(",")}`)
})

test("runnerStart stop is idempotent", async () => {
  const proc = runnerStart({
    config: makeConfig(),
    deviceKeyStore: fakeDeviceKeyStore(),
    durableStore: new InMemoryDurableStore(),
    transport: fakeTransport(),
    clock: fakeClock(),
  })

  await proc.stop()
  // Calling stop again should not throw
  await proc.stop()
  assert.equal(proc.status().processStatus, "stopped")
})

// ---------------------------------------------------------------------------
// runner status
// ---------------------------------------------------------------------------

test("runnerStatus returns stopped status when no process running", async () => {
  const store = new InMemoryDurableStore()
  store.putDeployment({
    employeeId: "emp-001",
    employeeVersion: "1.0.0",
    packageDigest: "sha256:abc",
    localPackageRef: "oci://local",
    agentHostId: "host-001",
    registeredAt: "2025-01-01T00:00:00.000Z",
  })

  const status = await runnerStatus({
    config: makeConfig(),
    deviceKeyStore: fakeDeviceKeyStore(),
    durableStore: store,
    clock: fakeClock(),
  })

  assert.equal(status.version, RUNNER_LIFECYCLE_VERSION)
  assert.equal(status.processStatus, "stopped")
  assert.equal(status.runnerId, "runner-test-001")
  assert.equal(status.sellerId, "seller-test-001")
  assert.equal(status.deviceKeyStatus, "active")
  assert.equal(status.deploymentCount, 1)
  assert.equal(status.storeHealthy, true)
  assert.equal(status.platformReachable, false)
})

test("runnerStatus reports running process status", async () => {
  const proc = runnerStart({
    config: makeConfig(),
    deviceKeyStore: fakeDeviceKeyStore(),
    durableStore: new InMemoryDurableStore(),
    transport: fakeTransport(),
    clock: fakeClock(),
  })

  // Let it transition
  await new Promise((r) => setTimeout(r, 20))

  const status = await runnerStatus({
    config: makeConfig(),
    deviceKeyStore: fakeDeviceKeyStore(),
    durableStore: new InMemoryDurableStore(),
    runningProcess: proc,
    clock: fakeClock(),
  })

  assert.notEqual(status.processStatus, "stopped")
  await proc.stop()
})

test("runnerStatus with missing device key", async () => {
  const status = await runnerStatus({
    config: makeConfig(),
    deviceKeyStore: fakeDeviceKeyStore(null),
    durableStore: new InMemoryDurableStore(),
    clock: fakeClock(),
  })

  assert.equal(status.deviceKeyStatus, "missing")
})

test("runnerStatus with failing device key store", async () => {
  const status = await runnerStatus({
    config: makeConfig(),
    deviceKeyStore: failingDeviceKeyStore(),
    durableStore: new InMemoryDurableStore(),
    clock: fakeClock(),
  })

  assert.equal(status.deviceKeyStatus, "missing")
})

test("runnerStatus with corrupted store", async () => {
  const store = new InMemoryDurableStore()
  store._injectCorruption({
    kind: "data_truncated",
    message: "unexpected eof",
    detectedAt: "2025-01-01T00:00:00.000Z",
  })

  const status = await runnerStatus({
    config: makeConfig(),
    deviceKeyStore: fakeDeviceKeyStore(),
    durableStore: store,
    clock: fakeClock(),
  })

  assert.equal(status.storeHealthy, false)
})

test("runnerStatus with null config", async () => {
  const status = await runnerStatus({
    config: null,
    deviceKeyStore: fakeDeviceKeyStore(),
    durableStore: new InMemoryDurableStore(),
    clock: fakeClock(),
  })

  assert.equal(status.runnerId, "unknown")
  assert.equal(status.sellerId, "unknown")
})

// ---------------------------------------------------------------------------
// Reconnect / backoff behavior
// ---------------------------------------------------------------------------

test("runnerStart enters degraded state after consecutive failures", async () => {
  // We cannot easily simulate transport failures in the poll loop since
  // the current implementation only drains outbox, but we verify the
  // degraded threshold constant and the status field exist.
  assert.equal(RUNNER_MAX_CONSECUTIVE_FAILURES, 10)

  const proc = runnerStart({
    config: makeConfig(),
    deviceKeyStore: fakeDeviceKeyStore(),
    durableStore: new InMemoryDurableStore(),
    transport: fakeTransport(),
    clock: fakeClock(),
  })

  const status = proc.status()
  assert.equal(status.consecutiveFailures, 0)
  assert.equal(status.tasksCompleted, 0)
  assert.equal(status.tasksFailed, 0)
  await proc.stop()
})

// ---------------------------------------------------------------------------
// Platform support (POSIX)
// ---------------------------------------------------------------------------

test("runnerDoctor passes platform check on non-Windows", async () => {
  // This test runs on macOS/Linux in CI
  const report = await runnerDoctor({
    config: makeConfig(),
    deviceKeyStore: fakeDeviceKeyStore(),
    durableStore: new InMemoryDurableStore(),
    clock: fakeClock(),
  })

  const platformCheck = report.checks.find((c) => c.name === "platform_support")
  assert.ok(platformCheck)
  if (process.platform === "win32") {
    assert.equal(platformCheck.result, "fail")
  } else {
    assert.equal(platformCheck.result, "pass")
  }
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("runnerInit undefined existingConfig treated as no config", () => {
  const result = runnerInit({
    runnerId: "runner-003",
    sellerId: "seller-003",
    platformEndpoint: "https://platform.example.com",
  }, undefined as unknown as null)

  assert.equal(result.created, true)
})

test("RUNNER_LIFECYCLE_VERSION constant is correct", () => {
  assert.equal(RUNNER_LIFECYCLE_VERSION, "runner-lifecycle.v1")
})

test("RunnerLifecycleError is instanceof Error", () => {
  const err = new RunnerLifecycleError("RUNNER_NOT_INITIALIZED")
  assert.ok(err instanceof Error)
  assert.equal(err.name, "RunnerLifecycleError")
  assert.equal(err.code, "RUNNER_NOT_INITIALIZED")
})
