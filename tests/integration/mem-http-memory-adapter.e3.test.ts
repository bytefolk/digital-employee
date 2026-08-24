import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"

import { createMemHttpMemoryAdapter } from "../../packages/core/src/mem-http-memory-adapter.js"
import {
  MEMORY_WRITE_REQUEST_SCHEMA_VERSION,
  TASK_STATE_SCHEMA_VERSION,
  MemoryPortError,
  computeMemoryIdempotencyKey,
} from "../../packages/core/src/memory-port.js"
import type {
  MemoryRecallRequest,
  MemoryWriteRequest,
} from "../../packages/core/src/memory-port.js"

const runE3 = process.env.MEMORY_E3_RUN === "1"
const baseUrl = process.env.MEMORY_E3_BASE_URL ?? ""
const tokenEnv = "MEM_E3_REPO_OWNER_TOKEN"
const scope = "/DigitalEmployees/repo-owner"
const principal = "position.repo-owner"

interface HttpResult {
  status: number
  body: Record<string, unknown>
}

async function httpJson(
  path: string,
  options: {
    method?: string
    token?: string
    workspaceId?: string
    body?: unknown
    idempotencyKey?: string
  } = {},
): Promise<HttpResult> {
  const headers = new Headers({ Accept: "application/json" })
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`)
  if (options.workspaceId) headers.set("X-Workspace-ID", options.workspaceId)
  if (options.body !== undefined) headers.set("Content-Type", "application/json")
  if (options.idempotencyKey) {
    headers.set("Idempotency-Key", options.idempotencyKey)
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  const raw = await response.text()
  let body: unknown = {}
  try {
    body = raw === "" ? {} : (JSON.parse(raw) as unknown)
  } catch {
    throw new Error(`mem E3 returned non-JSON with status ${response.status}`)
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`mem E3 returned a non-object with status ${response.status}`)
  }
  return { status: response.status, body: body as Record<string, unknown> }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`mem E3 omitted ${label}`)
  }
  return value
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("expected the memory operation to reject")
}

function request(
  workspaceInstanceId: string,
  sessionId: string,
  turnId: string,
  taskId: string,
  digestByte: string,
): MemoryWriteRequest {
  return {
    schemaVersion: MEMORY_WRITE_REQUEST_SCHEMA_VERSION,
    workspaceInstanceId,
    sessionId,
    turnId,
    positionId: "repo-owner",
    principal,
    memoryScope: scope,
    taskState: {
      schemaVersion: TASK_STATE_SCHEMA_VERSION,
      taskId,
      status: "completed",
      summary: `Reviewed state for ${taskId}.`,
      terminalOutputDigest: `sha256:${digestByte.repeat(64)}`,
      recordedAt: "2026-08-24T10:00:00Z",
    },
  }
}

function recallRequest(
  workspaceInstanceId: string,
  sessionId: string,
): MemoryRecallRequest {
  return {
    workspaceInstanceId,
    sessionId,
    positionId: "repo-owner",
    principal,
    memoryScope: scope,
    mode: "required",
    limit: 10,
  }
}

test(
  "actual loopback mem/PostgreSQL E3 covers scoped write, replay, denial and lifecycle",
  { skip: !runE3 },
  async (t) => {
    assert.match(baseUrl, /^http:\/\/(?:127\.0\.0\.1|localhost):[0-9]+$/)

    const registration = await httpJson("/v1/auth/register", {
      method: "POST",
      body: {
        email: `memory-adapter-${randomUUID()}@example.invalid`,
        password: `e3-${randomUUID()}`,
      },
    })
    assert.equal(registration.status, 201)
    const adminToken = requiredString(registration.body.token, "session token")

    const current = await httpJson("/v1/workspaces/current", {
      token: adminToken,
    })
    assert.equal(current.status, 200)
    const memWorkspaceId = requiredString(current.body.id, "workspace id")

    async function createPositionToken(expiresIn = "30m") {
      const response = await httpJson("/v1/auth/tokens", {
        method: "POST",
        token: adminToken,
        workspaceId: memWorkspaceId,
        body: {
          name: `position-repo-owner-${randomUUID()}`,
          scopes: ["read", "write"],
          paths: [scope],
          expires_in: expiresIn,
        },
      })
      assert.equal(response.status, 201)
      assert.deepEqual(response.body.scopes, ["read", "write"])
      assert.deepEqual(response.body.paths, [scope])
      return {
        id: requiredString(response.body.id, "token id"),
        token: requiredString(response.body.token, "position token"),
      }
    }

    async function grant(memoryId: string) {
      const response = await httpJson("/v1/durable-context/grants", {
        method: "POST",
        token: adminToken,
        workspaceId: memWorkspaceId,
        body: { principal, memory_id: memoryId },
      })
      assert.equal(response.status, 201)
      return requiredString(response.body.id, "grant id")
    }

    const workspaceInstanceId = randomUUID()
    const sessionId = randomUUID()
    let positionToken = await createPositionToken()
    process.env[tokenEnv] = positionToken.token
    t.after(() => {
      delete process.env[tokenEnv]
    })

    const memory = createMemHttpMemoryAdapter({
      baseUrl,
      memWorkspaceId,
      workspaceInstanceId,
      positionId: "repo-owner",
      memoryScope: scope,
      tokenEnv,
    })
    const firstRequest = request(
      workspaceInstanceId,
      sessionId,
      "turn-001",
      "task-001",
      "a",
    )

    const missingGrant = await captureRejection(
      memory.recall(recallRequest(workspaceInstanceId, sessionId)),
    )
    assert.ok(missingGrant instanceof MemoryPortError)
    assert.equal(missingGrant.code, "MEMORY_DENIED")

    const first = await memory.writeTaskState(firstRequest)
    assert.equal(first.replayed, false)
    assert.deepEqual(first.readBack, firstRequest.taskState)
    const replay = await memory.writeTaskState(firstRequest)
    assert.equal(replay.replayed, true)
    assert.equal(replay.memoryId, first.memoryId)

    const conflict = await httpJson("/v1/memories", {
      method: "POST",
      token: positionToken.token,
      workspaceId: memWorkspaceId,
      idempotencyKey: computeMemoryIdempotencyKey(firstRequest),
      body: {
        kind: "task_state",
        content: "changed payload",
        path: scope,
        source: { type: "agent" },
      },
    })
    assert.equal(conflict.status, 409)
    assert.equal(conflict.body.error, "idempotency_conflict")

    const outside = await httpJson("/v1/memories", {
      method: "POST",
      token: adminToken,
      workspaceId: memWorkspaceId,
      idempotencyKey: `outside-${randomUUID()}`,
      body: {
        kind: "note",
        content: "outside scope fixture",
        path: "/Outside",
        source: { type: "user" },
      },
    })
    assert.equal(outside.status, 201)
    const outsideMemory = outside.body.memory as Record<string, unknown>
    const outsideMemoryId = requiredString(outsideMemory.id, "outside memory id")
    const outsideRead = await httpJson(`/v1/memories/${outsideMemoryId}`, {
      token: positionToken.token,
      workspaceId: memWorkspaceId,
    })
    assert.equal(outsideRead.status, 404)

    const selfGrant = await httpJson("/v1/durable-context/grants", {
      method: "POST",
      token: positionToken.token,
      workspaceId: memWorkspaceId,
      body: { principal, memory_id: first.memoryId },
    })
    assert.equal(selfGrant.status, 403)

    process.env[tokenEnv] = adminToken
    const rootClaim = await captureRejection(
      memory.recall(recallRequest(workspaceInstanceId, sessionId)),
    )
    assert.ok(rootClaim instanceof MemoryPortError)
    assert.equal(rootClaim.code, "MEMORY_DENIED")
    process.env[tokenEnv] = positionToken.token

    const firstGrantId = await grant(first.memoryId)
    let recalled = await memory.recall(
      recallRequest(workspaceInstanceId, randomUUID()),
    )
    assert.deepEqual(recalled.items.map((item) => item.memoryId), [first.memoryId])
    assert.ok(recalled.items.every((item) => item.authority === "none"))

    const secondRequest = request(
      workspaceInstanceId,
      sessionId,
      "turn-002",
      "task-002",
      "b",
    )
    const second = await memory.writeTaskState(secondRequest)
    await grant(second.memoryId)

    const revokeGrant = await httpJson(
      `/v1/durable-context/grants/${firstGrantId}/revoke`,
      {
        method: "POST",
        token: adminToken,
        workspaceId: memWorkspaceId,
      },
    )
    assert.equal(revokeGrant.status, 200)
    recalled = await memory.recall(recallRequest(workspaceInstanceId, randomUUID()))
    assert.deepEqual(recalled.items.map((item) => item.memoryId), [second.memoryId])
    await grant(first.memoryId)

    const archive = await httpJson(`/v1/memories/${first.memoryId}/archive`, {
      method: "POST",
      token: adminToken,
      workspaceId: memWorkspaceId,
      idempotencyKey: `archive-${randomUUID()}`,
      body: { expected_version: 1 },
    })
    assert.equal(archive.status, 201)
    recalled = await memory.recall(recallRequest(workspaceInstanceId, randomUUID()))
    assert.deepEqual(recalled.items.map((item) => item.memoryId), [second.memoryId])

    const forget = await httpJson(`/v1/memories/${first.memoryId}/forget`, {
      method: "POST",
      token: adminToken,
      workspaceId: memWorkspaceId,
      idempotencyKey: `forget-${randomUUID()}`,
      body: { expected_version: 2, reason: "user_request" },
    })
    assert.equal(forget.status, 201)
    recalled = await memory.recall(recallRequest(workspaceInstanceId, randomUUID()))
    assert.deepEqual(recalled.items.map((item) => item.memoryId), [second.memoryId])

    const revokeToken = await httpJson(`/v1/auth/tokens/${positionToken.id}`, {
      method: "DELETE",
      token: adminToken,
      workspaceId: memWorkspaceId,
    })
    assert.equal(revokeToken.status, 204)
    const revoked = await captureRejection(
      memory.recall(recallRequest(workspaceInstanceId, randomUUID())),
    )
    assert.ok(revoked instanceof MemoryPortError)
    assert.equal(revoked.code, "MEMORY_DENIED")

    positionToken = await createPositionToken()
    process.env[tokenEnv] = positionToken.token
    recalled = await memory.recall(recallRequest(workspaceInstanceId, randomUUID()))
    assert.deepEqual(recalled.items.map((item) => item.memoryId), [second.memoryId])

    const expiring = await createPositionToken("10ms")
    process.env[tokenEnv] = expiring.token
    await new Promise((resolve) => setTimeout(resolve, 30))
    const expired = await captureRejection(
      memory.recall(recallRequest(workspaceInstanceId, randomUUID())),
    )
    assert.ok(expired instanceof MemoryPortError)
    assert.equal(expired.code, "MEMORY_DENIED")
  },
)
