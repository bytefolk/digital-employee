import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { AddressInfo } from "node:net"
import test from "node:test"

import { runTurn } from "../../apps/cli/turn/turn-run.js"
import {
  computeEnvelopeDigest,
  TURN_ENVELOPE_VERSION,
} from "../../apps/cli/turn/envelope.js"
import {
  deriveMemorySessionId,
  resolveWorkspaceMemory,
  WorkspaceMemoryConfigError,
} from "../../apps/cli/turn/memory-config.js"
import {
  OSS_MAINTAINER_TEMPLATE,
  renderOrganizationFile,
  renderWorkspaceManifest,
} from "../../apps/cli/workspace/templates.js"
import { validateOrganizationDocument } from "../../apps/cli/org/budget.js"
import { deriveOrganizationPermissions } from "../../apps/cli/org/permissions.js"
import { MEM_DURABLE_CONTEXT_CONTRACT } from "../../packages/core/src/mem-http-memory-adapter.js"

const MEM_WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const WORKSPACE_INSTANCE = "11111111-1111-4111-8111-111111111111"
const TOKEN = "mem_test_sentinel_never_serialize"
const SCOPE = "/DigitalEmployees/repo-owner"
const PINNED_REVISION = "4c714aa352f79f0080a24904668210d6c445ba10"

interface SeenRequest {
  method: string
  url: string
  authorization: string
  body: string
}

