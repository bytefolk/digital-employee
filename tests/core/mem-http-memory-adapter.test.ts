import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import test from "node:test"

import {
  MEM_DURABLE_CONTEXT_CONTRACT,
  createMemHttpMemoryAdapter,
} from "../../packages/core/src/mem-http-memory-adapter.js"
import {
  MEMORY_WRITE_REQUEST_SCHEMA_VERSION,
  TASK_STATE_SCHEMA_VERSION,
  MemoryPortError,
} from "../../packages/core/src/memory-port.js"
import type {
  MemoryRecallRequest,
  MemoryWriteRequest,
} from "../../packages/core/src/memory-port.js"

const MEM_WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const WORKSPACE_INSTANCE = "11111111-1111-4111-8111-111111111111"
const SESSION = "22222222-2222-4222-8222-222222222222"
const MEMORY_ID = "33333333-3333-4333-8333-333333333333"
const TOKEN_ENV = "MEM_REPO_OWNER_TOKEN"
const TOKEN_SENTINEL = "mem_test_sentinel_never_serialize"
const SCOPE = "/DigitalEmployees/repo-owner"
const PINNED_REVISION = "4c714aa352f79f0080a24904668210d6c445ba10"

interface SeenRequest {
  method: string
  url: string
  authorization: string
  workspace: string
  body: string
  idempotencyKey: string
}

async function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8")
}

function taskContent(request: MemoryWriteRequest): string {
  return JSON.stringify(request.taskState)
}

function memoryWire(request: MemoryWriteRequest, overrides: Record<string, unknown> = {}) {
  const content = taskContent(request)
  return {
    id: MEMORY_ID,
    workspace_id: MEM_WORKSPACE,
    kind: "task_state",
    content,
    attributes: {},
    path: SCOPE,
    source_type: "agent",
    source_ref: "digital-employee://task-state.v1",
    source_locator: {},
    producer_agent: "digital-employee",
    producer_session: SESSION,
    producer_task: "task-001",
    content_sha256: createHash("sha256").update(content).digest("hex"),
    lifecycle_status: "active",
    state_version: 1,
    pinned: false,
    useful_count: 0,
    not_useful_count: 0,
    feedback_score: 0,
    feedback_count: 0,
    created_at: "2026-08-24T10:00:01Z",
    updated_at: "2026-08-24T10:00:01Z",
    ...overrides,
  }
}

function provenanceWire() {
  return {
    workspace_id: MEM_WORKSPACE,
    source_type: "agent",
    source_ref: "digital-employee://task-state.v1",
    source_locator: {},
    producer_agent: "digital-employee",
    producer_session: SESSION,
    producer_task: "task-001",
  }
}

function capabilitiesWire(overrides: Record<string, unknown> = {}) {
  return {
    deployment_mode: "private",
    registration_mode: "open",
    workspace: {
      id: MEM_WORKSPACE,
      name: "workspace",
      resource_owner_user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      role: "owner",
      created_at: "2026-08-24T09:00:00Z",
    },
    workspace_restore_modes: ["fresh", "merge_conservative"],
    workspace_bundle_schema_versions: [1, 2],
    features: {
      context: true,
      handoff: true,
      memory: true,
      ask: false,
      index_generation_status: true,
      index_generation_execution: false,
      workspace_export: true,
      workspace_import: true,
    },
    handoff_schema_versions: [1],
    permissions: {
      read: true,
      search: false,
      write: true,
      delete: false,
      provider_read: true,
      provider_modify: false,
      permissions_manage: false,
      workspace_export: false,
      workspace_import: false,
    },
    ...overrides,
  }
}

function writeRequest(): MemoryWriteRequest {
  return {
    schemaVersion: MEMORY_WRITE_REQUEST_SCHEMA_VERSION,
    workspaceInstanceId: WORKSPACE_INSTANCE,
    sessionId: SESSION,
    turnId: "turn-001",
    positionId: "repo-owner",
    principal: "position.repo-owner",
    memoryScope: SCOPE,
    taskState: {
      schemaVersion: TASK_STATE_SCHEMA_VERSION,
      taskId: "task-001",
      status: "completed",
      summary: "Reviewed terminal task state.",
      terminalOutputDigest: `sha256:${"d".repeat(64)}`,
      recordedAt: "2026-08-24T10:00:00Z",
    },
  }
}

function recallRequest(mode: "optional" | "required" = "required"): MemoryRecallRequest {
  return {
    workspaceInstanceId: WORKSPACE_INSTANCE,
    sessionId: SESSION,
    positionId: "repo-owner",
    principal: "position.repo-owner",
    memoryScope: SCOPE,
    mode,
    limit: 5,
  }
}

