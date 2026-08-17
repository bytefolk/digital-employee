/**
 * Tests for the SQLite-backed durable store (SqliteDurableStore).
 *
 * Covers: schema bootstrap, corruption detection, deployment records,
 * atomic nonce claiming with fencing, attempt advancement, and the full
 * outbox lifecycle (append/pending/inflight/retry/ack/compact/overflow).
 */

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { CoreError } from "../../packages/core/src/contracts.js"
import {
  DURABLE_OUTBOX_COMPACTION_THRESHOLD,
  DURABLE_OUTBOX_MAX_RETRIES,
  DURABLE_OUTBOX_MAX_SIZE,
  DURABLE_STORE_SCHEMA_VERSION,
} from "../../packages/core/src/runner-durable-store.js"
import type {
  RunnerAttemptState,
  RunnerDeploymentRecord,
} from "../../packages/core/src/runner-durable-store.js"
import { SqliteDurableStore } from "../../packages/core/src/runner-sqlite-store.js"

async function createStore(t: test.TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sqlite-store-"))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return new SqliteDurableStore(path.join(dir, "state.db"))
}

function deployment(overrides?: Partial<RunnerDeploymentRecord>): RunnerDeploymentRecord {
  return {
    employeeId: "emp-001",
    employeeVersion: "1.0.0",
    packageDigest: "sha256:abc123",
    localPackageRef: "oci://local/emp-001:1.0.0",
    agentHostId: "host-001",
    registeredAt: "2026-08-04T00:00:00.000Z",
    ...overrides,
  }
}

function attempt(overrides?: Partial<RunnerAttemptState>): RunnerAttemptState {
  return {
    taskId: "task-001",
    nonce: "nonce-001",
    runnerId: "runner-001",
    fencingToken: 1,
    status: "claimed",
    eventsEmitted: 0,
    claimedAt: "2026-08-04T00:00:00.000Z",
    expiresAt: "2026-08-04T00:05:00.000Z",
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Schema / health
// ---------------------------------------------------------------------------

test("fresh store reports expected schema version and no corruption", async (t) => {
  const store = await createStore(t)
  assert.equal(store.schemaVersion(), DURABLE_STORE_SCHEMA_VERSION)
  assert.equal(store.detectCorruption(), null)
  assert.equal(store.degradedState(), null)
})

test("detectCorruption flags schema version mismatch", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sqlite-store-"))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const file = path.join(dir, "state.db")
  const store = new SqliteDurableStore(file)

  const raw = new DatabaseSync(file)
  raw.prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'").run()
  raw.close()

  const corruption = store.detectCorruption()
  assert.ok(corruption)
  assert.equal(corruption.kind, "schema_version_mismatch")
  assert.match(corruption.message, /expected schema version 1/)
})

test("detectCorruption flags unparseable outbox payload", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sqlite-store-"))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const file = path.join(dir, "state.db")
  const store = new SqliteDurableStore(file)

  const raw = new DatabaseSync(file)
  raw
    .prepare(
      "INSERT INTO outbox (kind, task_id, fencing_token, payload, status, retry_count, created_at) VALUES ('event', 'task-001', 1, 'not-base64url', 'pending', 0, ?)",
    )
    .run("2026-08-04T00:00:00.000Z")
  raw.close()

  const corruption = store.detectCorruption()
  assert.ok(corruption)
  assert.equal(corruption.kind, "data_truncated")
})

// ---------------------------------------------------------------------------
// Deployments
// ---------------------------------------------------------------------------

test("deployments round-trip through put/get/list/remove", async (t) => {
  const store = await createStore(t)
  const record = deployment()
  store.putDeployment(record)

  const loaded = store.getDeployment("emp-001", "1.0.0")
  assert.deepEqual(loaded, record)

  const listed = store.listDeployments()
  assert.equal(listed.length, 1)
  assert.deepEqual(listed[0], record)

  assert.equal(store.removeDeployment("emp-001", "1.0.0"), true)
  assert.equal(store.getDeployment("emp-001", "1.0.0"), undefined)
  assert.equal(store.removeDeployment("emp-001", "1.0.0"), false)
})

