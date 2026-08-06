import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, writeFile } from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { createBuiltInAgentHostRegistry } from "../../apps/cli/agent-host-registry.js"
import { createExternalStdioHostRegistration } from "../../apps/cli/stdio-agent-host.js"
import { runEmployeePackage } from "../../apps/cli/agent-run.js"
import { REAL_LOCAL_STDIO_HOST_ID } from "../../apps/cli/real-local-stdio-host.js"
import {
  AGENT_HOST_STDIO_CONFIG_SCHEMA_VERSION,
  validateStdioAdapterConfig,
} from "../../packages/core/src/agent-host-stdio-config.js"
import { REAL_LOCAL_CODES } from "../../packages/core/src/component-matrix.js"

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
)
const distHostScript = path.join(
  packageRoot,
  "dist",
  "apps",
  "cli",
  "real-local-stdio-host.js",
)
const useDistHost = existsSync(distHostScript)
const hostExecutable = useDistHost
  ? process.execPath
  : path.join(packageRoot, "node_modules", ".bin", "tsx")
const hostScript = useDistHost
  ? distHostScript
  : path.join(packageRoot, "apps", "cli", "real-local-stdio-host.ts")
const recipeDirectory = path.join(packageRoot, "recipes", "real-local-context")
const employeeDirectory = path.join(recipeDirectory, "employee")
const matrixPath = path.join(recipeDirectory, "component-matrix.json")
const executableDigest = createHash("sha256")
  .update(readFileSync(hostExecutable))
  .digest("hex")

const WORKSPACE = "11111111-1111-4111-8111-111111111111"
const MEM_TOKEN = "fake-mem-token"
const DOC_TOKEN = "fake-doc-token"
const DOCUMENT_ID = "doc-runbook"
const DOC_ETAG = "abcdef1234567890"
const MEM_LOCATOR = `mem://memories/22222222-2222-4222-8222-222222222222@3`

const HOST_ENV = [
  "REAL_LOCAL_MATRIX",
  "REAL_LOCAL_GRANT",
  "REAL_LOCAL_PRINCIPAL",
  "REAL_LOCAL_WORKSPACE",
  "REAL_LOCAL_SESSION_REF",
  "REAL_MEM_BASE_URL",
  "REAL_MEM_TOKEN",
  "REAL_DOC_BASE_URL",
  "REAL_DOC_TOKEN",
  "REAL_DOC_DOCUMENT_ID",
  "REAL_DOC_EXPECTED_ETAG",
] as const

interface FakeService {
  baseUrl: string
  close: () => Promise<void>
}

async function listen(handler: http.RequestListener): Promise<FakeService> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as { port: number }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/** Deterministic loopback stand-in for the pinned memd durable-context API. */
async function fakeMem(): Promise<FakeService> {
  return listen((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/durable-context/recall") {
      response.writeHead(404).end()
      return
    }
    let body = ""
    request.on("data", (chunk) => (body += chunk))
    request.on("end", () => {
      const parsed = JSON.parse(body) as { contract?: string; principal?: string }
      if (
        request.headers.authorization !== `Bearer ${MEM_TOKEN}` ||
        request.headers["x-workspace-id"] !== WORKSPACE
      ) {
        response.writeHead(401, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: "invalid_token" }))
        return
      }
      if (parsed.contract !== "durable-context.v1") {
        response.writeHead(400, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: "contract_unsupported" }))
        return
      }
      if (parsed.principal !== "alice") {
        response.writeHead(403, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: "context_scope_denied" }))
        return
      }
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          contract: "durable-context.v1",
          principal: "alice",
          hits: [{ locator: MEM_LOCATOR, state_version: 3 }],
        }),
      )
    })
  })
}

/** Deterministic loopback stand-in for the pinned doc bearer API. */
async function fakeDoc(): Promise<FakeService> {
  return listen((request, response) => {
    if (request.method !== "GET" || request.url !== `/api/v1/documents/${DOCUMENT_ID}`) {
      response.writeHead(404, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { code: "document_not_found" } }))
      return
    }
    const authorization = request.headers.authorization
    if (authorization === "Bearer invalid") {
      response.writeHead(401, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { code: "invalid_token" } }))
      return
    }
    if (authorization !== `Bearer ${DOC_TOKEN}`) {
      // Non-enumeration: a foreign token sees 404, never 403.
      response.writeHead(404, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { code: "document_not_found" } }))
      return
    }
    response.writeHead(200, {
      "content-type": "application/json",
      etag: `"${DOC_ETAG}"`,
    })
    response.end(JSON.stringify({ id: DOCUMENT_ID, title: "pinned runbook" }))
  })
}

