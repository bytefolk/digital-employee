import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"

import { buildQuestionEnvelope } from "../../apps/cli/turn/index.js"
import { deriveMemorySessionId, deriveMemoryTaskId } from "../../apps/cli/turn/memory-config.js"
import { TURN_ENGINE_MODEL_ENV, TURN_ENGINE_MODEL_SCRIPT_ENV } from "../../apps/cli/turn/envelope.js"
import { OSS_MAINTAINER_TEMPLATE, renderOrganizationFile, renderWorkspaceManifest } from "../../apps/cli/workspace/templates.js"
import { validateOrganizationDocument } from "../../apps/cli/org/budget.js"
import { deriveOrganizationPermissions } from "../../apps/cli/org/permissions.js"
import { digestOutputValue } from "../../packages/engine/src/turn-evidence.js"
import { memoryE3Configuration, verifyMemoryE3Artifact, verifyMemoryE3Version } from "./memory-e3-prerequisites.js"
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
const execFileAsync = promisify(execFile)

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
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
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
  "released loopback mem/PostgreSQL E3 covers configured CLI, adapter and lifecycle",
  { skip: !runE3, timeout: 120_000 },
  async (t) => {
    const config = memoryE3Configuration(process.env)
    const { pinnedRevision } = config
    await verifyMemoryE3Artifact(config)
    await access("dist/apps/cli/bin.js").catch(() => {
      throw new Error("MEMORY_E3_CLI_BUILD_REQUIRED")
    })
    const version = await httpJson("/v1/version")
    assert.equal(version.status, 200, "MEMORY_E3_VERSION_UNAVAILABLE")
    verifyMemoryE3Version(version.body, pinnedRevision)
    const ready = await httpJson("/readyz")
    assert.equal(ready.status, 200, "MEMORY_E3_SERVICE_NOT_READY")
    t.diagnostic(`artifact=${config.artifactUrl} sha256=${config.artifactSha256} serverVersion=${pinnedRevision}`)

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
    const previousToken = process.env[tokenEnv]
    process.env[tokenEnv] = positionToken.token
    t.after(() => {
      if (previousToken === undefined) delete process.env[tokenEnv]
      else process.env[tokenEnv] = previousToken
    })

    const memory = createMemHttpMemoryAdapter({
      baseUrl,
      memWorkspaceId,
      workspaceInstanceId,
      positionId: "repo-owner",
      memoryScope: scope,
      tokenEnv,
      pinnedRevision,
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

    // AC-001: invoke the built CLI with configuration only. The model is the
    // existing deterministic port; all memory requests still go to real mem.
    await mkdir(".cache", { recursive: true })
    const cliWorkspace = await mkdtemp(path.resolve(".cache/memory-cli-e3-"))
    t.after(() => rm(cliWorkspace, { recursive: true, force: true }))
    const roleDigests = Object.fromEntries(OSS_MAINTAINER_TEMPLATE.roles.map((role) => [
      role.id, { name: role.id, version: "0.1.0", digest: `sha256:${"a".repeat(64)}` },
    ]))
    const organization = renderOrganizationFile(
      OSS_MAINTAINER_TEMPLATE, "memory-e3", cliWorkspace, roleDigests, new Date().toISOString(),
    )
    await writeFile(path.join(cliWorkspace, organization.portablePath), organization.content)
    await mkdir(path.join(cliWorkspace, ".digital-employee"))
    await writeFile(path.join(cliWorkspace, ".digital-employee/permissions.json"), JSON.stringify(
      deriveOrganizationPermissions(validateOrganizationDocument(
        JSON.parse(new TextDecoder().decode(organization.content)),
      )),
    ))
    const manifest = JSON.parse(new TextDecoder().decode(renderWorkspaceManifest(
      OSS_MAINTAINER_TEMPLATE, "memory-e3", new Date().toISOString(), workspaceInstanceId,
    ).content))
    manifest.memory.enabled = true
    manifest.memory.mode = "required"
    await writeFile(path.join(cliWorkspace, "workspace.json"), JSON.stringify(manifest))
    const envelope = buildQuestionEnvelope({
      workspace: cliWorkspace, positionId: "repo-owner",
      question: "Complete the synthetic memory acceptance task.", turnId: "cli-memory-e3",
    })
    const envelopePath = path.join(cliWorkspace, "envelope.json")
    await writeFile(envelopePath, JSON.stringify(envelope))
    let stdout: string
    let stderr: string
    try {
      ({ stdout, stderr } = await execFileAsync(process.execPath, [
        path.resolve("dist/apps/cli/bin.js"), "turn", "run", cliWorkspace,
        "--position", "repo-owner", "--input-file", envelopePath,
      ], {
        env: {
          [TURN_ENGINE_MODEL_ENV]: "deterministic",
          [TURN_ENGINE_MODEL_SCRIPT_ENV]: '["memory acceptance completed"]',
          MEM_HTTP_BASE_URL: baseUrl,
          MEM_HTTP_WORKSPACE_ID: memWorkspaceId,
          MEM_HTTP_PINNED_REVISION: pinnedRevision,
          MEM_REPO_OWNER_TOKEN: positionToken.token,
          MEM_REPO_OWNER_SCOPE: scope,
        },
        encoding: "utf8", timeout: 30_000, maxBuffer: 128 * 1024,
      }))
    } catch {
      // Never let execFile's error include raw transcripts, argv paths or tokens.
      throw new Error("MEMORY_E3_CLI_FAILED")
    }
    assert.ok(stderr.includes("memory enabled (adapter mem-http.v1)"), "MEMORY_E3_CLI_BINDING_MISSING")
    const events = stdout.trim().split("\n").map((line) => JSON.parse(line))
    const terminals = events.filter((event) => event.type === "run.completed" || event.type === "run.failed")
    assert.equal(terminals.length, 1)
    assert.equal(terminals[0].type, "run.completed", "MEMORY_E3_CLI_NOT_COMPLETED")
    const cliRequest: MemoryWriteRequest = {
      ...request(workspaceInstanceId, deriveMemorySessionId(workspaceInstanceId, "repo-owner"),
        "cli-memory-e3", deriveMemoryTaskId("cli-memory-e3"), "c"),
      taskState: {
        schemaVersion: TASK_STATE_SCHEMA_VERSION,
        taskId: deriveMemoryTaskId("cli-memory-e3"),
        status: "completed",
        summary: "Digital Employee turn completed.",
        terminalOutputDigest: `sha256:${digestOutputValue(terminals[0].output)}`,
        recordedAt: terminals[0].timestamp,
      },
    }
    // Replaying exactly the CLI write must find the already persisted record.
    // A lane which only made its own adapter write would get replayed=false.
    const cliWrite = await memory.writeTaskState(cliRequest)
    assert.equal(cliWrite.replayed, true, "MEMORY_E3_CLI_WRITE_NOT_FOUND")
    assert.deepEqual(cliWrite.readBack, cliRequest.taskState)
    await grant(cliWrite.memoryId)
    const cliRecall = await memory.recall(recallRequest(workspaceInstanceId, randomUUID()))
    assert.ok(cliRecall.items.some((item) => item.memoryId === cliWrite.memoryId),
      "MEMORY_E3_CLI_WRITE_NOT_RECALLED")
    t.diagnostic(`AC-001 CLI=PASS adapter=mem-http.v1 scope=${scope} recall=PASS writeReplay=PASS model=deterministic-fixture`)

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
