import assert from "node:assert/strict"
import test from "node:test"

import {
  TASK_INTAKE_APPROVAL_VERSION,
  TASK_INTAKE_DEFAULT_TIMEOUT_MS,
  TASK_INTAKE_MIN_TIMEOUT_MS,
  TASK_INTAKE_MAX_TIMEOUT_MS,
  TaskIntakeApprovalError,
  TaskIntakeGate,
  computeTaskIntakeDigest,
  evaluateIntakeGate,
  validateTaskIntakePolicy,
  validateTaskIntakeRequest,
} from "../../packages/core/src/task-intake-approval.js"
import type {
  TaskIntakePolicy,
  TaskIntakeRequest,
  TaskIntakeDecision,
} from "../../packages/core/src/task-intake-approval.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeClock(iso?: string): () => Date {
  let t = iso ? new Date(iso).getTime() : Date.now()
  return () => new Date(t++)
}

function makeRequest(overrides?: Partial<TaskIntakeRequest>): TaskIntakeRequest {
  return {
    taskId: "task-001",
    leaseId: "lease-001",
    leaseExpiresAt: "2025-06-01T01:00:00.000Z",
    employeeId: "emp-001",
    runnerId: "runner-001",
    requestedAt: "2025-06-01T00:00:00.000Z",
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// validateTaskIntakePolicy
// ---------------------------------------------------------------------------

test("validateTaskIntakePolicy: valid policy with requireOwnerApproval true", () => {
  const policy = validateTaskIntakePolicy({ requireOwnerApproval: true })
  assert.equal(policy.requireOwnerApproval, true)
  assert.equal(policy.timeoutMs, undefined)
})

test("validateTaskIntakePolicy: valid policy with custom timeout", () => {
  const policy = validateTaskIntakePolicy({
    requireOwnerApproval: true,
    timeoutMs: 60_000,
  })
  assert.equal(policy.requireOwnerApproval, true)
  assert.equal(policy.timeoutMs, 60_000)
})

test("validateTaskIntakePolicy: rejects null", () => {
  assert.throws(
    () => validateTaskIntakePolicy(null),
    (err: unknown) => err instanceof TaskIntakeApprovalError && err.code === "INTAKE_POLICY_INVALID",
  )
})

test("validateTaskIntakePolicy: rejects missing requireOwnerApproval", () => {
  assert.throws(
    () => validateTaskIntakePolicy({}),
    (err: unknown) => err instanceof TaskIntakeApprovalError && err.code === "INTAKE_POLICY_INVALID",
  )
})

test("validateTaskIntakePolicy: rejects timeoutMs below minimum", () => {
  assert.throws(
    () => validateTaskIntakePolicy({ requireOwnerApproval: true, timeoutMs: 1_000 }),
    (err: unknown) => err instanceof TaskIntakeApprovalError && err.code === "INTAKE_POLICY_INVALID",
  )
})

test("validateTaskIntakePolicy: rejects timeoutMs above maximum", () => {
  assert.throws(
    () => validateTaskIntakePolicy({ requireOwnerApproval: true, timeoutMs: 9_999_999 }),
    (err: unknown) => err instanceof TaskIntakeApprovalError && err.code === "INTAKE_POLICY_INVALID",
  )
})

// ---------------------------------------------------------------------------
// validateTaskIntakeRequest
// ---------------------------------------------------------------------------

test("validateTaskIntakeRequest: valid request", () => {
  const request = validateTaskIntakeRequest(makeRequest())
  assert.equal(request.taskId, "task-001")
  assert.equal(request.leaseId, "lease-001")
})

test("validateTaskIntakeRequest: rejects null", () => {
  assert.throws(
    () => validateTaskIntakeRequest(null),
    (err: unknown) => err instanceof TaskIntakeApprovalError && err.code === "INTAKE_REQUEST_INVALID",
  )
})

test("validateTaskIntakeRequest: rejects empty taskId", () => {
  assert.throws(
    () => validateTaskIntakeRequest({ ...makeRequest(), taskId: "" }),
    (err: unknown) => err instanceof TaskIntakeApprovalError && err.code === "INTAKE_REQUEST_INVALID",
  )
})

// ---------------------------------------------------------------------------
// evaluateIntakeGate
// ---------------------------------------------------------------------------

test("evaluateIntakeGate: returns requiresApproval false when policy auto-accepts", () => {
  const result = evaluateIntakeGate({ requireOwnerApproval: false })
  assert.equal(result.requiresApproval, false)
})

test("evaluateIntakeGate: returns requiresApproval true when policy requires approval", () => {
  const result = evaluateIntakeGate({ requireOwnerApproval: true })
  assert.equal(result.requiresApproval, true)
})

// ---------------------------------------------------------------------------
// computeTaskIntakeDigest
// ---------------------------------------------------------------------------

test("computeTaskIntakeDigest: deterministic", () => {
  const d1 = computeTaskIntakeDigest("t1", "l1", "pending", "2025-01-01T00:00:00.000Z")
  const d2 = computeTaskIntakeDigest("t1", "l1", "pending", "2025-01-01T00:00:00.000Z")
  assert.equal(d1, d2)
  assert.equal(d1.length, 64)
})

test("computeTaskIntakeDigest: changes with state", () => {
  const d1 = computeTaskIntakeDigest("t1", "l1", "pending", "2025-01-01T00:00:00.000Z")
  const d2 = computeTaskIntakeDigest("t1", "l1", "approved", "2025-01-01T00:00:00.000Z")
  assert.notEqual(d1, d2)
})

// ---------------------------------------------------------------------------
// TaskIntakeGate: auto-accept (default behavior)
// ---------------------------------------------------------------------------

test("TaskIntakeGate: auto-accepts when policy does not require approval", () => {
  const gate = new TaskIntakeGate({
    policy: { requireOwnerApproval: false },
    clock: fakeClock("2025-06-01T00:00:00.000Z"),
  })
  const record = gate.submit(makeRequest())
  assert.equal(record.state, "auto_accepted")
  assert.equal(record.decidedBy, "policy:auto_accept")
  assert.equal(record.version, TASK_INTAKE_APPROVAL_VERSION)
  assert.equal(gate.canLaunch("task-001"), true)
})

// ---------------------------------------------------------------------------
// TaskIntakeGate: pending / approve / decline
// ---------------------------------------------------------------------------

test("TaskIntakeGate: holds task as pending when approval required", () => {
  const gate = new TaskIntakeGate({
    policy: { requireOwnerApproval: true },
    clock: fakeClock("2025-06-01T00:00:00.000Z"),
  })
  const record = gate.submit(makeRequest())
  assert.equal(record.state, "pending")
  assert.equal(record.decidedAt, null)
  assert.equal(record.decidedBy, null)
  assert.equal(gate.canLaunch("task-001"), false)
})

test("TaskIntakeGate: approve transitions pending to approved", () => {
  const gate = new TaskIntakeGate({
    policy: { requireOwnerApproval: true },
    clock: fakeClock("2025-06-01T00:00:00.000Z"),
  })
  gate.submit(makeRequest())
  const record = gate.decide({
    taskId: "task-001",
    approved: true,
    decidedBy: "owner:alice",
    reason: "looks good",
  })
  assert.equal(record.state, "approved")
  assert.equal(record.decidedBy, "owner:alice")
  assert.equal(record.reason, "looks good")
  assert.equal(gate.canLaunch("task-001"), true)
})

test("TaskIntakeGate: decline transitions pending to declined", () => {
  const gate = new TaskIntakeGate({
    policy: { requireOwnerApproval: true },
    clock: fakeClock("2025-06-01T00:00:00.000Z"),
  })
  gate.submit(makeRequest())
  const record = gate.decide({
    taskId: "task-001",
    approved: false,
    decidedBy: "owner:alice",
  })
  assert.equal(record.state, "declined")
  assert.equal(gate.canLaunch("task-001"), false)
})

// ---------------------------------------------------------------------------
// TaskIntakeGate: expiry
// ---------------------------------------------------------------------------

test("TaskIntakeGate: pending task expires on timeout", () => {
  let t = new Date("2025-06-01T00:00:00.000Z").getTime()
  const clock = () => new Date(t)

  const gate = new TaskIntakeGate({
    policy: { requireOwnerApproval: true, timeoutMs: 60_000 },
    clock,
  })
  gate.submit(makeRequest())

  // Advance past timeout
  t += 61_000
  const expired = gate.expirePending()
  assert.deepEqual(expired, ["task-001"])

  const record = gate.get("task-001")!
  assert.equal(record.state, "expired")
  assert.equal(record.decidedBy, "system:timeout")
  assert.equal(gate.canLaunch("task-001"), false)
})

test("TaskIntakeGate: decide after expiry throws INTAKE_EXPIRED", () => {
  let t = new Date("2025-06-01T00:00:00.000Z").getTime()
  const clock = () => new Date(t)

  const gate = new TaskIntakeGate({
    policy: { requireOwnerApproval: true, timeoutMs: 60_000 },
    clock,
  })
  gate.submit(makeRequest())

  // Advance past timeout
  t += 61_000
  assert.throws(
    () => gate.decide({ taskId: "task-001", approved: true, decidedBy: "owner:bob" }),
    (err: unknown) => err instanceof TaskIntakeApprovalError && err.code === "INTAKE_EXPIRED",
  )
})

test("TaskIntakeGate: expiry uses min of policy timeout and lease expiry", () => {
  let t = new Date("2025-06-01T00:00:00.000Z").getTime()
  const clock = () => new Date(t)

  // Lease expires in 30s, but policy timeout is 5 minutes
  const gate = new TaskIntakeGate({
    policy: { requireOwnerApproval: true, timeoutMs: 300_000 },
    clock,
  })
  gate.submit(makeRequest({ leaseExpiresAt: "2025-06-01T00:00:30.000Z" }))

  // After 31s the lease-based expiry should trigger
  t += 31_000
  const expired = gate.expirePending()
  assert.deepEqual(expired, ["task-001"])
})

// ---------------------------------------------------------------------------
// TaskIntakeGate: error paths
// ---------------------------------------------------------------------------

test("TaskIntakeGate: duplicate submit throws INTAKE_ALREADY_DECIDED", () => {
  const gate = new TaskIntakeGate({
    policy: { requireOwnerApproval: true },
    clock: fakeClock("2025-06-01T00:00:00.000Z"),
  })
  gate.submit(makeRequest())
  assert.throws(
    () => gate.submit(makeRequest()),
    (err: unknown) => err instanceof TaskIntakeApprovalError && err.code === "INTAKE_ALREADY_DECIDED",
  )
})

test("TaskIntakeGate: decide on unknown task throws INTAKE_NOT_FOUND", () => {
  const gate = new TaskIntakeGate({
    policy: { requireOwnerApproval: true },
    clock: fakeClock("2025-06-01T00:00:00.000Z"),
  })
  assert.throws(
    () => gate.decide({ taskId: "unknown", approved: true, decidedBy: "owner:x" }),
    (err: unknown) => err instanceof TaskIntakeApprovalError && err.code === "INTAKE_NOT_FOUND",
  )
})

test("TaskIntakeGate: decide twice on same task throws INTAKE_ALREADY_DECIDED", () => {
  const gate = new TaskIntakeGate({
    policy: { requireOwnerApproval: true },
    clock: fakeClock("2025-06-01T00:00:00.000Z"),
  })
  gate.submit(makeRequest())
  gate.decide({ taskId: "task-001", approved: true, decidedBy: "owner:x" })
  assert.throws(
    () => gate.decide({ taskId: "task-001", approved: false, decidedBy: "owner:x" }),
    (err: unknown) => err instanceof TaskIntakeApprovalError && err.code === "INTAKE_ALREADY_DECIDED",
  )
})

// ---------------------------------------------------------------------------
// TaskIntakeGate: events (AC-002 observability)
// ---------------------------------------------------------------------------

test("TaskIntakeGate: emits state change events", () => {
  const gate = new TaskIntakeGate({
    policy: { requireOwnerApproval: true },
    clock: fakeClock("2025-06-01T00:00:00.000Z"),
  })
  gate.submit(makeRequest())
  gate.decide({ taskId: "task-001", approved: true, decidedBy: "owner:x" })

  const events = gate.drainEvents()
  assert.equal(events.length, 2)
  assert.equal(events[0].type, "task_intake.state_change")
  assert.equal(events[0].previousState, null)
  assert.equal(events[0].newState, "pending")
  assert.equal(events[1].previousState, "pending")
  assert.equal(events[1].newState, "approved")
  assert.equal(events[0].version, TASK_INTAKE_APPROVAL_VERSION)
  // Digest should be a 64-char hex string
  assert.match(events[0].digest, /^[a-f0-9]{64}$/)
})

test("TaskIntakeGate: drainEvents empties the queue", () => {
  const gate = new TaskIntakeGate({
    policy: { requireOwnerApproval: false },
    clock: fakeClock("2025-06-01T00:00:00.000Z"),
  })
  gate.submit(makeRequest())
  assert.equal(gate.drainEvents().length, 1)
  assert.equal(gate.drainEvents().length, 0)
})

// ---------------------------------------------------------------------------
// TaskIntakeGate: pendingCount
// ---------------------------------------------------------------------------

test("TaskIntakeGate: pendingCount reflects pending tasks", () => {
  const gate = new TaskIntakeGate({
    policy: { requireOwnerApproval: true },
    clock: fakeClock("2025-06-01T00:00:00.000Z"),
  })
  assert.equal(gate.pendingCount(), 0)
  gate.submit(makeRequest({ taskId: "t1" }))
  gate.submit(makeRequest({ taskId: "t2" }))
  assert.equal(gate.pendingCount(), 2)
  gate.decide({ taskId: "t1", approved: true, decidedBy: "owner:x" })
  assert.equal(gate.pendingCount(), 1)
})

// ---------------------------------------------------------------------------
// TaskIntakeGate: get returns null for unknown
// ---------------------------------------------------------------------------

test("TaskIntakeGate: get returns null for unknown task", () => {
  const gate = new TaskIntakeGate({
    policy: { requireOwnerApproval: true },
    clock: fakeClock("2025-06-01T00:00:00.000Z"),
  })
  assert.equal(gate.get("nonexistent"), null)
})