function adapterConfig() {
  return validateStdioAdapterConfig({
    schema: AGENT_HOST_STDIO_CONFIG_SCHEMA_VERSION,
    hostId: REAL_LOCAL_STDIO_HOST_ID,
    displayName: "Real Local Stdio Host",
    executable: hostExecutable,
    args: [hostScript],
    digest: { algorithm: "sha256", hex: executableDigest },
    envAllowlist: ["PATH", ...HOST_ENV],
    workingDirectoryPolicy: "request",
    timeoutMs: 30_000,
    maxStderrBytes: 16_384,
  })
}

async function grantFile(scopes: Array<{ principal: string; workspace: string }>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "real-local-grant-"))
  const grantPath = path.join(directory, "grant.json")
  await writeFile(
    grantPath,
    JSON.stringify({
      schemaVersion: "capability-grant.v1",
      grantedBy: "operator",
      grants: [
        { server: "real-mem", mode: "read", scopes },
        { server: "real-doc", mode: "read", scopes },
      ],
    }),
  )
  return grantPath
}

async function withEnv(
  env: Record<string, string | undefined>,
  body: () => Promise<void>,
): Promise<void> {
  const previous: Record<string, string | undefined> = {}
  for (const name of HOST_ENV) {
    previous[name] = process.env[name]
    if (env[name] === undefined) delete process.env[name]
    else process.env[name] = env[name]
  }
  try {
    await body()
  } finally {
    for (const name of HOST_ENV) {
      if (previous[name] === undefined) delete process.env[name]
      else process.env[name] = previous[name]
    }
  }
}

async function runOnce() {
  const registry = createBuiltInAgentHostRegistry().register(
    createExternalStdioHostRegistration(adapterConfig()),
  )
  return runEmployeePackage({
    directory: employeeDirectory,
    engine: REAL_LOCAL_STDIO_HOST_ID,
    hostRegistry: registry,
    input: { message: "resume approved context" },
  })
}

async function baseEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    REAL_LOCAL_MATRIX: matrixPath,
    REAL_LOCAL_GRANT: await grantFile([
      { principal: "alice", workspace: WORKSPACE },
      { principal: "mallory", workspace: WORKSPACE },
    ]),
    REAL_LOCAL_PRINCIPAL: "alice",
    REAL_LOCAL_WORKSPACE: WORKSPACE,
    REAL_MEM_TOKEN: MEM_TOKEN,
    REAL_DOC_TOKEN: DOC_TOKEN,
    REAL_DOC_DOCUMENT_ID: DOCUMENT_ID,
    REAL_DOC_EXPECTED_ETAG: DOC_ETAG,
    ...overrides,
  }
}

async function expectFailure(
  env: Record<string, string | undefined>,
  code: string,
): Promise<void> {
  await withEnv(env, async () => {
    const result = await runOnce()
    assert.equal(result.status, "failed", JSON.stringify(result))
    if (result.status !== "failed") return
    assert.equal(result.error.code, code)
  })
}

test("a granted run resumes real-service context with pinned locators", async () => {
  const mem = await fakeMem()
  const doc = await fakeDoc()
  try {
    await withEnv(
      await baseEnv({
        REAL_MEM_BASE_URL: mem.baseUrl,
        REAL_DOC_BASE_URL: doc.baseUrl,
      }),
      async () => {
        const result = await runOnce()
        assert.equal(result.status, "completed", JSON.stringify(result))
        if (result.status !== "completed") return
        const output = result.output as {
          citations: Array<{ uri: string }>
        }
        const uris = output.citations.map((citation) => citation.uri)
        assert.ok(uris.includes(MEM_LOCATOR))
        assert.ok(uris.includes(`doc://${DOCUMENT_ID}@${DOC_ETAG}`))
      },
    )
  } finally {
    await mem.close()
    await doc.close()
  }
})

test("service-side principal denial maps to real_local_scope_denied", async () => {
  const mem = await fakeMem()
  const doc = await fakeDoc()
  try {
    await expectFailure(
      await baseEnv({
        REAL_MEM_BASE_URL: mem.baseUrl,
        REAL_DOC_BASE_URL: doc.baseUrl,
        REAL_LOCAL_PRINCIPAL: "mallory",
      }),
      REAL_LOCAL_CODES.scopeDenied,
    )
  } finally {
    await mem.close()
    await doc.close()
  }
})

