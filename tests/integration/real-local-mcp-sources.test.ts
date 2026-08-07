/**
 * Integration tests for the real-local mem/doc MCP source connectors (Issue #42, Phase A).
 *
 * These tests use a fake fetch to simulate the pinned service responses,
 * verifying the connector logic without requiring running services. The
 * evidence class is "real-local-e2e" — actual service runs are documented
 * separately in the harness runbook.
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  COMPONENT_MATRIX_SCHEMA_ID,
  REAL_LOCAL_CODES,
} from "../../packages/core/src/component-matrix.js"
import type { ComponentMatrix } from "../../packages/core/src/component-matrix.js"
import { CoreError } from "../../packages/core/src/contracts.js"
import type { CapabilityGrantSet } from "../../packages/core/src/mcp-conformance.js"
import { CAPABILITY_GRANT_SCHEMA_VERSION } from "../../packages/core/src/mcp-conformance.js"

import { MemKnowledgeSource, MEM_CONTRACT } from "../../connectors/sources/mem/index.js"
import { DocKnowledgeSource, DOC_CONTRACT } from "../../connectors/sources/doc/index.js"

// --- Fixtures ---

const MEM_COMMIT = "3335ebea211d7fb65a8ea0e5ea2285b2cbc2d0bd"
const DOC_COMMIT = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0"

function buildMatrix(): ComponentMatrix {
  return {
    schema: COMPONENT_MATRIX_SCHEMA_ID,
    components: [
      {
        name: "mem",
        repository: "https://github.com/fullstack-ai-infra/mem",
        commit: MEM_COMMIT,
        contract: MEM_CONTRACT,
        startCommand: "make test-env-up",
        healthEndpoint: "/v1/version",
        ports: { http: 8321 },
      },
      {
        name: "doc",
        repository: "https://github.com/fullstack-ai-infra/doc",
        commit: DOC_COMMIT,
        contract: DOC_CONTRACT,
        startCommand: "make test-env-up",
        healthEndpoint: "/v1/version",
        ports: { http: 8322 },
      },
    ],
  }
}

function buildGrants(): CapabilityGrantSet {
  return {
    schemaVersion: CAPABILITY_GRANT_SCHEMA_VERSION,
    grantedBy: "operator",
    grants: [
      {
        server: "mem",
        mode: "read",
        scopes: [{ principal: "alice", workspace: "ws-alpha" }],
        revoked: false,
      },
      {
        server: "doc",
        mode: "read",
        scopes: [{ principal: "alice", workspace: "ws-alpha" }],
        revoked: false,
      },
    ],
  }
}

function fakeFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof globalThis.fetch {
  return (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    return Promise.resolve(handler(url, init))
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

// --- MemKnowledgeSource tests ---

test("MemKnowledgeSource: health returns available when service responds 200", async () => {
  const source = new MemKnowledgeSource({
    matrix: buildMatrix(),
    grants: buildGrants(),
    principal: "alice",
    workspace: "ws-alpha",
    fetchImpl: fakeFetch(() => jsonResponse({ version: "1.2.3" })),
  })
  const result = await source.health()
  assert.equal(result.available, true)
  assert.equal(result.version, "1.2.3")
})

test("MemKnowledgeSource: health returns unavailable on network error", async () => {
  const source = new MemKnowledgeSource({
    matrix: buildMatrix(),
    grants: buildGrants(),
    principal: "alice",
    workspace: "ws-alpha",
    fetchImpl: fakeFetch(() => { throw new Error("ECONNREFUSED") }),
  })
  const result = await source.health()
  assert.equal(result.available, false)
  assert.match(result.error!, /ECONNREFUSED/)
})

test("MemKnowledgeSource: recall returns filtered active approved memories", async () => {
  const memories = [
    { id: "m1", revision: 2, state: "active", approved: true, text: "memory one" },
    { id: "m2", revision: 1, state: "superseded", approved: true, text: "old" },
    { id: "m3", revision: 1, state: "active", approved: false, text: "unapproved" },
    { id: "m4", revision: 3, state: "active", approved: true, text: "memory four" },
  ]

  const source = new MemKnowledgeSource({
    matrix: buildMatrix(),
    grants: buildGrants(),
    principal: "alice",
    workspace: "ws-alpha",
    fetchImpl: fakeFetch(() => jsonResponse({ memories })),
  })

  const items = await source.recall()
  assert.equal(items.length, 2)
  assert.equal(items[0].locator, "mem://ws-alpha/m1@2")
  assert.equal(items[0].text, "memory one")
  assert.equal(items[1].locator, "mem://ws-alpha/m4@3")
  assert.equal(items[1].text, "memory four")
})

test("MemKnowledgeSource: recall fails closed when grant is missing", async () => {
  const grants: CapabilityGrantSet = {
    ...buildGrants(),
    grants: buildGrants().grants.filter((g) => g.server !== "mem"),
  }

  const source = new MemKnowledgeSource({
    matrix: buildMatrix(),
    grants,
    principal: "alice",
    workspace: "ws-alpha",
    fetchImpl: fakeFetch(() => jsonResponse({ memories: [] })),
  })

  await assert.rejects(
    () => source.recall(),
    (error: unknown) =>
      error instanceof CoreError && error.code === REAL_LOCAL_CODES.grantMissing,
  )
})

test("MemKnowledgeSource: recall fails closed when grant is revoked", async () => {
  const grants: CapabilityGrantSet = {
    ...buildGrants(),
    grants: buildGrants().grants.map((g) =>
      g.server === "mem" ? { ...g, revoked: true } : g,
    ),
  }

  const source = new MemKnowledgeSource({
    matrix: buildMatrix(),
    grants,
    principal: "alice",
    workspace: "ws-alpha",
    fetchImpl: fakeFetch(() => jsonResponse({ memories: [] })),
  })

  await assert.rejects(
    () => source.recall(),
    (error: unknown) =>
      error instanceof CoreError && error.code === REAL_LOCAL_CODES.grantRevoked,
  )
})

test("MemKnowledgeSource: recall fails closed on scope mismatch", async () => {
  const source = new MemKnowledgeSource({
    matrix: buildMatrix(),
    grants: buildGrants(),
    principal: "bob",
    workspace: "ws-alpha",
    fetchImpl: fakeFetch(() => jsonResponse({ memories: [] })),
  })

  await assert.rejects(
    () => source.recall(),
    (error: unknown) =>
      error instanceof CoreError && error.code === REAL_LOCAL_CODES.scopeDenied,
  )
})

test("MemKnowledgeSource: recall fails closed on service unavailable", async () => {
  const source = new MemKnowledgeSource({
    matrix: buildMatrix(),
    grants: buildGrants(),
    principal: "alice",
    workspace: "ws-alpha",
    fetchImpl: fakeFetch(() => { throw new Error("connection reset") }),
  })

  await assert.rejects(
    () => source.recall(),
    (error: unknown) =>
      error instanceof CoreError &&
      error.code === REAL_LOCAL_CODES.serviceUnavailable,
  )
})

test("MemKnowledgeSource: construction fails on wrong contract", () => {
  const matrix: ComponentMatrix = {
    schema: COMPONENT_MATRIX_SCHEMA_ID,
    components: [
      {
        name: "mem",
        repository: "https://github.com/fullstack-ai-infra/mem",
        commit: MEM_COMMIT,
        contract: "wrong-contract.v2",
        startCommand: "make test-env-up",
        healthEndpoint: "/v1/version",
        ports: { http: 8321 },
      },
    ],
  }

  assert.throws(
    () =>
      new MemKnowledgeSource({
        matrix,
        grants: buildGrants(),
        principal: "alice",
        workspace: "ws-alpha",
      }),
    (error: unknown) =>
      error instanceof CoreError &&
      error.code === REAL_LOCAL_CODES.matrixUnsupported,
  )
})

// --- DocKnowledgeSource tests ---

test("DocKnowledgeSource: health returns available when service responds 200", async () => {
  const source = new DocKnowledgeSource({
    matrix: buildMatrix(),
    grants: buildGrants(),
    principal: "alice",
    workspace: "ws-alpha",
    fetchImpl: fakeFetch(() => jsonResponse({ version: "0.4.1" })),
  })
  const result = await source.health()
  assert.equal(result.available, true)
  assert.equal(result.version, "0.4.1")
})

test("DocKnowledgeSource: read returns document at exact revision", async () => {
  const doc = {
    id: "doc-abc",
    title: "Test Document",
    body: "Document content here.",
    revision: 5,
    listed: true,
    revoked: false,
  }

  const source = new DocKnowledgeSource({
    matrix: buildMatrix(),
    grants: buildGrants(),
    principal: "alice",
    workspace: "ws-alpha",
    fetchImpl: fakeFetch(() => jsonResponse(doc)),
  })

  const item = await source.read("doc-abc", 5)
  assert.equal(item.locator, "doc://ws-alpha/doc-abc@5")
  assert.equal(item.title, "Test Document")
  assert.equal(item.body, "Document content here.")
  assert.equal(item.revision, 5)
})

test("DocKnowledgeSource: read fails closed on 404 (unavailable)", async () => {
  const source = new DocKnowledgeSource({
    matrix: buildMatrix(),
    grants: buildGrants(),
    principal: "alice",
    workspace: "ws-alpha",
    fetchImpl: fakeFetch(() => new Response(null, { status: 404 })),
  })

  await assert.rejects(
    () => source.read("missing-doc", 1),
    (error: unknown) =>
      error instanceof CoreError &&
      error.code === REAL_LOCAL_CODES.itemUnavailable,
  )
})

test("DocKnowledgeSource: read fails closed on 410 (revoked)", async () => {
  const source = new DocKnowledgeSource({
    matrix: buildMatrix(),
    grants: buildGrants(),
    principal: "alice",
    workspace: "ws-alpha",
    fetchImpl: fakeFetch(() => new Response(null, { status: 410 })),
  })

  await assert.rejects(
    () => source.read("revoked-doc", 1),
    (error: unknown) =>
      error instanceof CoreError &&
      error.code === REAL_LOCAL_CODES.grantRevoked,
  )
})

test("DocKnowledgeSource: read fails closed on 409 (revision mismatch)", async () => {
  const source = new DocKnowledgeSource({
    matrix: buildMatrix(),
    grants: buildGrants(),
    principal: "alice",
    workspace: "ws-alpha",
    fetchImpl: fakeFetch(() => new Response(null, { status: 409 })),
  })

  await assert.rejects(
    () => source.read("doc-abc", 3),
    (error: unknown) =>
      error instanceof CoreError &&
      error.code === REAL_LOCAL_CODES.revisionMismatch,
  )
})

test("DocKnowledgeSource: read fails closed when grant missing", async () => {
  const grants: CapabilityGrantSet = {
    ...buildGrants(),
    grants: buildGrants().grants.filter((g) => g.server !== "doc"),
  }

  const source = new DocKnowledgeSource({
    matrix: buildMatrix(),
    grants,
    principal: "alice",
    workspace: "ws-alpha",
    fetchImpl: fakeFetch(() => jsonResponse({})),
  })

  await assert.rejects(
    () => source.read("doc-abc", 1),
    (error: unknown) =>
      error instanceof CoreError && error.code === REAL_LOCAL_CODES.grantMissing,
  )
})

test("DocKnowledgeSource: read fails closed on scope mismatch", async () => {
  const source = new DocKnowledgeSource({
    matrix: buildMatrix(),
    grants: buildGrants(),
    principal: "bob",
    workspace: "ws-alpha",
    fetchImpl: fakeFetch(() => jsonResponse({})),
  })

  await assert.rejects(
    () => source.read("doc-abc", 1),
    (error: unknown) =>
      error instanceof CoreError && error.code === REAL_LOCAL_CODES.scopeDenied,
  )
})

test("DocKnowledgeSource: read fails closed on service unavailable", async () => {
  const source = new DocKnowledgeSource({
    matrix: buildMatrix(),
    grants: buildGrants(),
    principal: "alice",
    workspace: "ws-alpha",
    fetchImpl: fakeFetch(() => { throw new Error("timeout") }),
  })

  await assert.rejects(
    () => source.read("doc-abc", 1),
    (error: unknown) =>
      error instanceof CoreError &&
      error.code === REAL_LOCAL_CODES.serviceUnavailable,
  )
})

test("DocKnowledgeSource: read fails closed on invalid revision input", async () => {
  const source = new DocKnowledgeSource({
    matrix: buildMatrix(),
    grants: buildGrants(),
    principal: "alice",
    workspace: "ws-alpha",
    fetchImpl: fakeFetch(() => jsonResponse({})),
  })

  await assert.rejects(
    () => source.read("doc-abc", 0),
    (error: unknown) =>
      error instanceof CoreError &&
      error.code === REAL_LOCAL_CODES.revisionMismatch,
  )
})

test("DocKnowledgeSource: read fails closed on revision mismatch in response body", async () => {
  const doc = {
    id: "doc-abc",
    title: "Title",
    body: "Body",
    revision: 7,
  }

  const source = new DocKnowledgeSource({
    matrix: buildMatrix(),
    grants: buildGrants(),
    principal: "alice",
    workspace: "ws-alpha",
    fetchImpl: fakeFetch(() => jsonResponse(doc)),
  })

  await assert.rejects(
    () => source.read("doc-abc", 5),
    (error: unknown) =>
      error instanceof CoreError &&
      error.code === REAL_LOCAL_CODES.revisionMismatch,
  )
})

test("DocKnowledgeSource: construction fails on wrong contract", () => {
  const matrix: ComponentMatrix = {
    schema: COMPONENT_MATRIX_SCHEMA_ID,
    components: [
      {
        name: "doc",
        repository: "https://github.com/fullstack-ai-infra/doc",
        commit: DOC_COMMIT,
        contract: "wrong-contract.v3",
        startCommand: "make test-env-up",
        healthEndpoint: "/v1/version",
        ports: { http: 8322 },
      },
    ],
  }

  assert.throws(
    () =>
      new DocKnowledgeSource({
        matrix,
        grants: buildGrants(),
        principal: "alice",
        workspace: "ws-alpha",
      }),
    (error: unknown) =>
      error instanceof CoreError &&
      error.code === REAL_LOCAL_CODES.matrixUnsupported,
  )
})