test("putDeployment rejects digest mismatch for same employee+version", async (t) => {
  const store = await createStore(t)
  store.putDeployment(deployment())

  assert.throws(
    () => store.putDeployment(deployment({ packageDigest: "sha256:different" })),
    (err: unknown) => {
      assert.ok(err instanceof CoreError)
      assert.equal(err.code, "DURABLE_STORE_DIGEST_MISMATCH")
      return true
    },
  )

  // Same digest upserts and refreshes fields
  store.putDeployment(deployment({ localPackageRef: "oci://local/emp-001:2.0.0" }))
  assert.equal(
    store.getDeployment("emp-001", "1.0.0")?.localPackageRef,
    "oci://local/emp-001:2.0.0",
  )
})

test("putDeployment preserves optional lastHealthCheckAt", async (t) => {
  const store = await createStore(t)
  store.putDeployment(
    deployment({ lastHealthCheckAt: "2026-08-04T00:01:00.000Z" }),
  )
  assert.equal(
    store.getDeployment("emp-001", "1.0.0")?.lastHealthCheckAt,
    "2026-08-04T00:01:00.000Z",
  )
})

// ---------------------------------------------------------------------------
// Atomic claim / fencing
// ---------------------------------------------------------------------------

test("claimNonce is atomic: same nonce cannot be claimed twice", async (t) => {
  const store = await createStore(t)
  assert.equal(store.claimNonce(attempt()), true)
  assert.equal(store.claimNonce(attempt()), false)

  const recorded = store.getAttempt("task-001", "nonce-001")
  assert.ok(recorded)
  assert.equal(recorded.runnerId, "runner-001")
  assert.equal(recorded.status, "claimed")
})

test("claimNonce rejects stale fencing tokens after a newer claim", async (t) => {
  const store = await createStore(t)
  assert.equal(store.claimNonce(attempt({ fencingToken: 1 })), true)
  assert.equal(store.claimNonce(attempt({ nonce: "nonce-002", fencingToken: 2 })), true)
  // Older fencing token must lose to the newer claim
  assert.equal(store.claimNonce(attempt({ nonce: "nonce-003", fencingToken: 1 })), false)
})

test("advanceAttempt updates state and marks older attempts superseded", async (t) => {
  const store = await createStore(t)
  store.claimNonce(attempt({ nonce: "nonce-001", fencingToken: 1 }))
  store.claimNonce(attempt({ nonce: "nonce-002", fencingToken: 2 }))

  // Advancing the older attempt must fail (superseded by token 2)
  assert.equal(
    store.advanceAttempt("task-001", "nonce-001", { status: "running" }),
    false,
  )
  assert.equal(store.getAttempt("task-001", "nonce-001")?.status, "superseded")

  // The newest attempt advances normally
  assert.equal(
    store.advanceAttempt("task-001", "nonce-002", {
      status: "running",
      eventsEmitted: 3,
      receiptDigest: "sha256:receipt",
    }),
    true,
  )
  const current = store.getAttempt("task-001", "nonce-002")
  assert.equal(current?.status, "running")
  assert.equal(current?.eventsEmitted, 3)
  assert.equal(current?.receiptDigest, "sha256:receipt")
})

test("advanceAttempt with unknown nonce returns false", async (t) => {
  const store = await createStore(t)
  assert.equal(store.advanceAttempt("task-001", "missing", { status: "running" }), false)
})

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