async function withMemServer(
  handler: (
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
    body: string,
  ) => void,
  run: (baseUrl: string, seen: SeenRequest[]) => Promise<void>,
): Promise<void> {
  const seen: SeenRequest[] = []
  const server = createServer(async (request, response) => {
    const body = await readBody(request)
    seen.push({
      method: request.method ?? "",
      url: request.url ?? "",
      authorization: request.headers.authorization ?? "",
      workspace: String(request.headers["x-workspace-id"] ?? ""),
      body,
      idempotencyKey: String(request.headers["idempotency-key"] ?? ""),
    })
    handler(request, response, body)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${address.port}`, seen)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}

function json(
  response: import("node:http").ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(value))
}

function adapter(baseUrl: string) {
  return createMemHttpMemoryAdapter({
    baseUrl,
    memWorkspaceId: MEM_WORKSPACE,
    workspaceInstanceId: WORKSPACE_INSTANCE,
    positionId: "repo-owner",
    memoryScope: SCOPE,
    tokenEnv: TOKEN_ENV,
    pinnedRevision: PINNED_REVISION,
  })
}

test.beforeEach(() => {
  process.env[TOKEN_ENV] = TOKEN_SENTINEL
})

test.afterEach(() => {
  delete process.env[TOKEN_ENV]
})

test("adapter pins the public mem revision and durable-context contract", () => {
  assert.equal(PINNED_REVISION.length, 40)
  assert.equal(MEM_DURABLE_CONTEXT_CONTRACT, "durable-context.v1")
})

test("configuration permits HTTP only on loopback and never accepts a token value", () => {
  assert.throws(() => adapter("http://mem.example.com"))
  assert.throws(() => adapter("http://user:secret@127.0.0.1:8787"))
  assert.throws(() =>
    createMemHttpMemoryAdapter({
      baseUrl: "https://mem.example.com/path",
      memWorkspaceId: MEM_WORKSPACE,
      workspaceInstanceId: WORKSPACE_INSTANCE,
      positionId: "repo-owner",
      memoryScope: SCOPE,
      tokenEnv: "token",
      pinnedRevision: PINNED_REVISION,
    }),
  )
})

test("missing env token fails before any HTTP request", async () => {
  delete process.env[TOKEN_ENV]
  await withMemServer(
    (_request, response) => json(response, 500, {}),
    async (baseUrl, seen) => {
      await assert.rejects(
        adapter(baseUrl).recall(recallRequest()),
        (error: unknown) =>
          error instanceof MemoryPortError &&
          error.code === "MEMORY_CONFIGURATION_INVALID",
      )
      assert.equal(seen.length, 0)
    },
  )
})

test("write performs pinned preflight, exact write and matching readback", async () => {
  const request = writeRequest()
  await withMemServer(
    (incoming, response, body) => {
      if (incoming.url === "/v1/version") {
        json(response, 200, { version: PINNED_REVISION })
      } else if (incoming.url === "/v1/capabilities") {
        json(response, 200, capabilitiesWire())
      } else if (incoming.method === "POST" && incoming.url === "/v1/memories") {
        const parsed = JSON.parse(body) as Record<string, unknown>
        assert.equal(parsed.kind, "task_state")
        assert.equal(parsed.content, taskContent(request))
        assert.equal(parsed.path, SCOPE)
        json(response, 201, { memory: memoryWire(request), replayed: false })
      } else if (
        incoming.method === "GET" &&
        incoming.url?.startsWith(`/v1/memories/${MEMORY_ID}?`)
      ) {
        json(response, 200, {
          ...memoryWire(request),
          citation: `mem://memories/${MEMORY_ID}`,
          provenance: provenanceWire(),
        })
      } else {
        json(response, 404, { error: "not_found", hint: "not found" })
      }
    },
    async (baseUrl, seen) => {
      const result = await adapter(baseUrl).writeTaskState(request)
      assert.equal(result.memoryId, MEMORY_ID)
      assert.equal(result.replayed, false)
      assert.deepEqual(result.readBack, request.taskState)
      assert.equal(seen.length, 4)
      assert.equal(seen[1]?.authorization, `Bearer ${TOKEN_SENTINEL}`)
      assert.equal(seen[1]?.workspace, MEM_WORKSPACE)
      assert.match(seen[2]?.idempotencyKey ?? "", /^de-task-state-v1:[a-f0-9]{64}$/)
      for (const entry of seen) {
        assert.doesNotMatch(entry.url, new RegExp(TOKEN_SENTINEL))
        assert.doesNotMatch(entry.body, new RegExp(TOKEN_SENTINEL))
      }
    },
  )
})

test("write rejects admin/root credentials before sending memory content", async () => {
  await withMemServer(
    (incoming, response) => {
      if (incoming.url === "/v1/version") {
        json(response, 200, { version: PINNED_REVISION })
      } else {
        json(response, 200, capabilitiesWire({
          permissions: {
            ...capabilitiesWire().permissions,
            permissions_manage: true,
          },
        }))
      }
    },
    async (baseUrl, seen) => {
      await assert.rejects(
        adapter(baseUrl).writeTaskState(writeRequest()),
        (error: unknown) =>
          error instanceof MemoryPortError && error.code === "MEMORY_DENIED",
      )
      assert.equal(seen.length, 2)
      assert.ok(seen.every((entry) => !entry.body.includes("Reviewed terminal")))
    },
  )
})