async function createWorkspace(options: { enabled: boolean }): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "turn-memory-ws-"))
  const digests: Record<string, { name: string; version: string; digest: string }> = {}
  for (const role of OSS_MAINTAINER_TEMPLATE.roles) {
    digests[role.id] = {
      name: role.id,
      version: "0.1.0",
      digest: `sha256:${"a".repeat(64)}`,
    }
  }
  const organization = renderOrganizationFile(
    OSS_MAINTAINER_TEMPLATE,
    "memory-test",
    workspace,
    digests,
    "2026-08-24T00:00:00.000Z",
  )
  await writeFile(
    path.join(workspace, organization.portablePath),
    organization.content,
  )
  const validated = validateOrganizationDocument(
    JSON.parse(new TextDecoder().decode(organization.content)),
  )
  await mkdir(path.join(workspace, ".digital-employee"))
  await writeFile(
    path.join(workspace, ".digital-employee", "permissions.json"),
    `${JSON.stringify(deriveOrganizationPermissions(validated), null, 2)}\n`,
  )
  const manifest = JSON.parse(
    new TextDecoder().decode(
      renderWorkspaceManifest(
        OSS_MAINTAINER_TEMPLATE,
        "memory-test",
        "2026-08-24T00:00:00.000Z",
        WORKSPACE_INSTANCE,
      ).content,
    ),
  ) as Record<string, any>
  manifest.memory.enabled = options.enabled
  manifest.memory.mode = "required"
  await writeFile(
    path.join(workspace, "workspace.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  return workspace
}

function capabilities(): Record<string, unknown> {
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

function memoryWire(content: string, producerSession: string, producerTask: string) {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    workspace_id: MEM_WORKSPACE,
    kind: "task_state",
    content,
    attributes: {},
    path: SCOPE,
    source_type: "agent",
    source_ref: "digital-employee://task-state.v1",
    source_locator: {},
    producer_agent: "digital-employee",
    producer_session: producerSession,
    producer_task: producerTask,
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
  }
}

async function withMemServer(
  run: (baseUrl: string, seen: SeenRequest[]) => Promise<void>,
): Promise<void> {
  const seen: SeenRequest[] = []
  let written: ReturnType<typeof memoryWire> | undefined
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks).toString("utf8")
    seen.push({
      method: request.method ?? "",
      url: request.url ?? "",
      authorization: request.headers.authorization ?? "",
      body,
    })
    if (request.url === "/v1/version") {
      json(response, 200, { version: PINNED_REVISION })
    } else if (request.url === "/v1/capabilities") {
      json(response, 200, capabilities())
    } else if (request.url === "/v1/durable-context/recall") {
      json(response, 200, {
        contract: MEM_DURABLE_CONTEXT_CONTRACT,
        principal: "position.repo-owner",
        hits: [],
      })
    } else if (request.method === "POST" && request.url === "/v1/memories") {
      const parsed = JSON.parse(body) as {
        content: string
        producer: { session_id: string; task_id: string }
      }
      written = memoryWire(
        parsed.content,
        parsed.producer.session_id,
        parsed.producer.task_id,
      )
      json(response, 201, { memory: written, replayed: false })
    } else if (
      request.method === "GET" &&
      request.url?.startsWith(`/v1/memories/${written?.id ?? "missing"}?`)
    ) {
      assert.ok(written)
      json(response, 200, {
        ...written,
        citation: `mem://memories/${written.id}`,
        provenance: {
          workspace_id: MEM_WORKSPACE,
          source_type: "agent",
          source_ref: "digital-employee://task-state.v1",
          source_locator: {},
          producer_agent: "digital-employee",
          producer_session: written.producer_session,
          producer_task: written.producer_task,
        },
      })
    } else {
      json(response, 404, { error: "not_found" })
    }
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

function envelope(workspace: string): string {
  const body = {
    schemaVersion: TURN_ENVELOPE_VERSION,
    workspaceRef: workspace,
    positionId: "repo-owner",
    turnId: "turn-memory-1",
    conversationRef: "conversation-memory-1",
    input: "Use durable memory before answering.",
    budget: { maxIterations: 1 },
  }
  return JSON.stringify({ ...body, envelopeDigest: computeEnvelopeDigest(body) })
}

const memoryEnv = (baseUrl: string): NodeJS.ProcessEnv => ({
  MEM_HTTP_BASE_URL: baseUrl,
  MEM_HTTP_WORKSPACE_ID: MEM_WORKSPACE,
  MEM_HTTP_PINNED_REVISION: PINNED_REVISION,
  MEM_REPO_OWNER_SCOPE: SCOPE,
  MEM_REPO_OWNER_TOKEN: TOKEN,
})

test("workspace memory config is disabled by default and reports why", async () => {
  const workspace = await createWorkspace({ enabled: false })
  try {
    const result = await resolveWorkspaceMemory({
      workspace,
      positionId: "repo-owner",
      turnId: "turn-1",
      env: {},
    })
    assert.deepEqual(result, {
      status: "disabled",
      reason: "disabled_by_config",
    })
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test("enabled workspace config derives stable session identity and fails closed on missing env", async () => {
  const workspace = await createWorkspace({ enabled: true })
  try {
    await assert.rejects(
      resolveWorkspaceMemory({
        workspace,
        positionId: "repo-owner",
        conversationRef: "conversation-1",
        turnId: "turn-1",
        env: {},
      }),
      (error: unknown) =>
        error instanceof WorkspaceMemoryConfigError &&
        error.code === "workspace_memory_base_url_not_configured",
    )
    await withMemServer(async (baseUrl) => {
      const first = await resolveWorkspaceMemory({
        workspace,
        positionId: "repo-owner",
        conversationRef: "conversation-1",
        turnId: "turn-1",
        env: memoryEnv(baseUrl),
      })
      const second = await resolveWorkspaceMemory({
        workspace,
        positionId: "repo-owner",
        conversationRef: "conversation-1",
        turnId: "turn-2",
        env: memoryEnv(baseUrl),
      })
      assert.equal(first.status, "enabled")
      assert.equal(second.status, "enabled")
      assert.equal(first.sessionId, second.sessionId)
      assert.equal(
        first.sessionId,
        deriveMemorySessionId(WORKSPACE_INSTANCE, "repo-owner", "conversation-1"),
      )
      assert.notEqual(first.taskId, second.taskId)
      assert.equal(first.memoryScope, SCOPE)
      assert.equal(first.mode, "required")
    })
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test("turn run recalls and persists bounded task state from workspace config", async () => {
  const workspace = await createWorkspace({ enabled: true })
  try {
    await withMemServer(async (baseUrl, seen) => {
      const events: Array<Record<string, unknown>> = []
      const diagnostics: string[] = []
      const result = await runTurn({
        workspace,
        positionId: "repo-owner",
        envelopeText: envelope(workspace),
        env: memoryEnv(baseUrl),
        model: {
          async complete() {
            return { text: "completed with durable memory" }
          },
        },
        writeEvent: (line) => events.push(JSON.parse(line)),
        writeDiagnostic: (line) => diagnostics.push(line),
      })
      assert.deepEqual(result, { exitCode: 0, terminalEmitted: true })
      assert.ok(diagnostics.some((line) => line.includes("memory enabled")))
      assert.equal(
        seen.filter((request) => request.url === "/v1/durable-context/recall").length,
        1,
      )
      assert.equal(
        seen.filter((request) => request.method === "POST" && request.url === "/v1/memories").length,
        1,
      )
      assert.equal(
        seen.filter((request) => request.method === "GET" && request.url.includes("/v1/memories/")).length,
        1,
      )
      const writeRequest = JSON.parse(
        seen.find((request) => request.url === "/v1/memories")!.body,
      ) as Record<string, any>
      assert.equal(writeRequest.kind, "task_state")
      assert.equal(writeRequest.path, SCOPE)
      assert.equal(writeRequest.source.type, "agent")
      assert.equal(writeRequest.producer.agent_id, "digital-employee")
      const taskState = JSON.parse(writeRequest.content) as Record<string, string>
      assert.match(taskState.taskId, /^turn-[0-9a-f]{32}$/)
      assert.equal(taskState.summary, "Digital Employee turn completed.")
      assert.match(taskState.terminalOutputDigest, /^sha256:[0-9a-f]{64}$/)
      assert.ok(
        events.some(
          (event) =>
            event.type === "run.completed" &&
            event.output === "completed with durable memory",
        ),
      )
      assert.equal(
        seen.every((request) =>
          !request.body.includes(TOKEN),
        ),
        true,
      )
    })
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