test("outbox append/pending/markInflight lifecycle", async (t) => {
  const store = await createStore(t)
  const outbox = store.outbox()

  const entry = await outbox.append({
    kind: "event",
    taskId: "task-001",
    fencingToken: 1,
    payload: Buffer.from(JSON.stringify({ hello: "world" }), "utf8").toString("base64url"),
  })
  assert.equal(entry.sequence, 1)
  assert.equal(entry.status, "pending")
  assert.equal(entry.retryCount, 0)

  let pending = await outbox.pending(10)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].sequence, 1)

  assert.equal(outbox.markInflight(1), true)
  // Inflight entries without a due retry are not pending
  pending = await outbox.pending(10)
  assert.equal(pending.length, 0)

  // A second markInflight on the same entry is still accepted (idempotent retry)
  assert.equal(outbox.markInflight(1), true)
  assert.equal(outbox.markInflight(999), false)
})

test("outbox markRetry schedules retries and deads after max retries", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sqlite-store-"))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const file = path.join(dir, "state.db")
  const store = new SqliteDurableStore(file)
  const outbox = store.outbox()
  await outbox.append({
    kind: "receipt",
    taskId: "task-001",
    fencingToken: 1,
    payload: Buffer.from(JSON.stringify({ done: true }), "utf8").toString("base64url"),
  })

  const past = "2000-01-01T00:00:00.000Z"
  for (let i = 0; i < DURABLE_OUTBOX_MAX_RETRIES; i++) {
    const retried = outbox.markRetry(1, past)
    if (i < DURABLE_OUTBOX_MAX_RETRIES - 1) {
      assert.equal(retried, true, `retry ${i} should succeed`)
    } else {
      assert.equal(retried, false, "final retry should dead the entry")
    }
  }

  const raw = new DatabaseSync(file)
  const row = raw.prepare("SELECT status FROM outbox WHERE sequence = 1").get() as {
    status: string
  }
  raw.close()
  assert.equal(row.status, "dead")
  // Dead entries never return from pending
  assert.equal((await outbox.pending(10)).length, 0)
  assert.equal(await outbox.size(), 1)
})

test("outbox ack/compact lifecycle", async (t) => {
  const store = await createStore(t)
  const outbox = store.outbox()
  await outbox.append({
    kind: "event",
    taskId: "task-001",
    fencingToken: 1,
    payload: "e30=",
  })
  await outbox.append({
    kind: "event",
    taskId: "task-001",
    fencingToken: 1,
    payload: "e30=",
  })

  assert.equal(outbox.ack(1), true)
  assert.equal(outbox.ack(999), false)
  assert.equal((await outbox.pending(10)).length, 1)

  // Ack removes the entry from pending; compact reclaims space
  assert.equal(outbox.ack(2), true)
  assert.equal(outbox.compact(), 2)
  assert.equal(await outbox.size(), 0)
})

test("outbox rejects overflow at capacity", async (t) => {
  const store = await createStore(t)
  const outbox = store.outbox()

  for (let i = 0; i < DURABLE_OUTBOX_MAX_SIZE; i++) {
    await outbox.append({
      kind: "event",
      taskId: "task-001",
      fencingToken: 1,
      payload: Buffer.from(JSON.stringify({ i }), "utf8").toString("base64url"),
    })
  }

  assert.throws(
    () =>
      outbox.append({
        kind: "event",
        taskId: "task-001",
        fencingToken: 1,
        payload: "e30=",
      }),
    (err: unknown) => {
      assert.ok(err instanceof CoreError)
      assert.equal(err.code, "DURABLE_OUTBOX_OVERFLOW")
      assert.equal(err.retryable, true)
      return true
    },
  )
})

test("degradedState reports near capacity", async (t) => {
  const store = await createStore(t)
  const outbox = store.outbox()

  const near = Math.floor(DURABLE_OUTBOX_MAX_SIZE * 0.9) + 1
  for (let i = 0; i < near; i++) {
    await outbox.append({
      kind: "event",
      taskId: "task-001",
      fencingToken: 1,
      payload: Buffer.from(JSON.stringify({ i }), "utf8").toString("base64url"),
    })
  }

  const degraded = store.degradedState()
  assert.ok(degraded)
  assert.equal(degraded.reason, "near_capacity")
})