test("a principal outside the operator grant is denied locally", async () => {
  const mem = await fakeMem()
  const doc = await fakeDoc()
  try {
    await expectFailure(
      await baseEnv({
        REAL_MEM_BASE_URL: mem.baseUrl,
        REAL_DOC_BASE_URL: doc.baseUrl,
        REAL_LOCAL_GRANT: await grantFile([
          { principal: "alice", workspace: WORKSPACE },
        ]),
        REAL_LOCAL_PRINCIPAL: "mallory",
      }),
      REAL_LOCAL_CODES.scopeDenied,
    )
  } finally {
    await mem.close()
    await doc.close()
  }
})

test("a pinned revision mismatch fails closed", async () => {
  const mem = await fakeMem()
  const doc = await fakeDoc()
  try {
    await expectFailure(
      await baseEnv({
        REAL_MEM_BASE_URL: mem.baseUrl,
        REAL_DOC_BASE_URL: doc.baseUrl,
        REAL_DOC_EXPECTED_ETAG: "0000000000000000",
      }),
      REAL_LOCAL_CODES.revisionMismatch,
    )
  } finally {
    await mem.close()
    await doc.close()
  }
})

test("revoked or unlisted documents fail closed as unavailable", async () => {
  const mem = await fakeMem()
  const doc = await fakeDoc()
  try {
    await expectFailure(
      await baseEnv({
        REAL_MEM_BASE_URL: mem.baseUrl,
        REAL_DOC_BASE_URL: doc.baseUrl,
        REAL_DOC_TOKEN: "outsider-token",
      }),
      REAL_LOCAL_CODES.itemUnavailable,
    )
  } finally {
    await mem.close()
    await doc.close()
  }
})

test("an unreachable service degrades explicitly", async () => {
  const doc = await fakeDoc()
  try {
    await expectFailure(
      await baseEnv({
        REAL_MEM_BASE_URL: "http://127.0.0.1:9",
        REAL_DOC_BASE_URL: doc.baseUrl,
      }),
      REAL_LOCAL_CODES.serviceUnavailable,
    )
  } finally {
    await doc.close()
  }
})

test("a non-loopback service URL is refused before any call", async () => {
  const doc = await fakeDoc()
  try {
    await expectFailure(
      await baseEnv({
        REAL_MEM_BASE_URL: "http://198.51.100.10:8080",
        REAL_DOC_BASE_URL: doc.baseUrl,
      }),
      REAL_LOCAL_CODES.serviceUnavailable,
    )
  } finally {
    await doc.close()
  }
})

test("an unsupported component matrix fails explicitly", async () => {
  const mem = await fakeMem()
  const doc = await fakeDoc()
  const directory = await mkdtemp(path.join(os.tmpdir(), "real-local-matrix-"))
  const badMatrix = path.join(directory, "matrix.json")
  await writeFile(badMatrix, JSON.stringify({ schema: "component-matrix.v2", components: [] }))
  try {
    await expectFailure(
      await baseEnv({
        REAL_MEM_BASE_URL: mem.baseUrl,
        REAL_DOC_BASE_URL: doc.baseUrl,
        REAL_LOCAL_MATRIX: badMatrix,
      }),
      REAL_LOCAL_CODES.matrixUnsupported,
    )
  } finally {
    await mem.close()
    await doc.close()
  }
})

test("a redirecting service is refused instead of followed", async () => {
  const redirecting = await listen((request, response) => {
    void request
    response.writeHead(307, { location: "http://198.51.100.10/steal" })
    response.end()
  })
  const doc = await fakeDoc()
  try {
    await expectFailure(
      await baseEnv({
        REAL_MEM_BASE_URL: redirecting.baseUrl,
        REAL_DOC_BASE_URL: doc.baseUrl,
      }),
      REAL_LOCAL_CODES.serviceUnavailable,
    )
  } finally {
    await redirecting.close()
    await doc.close()
  }
})

test("a structurally invalid grant file maps to grant_invalid", async () => {
  const mem = await fakeMem()
  const doc = await fakeDoc()
  const directory = await mkdtemp(path.join(os.tmpdir(), "real-local-grant-bad-"))
  const badGrant = path.join(directory, "grant.json")
  await writeFile(badGrant, JSON.stringify([{ server: "real-mem" }]))
  try {
    await expectFailure(
      await baseEnv({
        REAL_MEM_BASE_URL: mem.baseUrl,
        REAL_DOC_BASE_URL: doc.baseUrl,
        REAL_LOCAL_GRANT: badGrant,
      }),
      REAL_LOCAL_CODES.grantInvalid,
    )
  } finally {
    await mem.close()
    await doc.close()
  }
})