test("write rejects a changed-payload conflict with a stable typed error", async () => {
  await withMemServer(
    (incoming, response) => {
      if (incoming.url === "/v1/version") {
        json(response, 200, { version: PINNED_REVISION })
      } else if (incoming.url === "/v1/capabilities") {
        json(response, 200, capabilitiesWire())
      } else {
        json(response, 409, {
          error: "idempotency_conflict",
          hint: "different request",
        })
      }
    },
    async (baseUrl) => {
      await assert.rejects(
        adapter(baseUrl).writeTaskState(writeRequest()),
        (error: unknown) =>
          error instanceof MemoryPortError && error.code === "MEMORY_CONFLICT",
      )
    },
  )
})

test("write fails closed when readback content or scope does not match", async () => {
  const request = writeRequest()
  await withMemServer(
    (incoming, response) => {
      if (incoming.url === "/v1/version") {
        json(response, 200, { version: PINNED_REVISION })
      } else if (incoming.url === "/v1/capabilities") {
        json(response, 200, capabilitiesWire())
      } else if (incoming.method === "POST") {
        json(response, 201, { memory: memoryWire(request), replayed: false })
      } else {
        json(response, 200, {
          ...memoryWire(request, { path: "/Other" }),
          citation: `mem://memories/${MEMORY_ID}`,
          provenance: provenanceWire(),
        })
      }
    },
    async (baseUrl) => {
      await assert.rejects(
        adapter(baseUrl).writeTaskState(request),
        (error: unknown) =>
          error instanceof MemoryPortError &&
          error.code === "MEMORY_READBACK_MISMATCH",
      )
    },
  )
})

test("recall uses only the approved durable-context contract and projects untrusted data", async () => {
  const request = writeRequest()
  await withMemServer(
    (incoming, response, body) => {
      if (incoming.url === "/v1/version") {
        json(response, 200, { version: PINNED_REVISION })
      } else if (incoming.url === "/v1/capabilities") {
        json(response, 200, capabilitiesWire())
      } else {
        assert.equal(incoming.url, "/v1/durable-context/recall")
        assert.deepEqual(JSON.parse(body), {
          contract: MEM_DURABLE_CONTEXT_CONTRACT,
          principal: "position.repo-owner",
          session_ref: SESSION,
          limit: 5,
        })
        json(response, 200, {
          contract: MEM_DURABLE_CONTEXT_CONTRACT,
          principal: "position.repo-owner",
          hits: [
            {
              memory: memoryWire(request),
              locator: `mem://memories/${MEMORY_ID}@1`,
              state_version: 1,
              provenance: provenanceWire(),
            },
          ],
        })
      }
    },
    async (baseUrl) => {
      const result = await adapter(baseUrl).recall(recallRequest())
      assert.equal(result.items.length, 1)
      assert.equal(result.items[0]?.trust, "untrusted")
      assert.equal(result.items[0]?.authority, "none")
      assert.equal(result.items[0]?.text, taskContent(request))
      assert.deepEqual(result.warnings, [])
    },
  )
})

test("optional outage degrades to a typed empty warning; required mode fails", async () => {
  await withMemServer(
    (_incoming, response) =>
      json(response, 503, {
        error: "durable_context_disabled",
        hint: "disabled",
      }),
    async (baseUrl) => {
      const optional = await adapter(baseUrl).recall(recallRequest("optional"))
      assert.deepEqual(optional.items, [])
      assert.equal(optional.warnings[0]?.code, "MEMORY_UNAVAILABLE")
      await assert.rejects(
        adapter(baseUrl).recall(recallRequest("required")),
        (error: unknown) =>
          error instanceof MemoryPortError &&
          error.code === "MEMORY_UNAVAILABLE",
      )
    },
  )
})

test("unknown pinned-server response fields fail closed", async () => {
  await withMemServer(
    (incoming, response) => {
      if (incoming.url === "/v1/version") {
        json(response, 200, {
          version: PINNED_REVISION,
          unexpected: true,
        })
      } else {
        json(response, 500, {})
      }
    },
    async (baseUrl) => {
      await assert.rejects(
        adapter(baseUrl).recall(recallRequest()),
        (error: unknown) =>
          error instanceof MemoryPortError &&
          error.code === "MEMORY_CONTRACT_UNSUPPORTED",
      )
    },
  )
})

test("configured revision mismatch is a distinct fail-closed error", async () => {
  await withMemServer(
    (incoming, response) => {
      if (incoming.url === "/v1/version") {
        json(response, 200, { version: "different-revision" })
      } else {
        json(response, 500, {})
      }
    },
    async (baseUrl) => {
      await assert.rejects(
        adapter(baseUrl).recall(recallRequest()),
        (error: unknown) =>
          error instanceof MemoryPortError &&
          error.code === "MEMORY_REVISION_MISMATCH",
      )
    },
  )
})