test("degradedState reports compaction overdue", async (t) => {
  const store = await createStore(t)
  const outbox = store.outbox()

  for (let i = 0; i < DURABLE_OUTBOX_COMPACTION_THRESHOLD; i++) {
    const entry = await outbox.append({
      kind: "event",
      taskId: "task-001",
      fencingToken: 1,
      payload: Buffer.from(JSON.stringify({ i }), "utf8").toString("base64url"),
    })
    outbox.ack(entry.sequence)
  }

  const degraded = store.degradedState()
  assert.ok(degraded)
  assert.equal(degraded.reason, "compaction_overdue")

  // Compaction clears the condition
  assert.equal(outbox.compact(), DURABLE_OUTBOX_COMPACTION_THRESHOLD)
  assert.equal(store.degradedState(), null)
})

// ---------------------------------------------------------------------------
// Process-level single-active lock
// ---------------------------------------------------------------------------

/** Pid of a process that has already exited (guaranteed dead). */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"])
  assert.equal(child.status, 0)
  assert.ok(child.pid > 0)
  return child.pid
}

async function createSharedStore(t: test.TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sqlite-lock-"))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const file = path.join(dir, "state.db")
  return {
    file,
    storeA: new SqliteDurableStore(file),
    storeB: new SqliteDurableStore(file),
  }
}

test("runner lock: acquired when free, refused while holder pid is alive", async (t) => {
  const { storeA, storeB } = await createSharedStore(t)
  t.after(() => {
    storeA.close()
    storeB.close()
  })
  const owner = { pid: process.pid, startedAt: "2026-08-17T00:00:00.000Z" }
  assert.deepEqual(storeA.acquireRunnerLock(owner), {
    acquired: true,
    stolen: false,
  })

  // A second store (another process) is refused while our pid is alive.
  const contender = { pid: 42, startedAt: "2026-08-17T00:00:01.000Z" }
  assert.deepEqual(storeB.acquireRunnerLock(contender), {
    acquired: false,
    holder: owner,
  })
})

test("runner lock: release by owner frees it; non-owner cannot release", async (t) => {
  const { storeA, storeB } = await createSharedStore(t)
  t.after(() => {
    storeA.close()
    storeB.close()
  })
  const owner = { pid: process.pid, startedAt: "2026-08-17T00:10:00.000Z" }
  assert.equal(storeA.acquireRunnerLock(owner).acquired, true)

  // A non-owner's release must not remove the owner's lock.
  assert.equal(
    storeB.releaseRunnerLock({ pid: 42, startedAt: "2026-08-17T00:10:01.000Z" }),
    false,
  )
  assert.deepEqual(storeB.acquireRunnerLock({ pid: 42, startedAt: "2026-08-17T00:10:01.000Z" }), {
    acquired: false,
    holder: owner,
  })

  assert.equal(storeA.releaseRunnerLock(owner), true)
  assert.deepEqual(storeB.acquireRunnerLock({ pid: 42, startedAt: "2026-08-17T00:10:01.000Z" }), {
    acquired: true,
    stolen: false,
  })
})

test("runner lock: stale lock (dead owner pid) is stolen atomically", async (t) => {
  const { storeA, storeB } = await createSharedStore(t)
  t.after(() => {
    storeA.close()
    storeB.close()
  })
  const crashed = { pid: deadPid(), startedAt: "2026-08-17T01:00:00.000Z" }
  assert.equal(storeA.acquireRunnerLock(crashed).acquired, true)

  const survivor = { pid: process.pid, startedAt: "2026-08-17T01:00:01.000Z" }
  assert.deepEqual(storeB.acquireRunnerLock(survivor), {
    acquired: true,
    stolen: true,
  })

  // The crashed owner's token no longer releases anything.
  assert.equal(storeA.releaseRunnerLock(crashed), false)
  // The survivor now holds a live lock.
  assert.deepEqual(storeB.acquireRunnerLock({ pid: 42, startedAt: "2026-08-17T01:00:02.000Z" }), {
    acquired: false,
    holder: survivor,
  })
})
