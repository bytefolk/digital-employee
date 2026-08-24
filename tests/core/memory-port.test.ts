import assert from "node:assert/strict"
import test from "node:test"

import {
  MEMORY_RECALL_SCHEMA_VERSION,
  MEMORY_WRITE_REQUEST_SCHEMA_VERSION,
  TASK_STATE_SCHEMA_VERSION,
  MemoryPortError,
  computeMemoryIdempotencyKey,
  derivePositionPrincipal,
  validateMemoryRecall,
  validateMemoryWriteRequest,
  validateTaskState,
} from "../../packages/core/src/memory-port.js"
import type {
  MemoryRecall,
  MemoryWriteRequest,
  TaskState,
} from "../../packages/core/src/memory-port.js"

const DIGEST_A = `sha256:${"a".repeat(64)}`
const DIGEST_B = `sha256:${"b".repeat(64)}`

function taskState(overrides: Partial<TaskState> = {}): TaskState {
  return {
    schemaVersion: TASK_STATE_SCHEMA_VERSION,
    taskId: "task-001",
    status: "completed",
    summary: "Reviewed terminal task state.",
    terminalOutputDigest: DIGEST_A,
    recordedAt: "2026-08-24T10:00:00.000Z",
    ...overrides,
  }
}

function writeRequest(
  overrides: Partial<MemoryWriteRequest> = {},
): MemoryWriteRequest {
  return {
    schemaVersion: MEMORY_WRITE_REQUEST_SCHEMA_VERSION,
    workspaceInstanceId: "11111111-1111-4111-8111-111111111111",
    sessionId: "22222222-2222-4222-8222-222222222222",
    turnId: "turn-001",
    positionId: "repo-owner",
    principal: "position.repo-owner",
    memoryScope: "/DigitalEmployees/repo-owner",
    taskState: taskState(),
    ...overrides,
  }
}

test("derivePositionPrincipal pins the server-owned position identity", () => {
  assert.equal(derivePositionPrincipal("repo-owner"), "position.repo-owner")
  assert.throws(
    () => derivePositionPrincipal("Repo Owner"),
    (error: unknown) =>
      error instanceof MemoryPortError &&
      error.code === "MEMORY_SCOPE_INVALID",
  )
})

test("task-state.v1 accepts one bounded terminal state", () => {
  assert.deepEqual(validateTaskState(taskState()), taskState())
})

test("task-state.v1 rejects unknown fields and non-terminal states", () => {
  assert.throws(
    () => validateTaskState({ ...taskState(), transcript: "must not persist" }),
    (error: unknown) =>
      error instanceof MemoryPortError &&
      error.code === "MEMORY_RECORD_INVALID",
  )
  assert.throws(() => validateTaskState({ ...taskState(), status: "running" }))
})

test("task-state.v1 rejects oversized text and malformed digest/time", () => {
  assert.throws(() =>
    validateTaskState({ ...taskState(), summary: "x".repeat(16_385) }),
  )
  assert.throws(() =>
    validateTaskState({ ...taskState(), terminalOutputDigest: "sha256:bad" }),
  )
  assert.throws(() =>
    validateTaskState({ ...taskState(), recordedAt: "yesterday" }),
  )
})

test("memory write request rejects unknown fields and scope mismatches", () => {
  assert.deepEqual(validateMemoryWriteRequest(writeRequest()), writeRequest())
  assert.throws(() =>
    validateMemoryWriteRequest({ ...writeRequest(), extra: true }),
  )
  assert.throws(
    () =>
      validateMemoryWriteRequest({
        ...writeRequest(),
        principal: "position.other",
      }),
    (error: unknown) =>
      error instanceof MemoryPortError &&
      error.code === "MEMORY_SCOPE_MISMATCH",
  )
  assert.throws(() =>
    validateMemoryWriteRequest({ ...writeRequest(), memoryScope: "/" }),
  )
})

test("memory idempotency binds workspace/session/turn/position/output digest", () => {
  const first = computeMemoryIdempotencyKey(writeRequest())
  assert.match(first, /^de-task-state-v1:[a-f0-9]{64}$/)
  assert.equal(first, computeMemoryIdempotencyKey(writeRequest()))
  assert.notEqual(
    first,
    computeMemoryIdempotencyKey(
      writeRequest({ taskState: taskState({ terminalOutputDigest: DIGEST_B }) }),
    ),
  )
  assert.notEqual(
    first,
    computeMemoryIdempotencyKey(writeRequest({ turnId: "turn-002" })),
  )
  assert.notEqual(
    first,
    computeMemoryIdempotencyKey(
      writeRequest({
        workspaceInstanceId: "33333333-3333-4333-8333-333333333333",
      }),
    ),
  )
})

test("memory-recall.v1 validates exact bounded untrusted items", () => {
  const recall: MemoryRecall = {
    schemaVersion: MEMORY_RECALL_SCHEMA_VERSION,
    workspaceInstanceId: "11111111-1111-4111-8111-111111111111",
    sessionId: "22222222-2222-4222-8222-222222222222",
    positionId: "repo-owner",
    principal: "position.repo-owner",
    retrievedAt: "2026-08-24T10:01:00.000Z",
    items: [
      {
        memoryId: "44444444-4444-4444-8444-444444444444",
        kind: "task_state",
        text: "untrusted recalled state",
        digest: "a".repeat(64),
        citation:
          "mem://memories/44444444-4444-4444-8444-444444444444",
        locator:
          "mem://memories/44444444-4444-4444-8444-444444444444@1",
        stateVersion: 1,
        recordedAt: "2026-08-24T10:00:00.000Z",
        provenance: {
          sourceType: "agent",
          sourceRef: "digital-employee://task-state.v1",
          producerAgent: "digital-employee",
          producerSession: "22222222-2222-4222-8222-222222222222",
          producerTask: "task-001",
        },
        trust: "untrusted",
        authority: "none",
      },
    ],
    warnings: [],
  }
  assert.deepEqual(validateMemoryRecall(recall), recall)
  assert.throws(() =>
    validateMemoryRecall({
      ...recall,
      items: [{ ...recall.items[0], authority: "admin" }],
    }),
  )
  assert.throws(() => validateMemoryRecall({ ...recall, token: "secret" }))
})

test("optional degraded recall is an explicit typed empty result", () => {
  const recall: MemoryRecall = {
    schemaVersion: MEMORY_RECALL_SCHEMA_VERSION,
    workspaceInstanceId: "11111111-1111-4111-8111-111111111111",
    sessionId: "22222222-2222-4222-8222-222222222222",
    positionId: "repo-owner",
    principal: "position.repo-owner",
    retrievedAt: "2026-08-24T10:01:00.000Z",
    items: [],
    warnings: [
      {
        code: "MEMORY_UNAVAILABLE",
        message: "Durable memory is temporarily unavailable.",
        retryable: true,
      },
    ],
  }
  assert.deepEqual(validateMemoryRecall(recall), recall)
})
