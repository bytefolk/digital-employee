#!/usr/bin/env node
// Real-local Phase A harness for issue #42 (AC-001 + AC-004 phase scope).
//
// Single documented command (credential-free, loopback-only):
//   MEM_REPO_DIR=../mem DOC_REPO_DIR=../doc node ./scripts/real-local-harness.mjs
//
// Starts the pinned mem and doc services, seeds deterministic synthetic
// state, drives one neutral employee package through the public Adapter/MCP
// boundary for every scenario in recipes/real-local-context/scenarios.json,
// emits machine-readable `real-local-e2e` evidence, verifies no secret leaks
// into the evidence, and tears everything down. `--keep` skips teardown.

import { createHash, randomUUID } from "node:crypto"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const keep = process.argv.includes("--keep")
const memRepo = path.resolve(repoRoot, process.env.MEM_REPO_DIR ?? "../mem")
const docRepo = path.resolve(repoRoot, process.env.DOC_REPO_DIR ?? "../doc")
const recipeDir = path.join(repoRoot, "recipes", "real-local-context")
const matrixPath = path.join(recipeDir, "component-matrix.json")
const workDir = path.join(tmpdir(), `real-local-${process.pid}`)
mkdirSync(workDir, { recursive: true })

const secrets = new Set()
const cleanups = []
let memdChild = null
let cleanedUp = false

function runCleanups() {
  if (cleanedUp || keep) return
  cleanedUp = true
  for (const cleanup of [...cleanups].reverse()) {
    try {
      cleanup()
    } catch {
      // teardown is best-effort; the compose project is isolated
    }
  }
}
process.on("exit", runCleanups)

function log(text) {
  process.stderr.write(`==> ${text}\n`)
}

function fail(message) {
  process.stderr.write(`ERROR: ${message}\n`)
  process.exitCode = 1
  throw new Error(message)
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim()
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(label, probe, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await probe()) return
    } catch {
      // keep polling
    }
    await delay(1000)
  }
  fail(`${label} did not become healthy in time`)
}

async function httpJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(20_000),
  })
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = undefined
  }
  return { status: response.status, headers: response.headers, body }
}

// --- 1. Matrix is the sole version authority -------------------------------

const { validateComponentMatrix, requireMatrixComponent } = await import(
  path.join(repoRoot, "dist/packages/core/src/component-matrix.js")
)
const matrix = validateComponentMatrix(JSON.parse(readFileSync(matrixPath, "utf8")))
const memPin = requireMatrixComponent(matrix, "mem", "durable-context.v1")
const docPin = requireMatrixComponent(matrix, "doc", "doc-api.v1")

function assertPinnedCheckout(repoDir, pin) {
  if (!existsSync(repoDir)) {
    fail(`unsupported matrix: ${pin.name} checkout is missing at ${repoDir}`)
  }
  const head = run("git", ["-C", repoDir, "rev-parse", "HEAD"])
  if (head !== pin.commit) {
    fail(
      `unsupported matrix: ${pin.name} checkout is at ${head}, matrix pins ${pin.commit}`,
    )
  }
}

log(`matrix ok: mem@${memPin.commit.slice(0, 7)} doc@${docPin.commit.slice(0, 7)}`)
assertPinnedCheckout(memRepo, memPin)
assertPinnedCheckout(docRepo, docPin)

// --- 2. Start pinned mem ----------------------------------------------------

const memProject = `mem-real-local-${process.pid}`
const memPgPort = memPin.ports.postgres
const memHttpPort = memPin.ports.http
const memS3Port = memPin.ports.s3
const memBaseUrl = `http://127.0.0.1:${memHttpPort}`
const memDbName = "mem_real_local_test"

function memCompose(args) {
  return run("docker", ["compose", "-p", memProject, "-f",
    path.join(memRepo, "docker-compose.test.yml"), "--profile", "e2e", ...args], {
    env: {
      ...process.env,
      MEM_TEST_PROJECT: memProject,
      MEM_TEST_PG_PORT: String(memPgPort),
      MEM_TEST_S3_PORT: String(memS3Port),
      MEM_TEST_DB_NAME: memDbName,
    },
  })
}

log("starting mem postgres and minio (isolated compose project)")
cleanups.push(() => memCompose(["down", "-v"]))
memCompose(["up", "-d", "--wait", "postgres", "minio"])
memCompose(["run", "--rm", "minio-init"])

log("building and starting pinned memd")
run("go", ["build", "-trimpath", "-o", path.join(workDir, "memd"), "./cmd/memd"], {
  cwd: path.join(memRepo, "server"),
})
const memdLog = path.join(workDir, "memd.log")
memdChild = spawn(path.join(workDir, "memd"), [], {
  env: {
    PATH: process.env.PATH,
    MEM_HTTP_ADDR: `127.0.0.1:${memHttpPort}`,
    MEM_DB_URL: `postgres://mem:mem@127.0.0.1:${memPgPort}/${memDbName}?sslmode=disable`,
    MEM_REDIS_URL: "",
    MEM_S3_ENDPOINT: `http://127.0.0.1:${memS3Port}`,
    MEM_S3_BUCKET: "mem",
    MEM_S3_ACCESS_KEY: "mem",
    MEM_S3_SECRET_KEY: "mem-minio-password",
    MEM_S3_USE_SSL: "false",
    MEM_WORKER_GRPC: "127.0.0.1:1",
    MEM_REGISTRATION_MODE: "open",
    MEM_SESSION_TTL: "30m",
  },
  stdio: ["ignore", "ignore", "pipe"],
})
{
  const chunks = []
  memdChild.stderr.on("data", (chunk) => chunks.push(chunk))
  memdChild.on("exit", () => writeFileSync(memdLog, Buffer.concat(chunks)))
}
cleanups.push(() => {
  if (memdChild && memdChild.exitCode === null) memdChild.kill("SIGKILL")
})
await waitFor("memd", async () => {
  if (memdChild.exitCode !== null) {
    fail(`memd exited early; diagnostics in ${memdLog}`)
  }
  const { status } = await httpJson(`${memBaseUrl}${memPin.healthEndpoint}`)
  return status === 200
})

// --- 3. Seed mem: users, tokens, memories, durable-context grants ----------

async function memRegister(email) {
  const { status, body } = await httpJson(`${memBaseUrl}/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "real-local-password" }),
  })
  if (status !== 200 && status !== 201) fail(`mem register failed: ${status}`)
  secrets.add(body.token)
  const workspace = await httpJson(`${memBaseUrl}/v1/workspaces/current`, {
    headers: { Authorization: `Bearer ${body.token}` },
  })
  const agent = await httpJson(`${memBaseUrl}/v1/auth/tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${body.token}`,
      "X-Workspace-ID": workspace.body.id,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "real-local-agent",
      scopes: ["read", "write", "delete", "admin"],
      paths: ["/Context"],
    }),
  })
  if (agent.status !== 200 && agent.status !== 201) {
    fail(`mem agent token failed: ${agent.status}`)
  }
  secrets.add(agent.body.token)
  return {
    sessionToken: body.token,
    workspaceId: workspace.body.id,
    agentToken: agent.body.token,
  }
}

function memHeaders(tenant) {
  return {
    Authorization: `Bearer ${tenant.agentToken}`,
    "X-Workspace-ID": tenant.workspaceId,
    "Content-Type": "application/json",
  }
}

async function memRemember(tenant, key, content) {
  const { status, body } = await httpJson(`${memBaseUrl}/v1/memories`, {
    method: "POST",
    headers: { ...memHeaders(tenant), "Idempotency-Key": key },
    body: JSON.stringify({
      kind: "task_state",
      content,
      path: "/Context",
      source: { type: "agent" },
    }),
  })
  if (status !== 200 && status !== 201) fail(`mem remember ${key} failed: ${status}`)
  return body.memory
}

async function memLifecycle(tenant, memoryId, action, extra = {}) {
  const current = await httpJson(`${memBaseUrl}/v1/memories/${memoryId}`, {
    headers: memHeaders(tenant),
  })
  const { status } = await httpJson(`${memBaseUrl}/v1/memories/${memoryId}/${action}`, {
    method: "POST",
    headers: { ...memHeaders(tenant), "Idempotency-Key": `${action}-${memoryId}` },
    body: JSON.stringify({
      expected_version: current.body.memory?.state_version ?? current.body.state_version,
      ...extra,
    }),
  })
  if (status < 200 || status >= 300) fail(`mem ${action} failed: ${status}`)
}

async function memGrant(tenant, principal, memoryId) {
  const { status } = await httpJson(`${memBaseUrl}/v1/durable-context/grants`, {
    method: "POST",
    headers: memHeaders(tenant),
    body: JSON.stringify({ principal, memory_id: memoryId }),
  })
  if (status !== 200 && status !== 201) fail(`mem grant failed: ${status}`)
}

log("seeding mem tenants and memories")
const tenantA = await memRegister(`real-local-a-${process.pid}@example.invalid`)
const tenantB = await memRegister(`real-local-b-${process.pid}@example.invalid`)
const active1 = await memRemember(tenantA, "active-1", "approved onboarding context")
const active2 = await memRemember(tenantA, "active-2", "approved runbook context")
const superseded = await memRemember(tenantA, "superseded", "old roadmap")
const forgotten = await memRemember(tenantA, "forgotten", "sensitive scratch note")
const unapproved = await memRemember(tenantA, "unapproved", "never granted draft")
for (const memoryRecord of [active1, active2, superseded, forgotten]) {
  await memGrant(tenantA, "alice", memoryRecord.id)
}
await memLifecycle(tenantA, superseded.id, "archive")
await memLifecycle(tenantA, forgotten.id, "forget", { reason: "sensitive" })

// --- 4. Start pinned doc and seed one document ------------------------------

const docBaseUrl = `http://localhost:${docPin.ports.web}`
const mailpitBaseUrl = `http://127.0.0.1:${docPin.ports["mailpit-ui"]}`

async function docHealthy() {
  const { status, body } = await httpJson(`${docBaseUrl}/api/health`)
  return status === 200 && body?.service === "doc-web"
}

let docStartedByHarness = false
if (await docHealthy().catch(() => false)) {
  log("doc stack is already running; reusing it (will not tear it down)")
} else {
  log("starting pinned doc stack (this builds containers on first run)")
  if (!existsSync(path.join(docRepo, "node_modules"))) {
    run("npm", ["ci"], { cwd: docRepo, stdio: ["ignore", "ignore", "pipe"] })
  }
  if (!existsSync(path.join(docRepo, ".env"))) {
    run("npm", ["run", "doc", "--", "init"], { cwd: docRepo })
  }
  execFileSync("npm", ["run", "doc", "--", "up", "--build"], {
    cwd: docRepo,
    stdio: ["ignore", "inherit", "inherit"],
  })
  docStartedByHarness = true
  cleanups.push(() => {
    run("docker", ["compose", "down"], { cwd: docRepo })
  })
}
await waitFor("doc web", docHealthy, 600_000)

class DocSession {
  constructor(email) {
    this.email = email
    this.cookies = new Map()
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ")
  }
  remember(response) {
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(";", 1)[0]
      const separator = pair.indexOf("=")
      if (separator > 0) this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1))
    }
  }
  async fetch(pathname, options = {}) {
    const headers = new Headers(options.headers)
    if (this.header()) headers.set("cookie", this.header())
    const response = await fetch(`${docBaseUrl}${pathname}`, { ...options, headers })
    this.remember(response)
    return response
  }
}

function collectStrings(value, output = []) {
  if (typeof value === "string") output.push(value)
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, output))
  else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => collectStrings(item, output))
  }
  return output
}

async function docSignIn(email) {
  const session = new DocSession(email)
  const before = new Set(
    ((await httpJson(`${mailpitBaseUrl}/api/v1/messages?limit=100`)).body?.messages ?? []).map(
      (message) => String(message?.ID ?? ""),
    ),
  )
  const csrf = await (await session.fetch("/api/auth/csrf")).json()
  const signin = await session.fetch("/api/auth/signin/nodemailer", {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-auth-return-redirect": "1",
    },
    body: new URLSearchParams({
      csrfToken: csrf.csrfToken,
      email,
      callbackUrl: `${docBaseUrl}/`,
    }),
  })
  if (signin.status >= 400) fail(`doc sign-in returned ${signin.status}`)
  let callbackPath = null
  await waitFor(`magic link for ${email}`, async () => {
    const { body } = await httpJson(`${mailpitBaseUrl}/api/v1/messages?limit=100`)
    const message = (body?.messages ?? []).find(
      (candidate) =>
        !before.has(String(candidate?.ID ?? "")) &&
        JSON.stringify(candidate?.To ?? []).toLowerCase().includes(email.toLowerCase()),
    )
    if (!message) return false
    const detail = await httpJson(
      `${mailpitBaseUrl}/api/v1/message/${encodeURIComponent(String(message.ID))}`,
    )
    const content = collectStrings(detail.body)
      .join("\n")
      .replaceAll("&amp;", "&")
      .replaceAll("&quot;", '"')
    const match = content.match(
      /https?:\/\/[^\s"'<>]+\/api\/auth\/callback\/(?:nodemailer|resend)[^\s"'<>]*/i,
    )
    if (!match) return false
    const url = new URL(match[0])
    callbackPath = `${url.pathname}${url.search}`
    return true
  }, 60_000)
  const callback = await session.fetch(callbackPath, { redirect: "manual" })
  if (callback.status >= 400) fail(`doc auth callback returned ${callback.status}`)
  return session
}

async function docCreatePat(session, scopes) {
  const response = await session.fetch("/api/personal-access-tokens", {
    method: "POST",
    headers: { "content-type": "application/json", origin: docBaseUrl },
    body: JSON.stringify({ name: `real-local-${randomUUID().slice(0, 8)}`, scopes, expiresInDays: 1 }),
  })
  if (response.status !== 200 && response.status !== 201) {
    fail(`doc PAT creation returned ${response.status}`)
  }
  const body = await response.json()
  const token = body.token ?? body?.data?.token
  if (typeof token !== "string") fail("doc PAT creation did not return a token")
  secrets.add(token)
  return token
}

log("seeding doc users, tokens and one pinned document")
const ownerSession = await docSignIn(`real-local-owner-${process.pid}@example.test`)
const ownerPat = await docCreatePat(ownerSession, ["documents:read", "documents:write"])
const outsiderSession = await docSignIn(`real-local-outsider-${process.pid}@example.test`)
const outsiderPat = await docCreatePat(outsiderSession, ["documents:read"])

const createdDoc = await httpJson(`${docBaseUrl}/api/v1/documents`, {
  method: "POST",
  headers: { Authorization: `Bearer ${ownerPat}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    title: "real-local pinned runbook",
    content: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "approved runbook body" }] },
      ],
    },
  }),
})
if (createdDoc.status !== 201) fail(`doc create returned ${createdDoc.status}`)
const documentId = createdDoc.body?.data?.id
if (typeof documentId !== "string" || documentId === "") {
  fail("doc create did not return a document id")
}
const docRead = await httpJson(
  `${docBaseUrl}/api/v1/documents/${encodeURIComponent(documentId)}`,
  { headers: { Authorization: `Bearer ${ownerPat}` } },
)
if (docRead.status !== 200) fail(`doc read-back returned ${docRead.status}`)
const pinnedEtag = (docRead.headers.get("etag") ?? "").replace(/^W\//, "").replace(/"/g, "")
if (!pinnedEtag) fail("doc read-back did not return an ETag")

// --- 5. Drive scenarios through the public Adapter/MCP boundary -------------

const { createBuiltInAgentHostRegistry } = await import(
  path.join(repoRoot, "dist/apps/cli/agent-host-registry.js")
)
const { createExternalStdioHostRegistration } = await import(
  path.join(repoRoot, "dist/apps/cli/stdio-agent-host.js")
)
const { runEmployeePackage } = await import(path.join(repoRoot, "dist/apps/cli/agent-run.js"))
const { validateStdioAdapterConfig, AGENT_HOST_STDIO_CONFIG_SCHEMA_VERSION } = await import(
  path.join(repoRoot, "dist/packages/core/src/agent-host-stdio-config.js")
)
const hostScript = path.join(repoRoot, "dist/apps/cli/real-local-stdio-host.js")
if (!existsSync(hostScript)) fail("dist build is missing; run `npm run build` first")

const hostEnvNames = [
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
]

function writeGrant(fileName, scopes) {
  const template = JSON.parse(readFileSync(path.join(recipeDir, "grant.template.json"), "utf8"))
  for (const grant of template.grants) grant.scopes = scopes
  const grantPath = path.join(workDir, fileName)
  writeFileSync(grantPath, JSON.stringify(template, null, 2))
  return grantPath
}

const grantAlice = writeGrant("grant-alice.json", [
  { principal: "alice", workspace: tenantA.workspaceId },
  { principal: "mallory", workspace: tenantA.workspaceId },
])
const grantWorkspaceB = writeGrant("grant-ws-b.json", [
  { principal: "alice", workspace: tenantB.workspaceId },
])
const badMatrixPath = path.join(workDir, "bad-matrix.json")
writeFileSync(badMatrixPath, JSON.stringify({ schema: "component-matrix.v2", components: [] }))

const hostDigest = createHash("sha256").update(readFileSync(process.execPath)).digest("hex")
const adapterConfig = validateStdioAdapterConfig({
  schema: AGENT_HOST_STDIO_CONFIG_SCHEMA_VERSION,
  hostId: "real-local-stdio-host",
  displayName: "Real Local Stdio Host",
  executable: process.execPath,
  args: [hostScript],
  digest: { algorithm: "sha256", hex: hostDigest },
  envAllowlist: ["PATH", ...hostEnvNames],
  workingDirectoryPolicy: "request",
  timeoutMs: 60_000,
  maxStderrBytes: 16_384,
})

const baseEnv = {
  REAL_LOCAL_MATRIX: matrixPath,
  REAL_LOCAL_GRANT: grantAlice,
  REAL_LOCAL_PRINCIPAL: "alice",
  REAL_LOCAL_WORKSPACE: tenantA.workspaceId,
  REAL_MEM_BASE_URL: memBaseUrl,
  REAL_MEM_TOKEN: tenantA.agentToken,
  REAL_DOC_BASE_URL: docBaseUrl,
  REAL_DOC_TOKEN: ownerPat,
  REAL_DOC_DOCUMENT_ID: documentId,
  REAL_DOC_EXPECTED_ETAG: pinnedEtag,
}

async function runScenario(overrides) {
  const env = { ...baseEnv, ...overrides }
  const saved = {}
  for (const name of hostEnvNames) {
    saved[name] = process.env[name]
    if (env[name] === undefined) delete process.env[name]
    else process.env[name] = env[name]
  }
  try {
    const registry = createBuiltInAgentHostRegistry().register(
      createExternalStdioHostRegistration(adapterConfig),
    )
    return await runEmployeePackage({
      directory: path.join(recipeDir, "employee"),
      engine: "real-local-stdio-host",
      hostRegistry: registry,
      input: { message: "resume approved context" },
    })
  } finally {
    for (const name of hostEnvNames) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
  }
}

const scenarios = JSON.parse(readFileSync(path.join(recipeDir, "scenarios.json"), "utf8"))
const results = []
let sessionOneLocators = null

function record(id, expected, actual, passed, detail) {
  results.push({ id, expected, actual, passed, ...(detail ? { detail } : {}) })
  log(`${passed ? "PASS" : "FAIL"} ${id} (${actual})`)
}

for (const scenario of scenarios.cases) {
  const overrides = {}
  if (scenario.sessionRef) overrides.REAL_LOCAL_SESSION_REF = scenario.sessionRef
  if (scenario.principal) overrides.REAL_LOCAL_PRINCIPAL = scenario.principal
  if (scenario.workspace === "other") {
    overrides.REAL_LOCAL_WORKSPACE = tenantB.workspaceId
    overrides.REAL_MEM_TOKEN = tenantB.agentToken
    overrides.REAL_LOCAL_GRANT = grantWorkspaceB
  }
  if (scenario.docExpectedEtag) overrides.REAL_DOC_EXPECTED_ETAG = scenario.docExpectedEtag
  if (scenario.docToken === "invalid") overrides.REAL_DOC_TOKEN = "doc_pat_invalid_token_value"
  if (scenario.docToken === "outsider") overrides.REAL_DOC_TOKEN = outsiderPat
  if (scenario.memBaseUrl) overrides.REAL_MEM_BASE_URL = scenario.memBaseUrl
  if (scenario.matrix === "unsupported") overrides.REAL_LOCAL_MATRIX = badMatrixPath

  const result = await runScenario(overrides)
  if (scenario.expect === "completed") {
    if (result.status !== "completed") {
      record(scenario.id, "completed", result.status, false, result.error?.code)
      continue
    }
    const uris = (result.output?.citations ?? []).map((citation) => citation.uri)
    const memLocators = uris.filter((uri) => uri.startsWith("mem://")).sort()
    const mustInclude = [active1.id, active2.id]
    const mustExclude = [superseded.id, forgotten.id, unapproved.id]
    const includesActive = mustInclude.every((id) => memLocators.some((uri) => uri.includes(id)))
    const excludesDenied = mustExclude.every((id) => !uris.some((uri) => uri.includes(id)))
    const docPinned = uris.includes(`doc://${documentId}@${pinnedEtag}`)
    const stableAcrossSessions =
      scenario.id !== "granted_recall_session_2" ||
      JSON.stringify(memLocators) === JSON.stringify(sessionOneLocators)
    if (scenario.id === "granted_recall_session_1") sessionOneLocators = memLocators
    const passed = includesActive && excludesDenied && docPinned && stableAcrossSessions
    record(scenario.id, "completed", "completed", passed, {
      memLocators,
      docPinned,
      excludesDenied,
      stableAcrossSessions,
    })
  } else {
    const actual = result.status === "failed" ? result.error?.code : result.status
    record(scenario.id, scenario.expectCode, actual, actual === scenario.expectCode)
  }
}

// --- 6. Evidence, secret scan, teardown -------------------------------------

const evidence = {
  schema: "real-local-evidence.v1",
  class: "real-local-e2e",
  generatedAt: new Date().toISOString(),
  matrix: {
    digest: createHash("sha256").update(readFileSync(matrixPath)).digest("hex"),
    mem: memPin.commit,
    doc: docPin.commit,
  },
  cases: results,
  passed: results.every((result) => result.passed),
}
const serialized = JSON.stringify(evidence, null, 2)
for (const secret of secrets) {
  if (secret && serialized.includes(secret)) {
    fail("secret scan failed: evidence contains a live token")
  }
}
if (/\/Users\/[a-z0-9_-]+\//i.test(serialized)) {
  fail("secret scan failed: evidence contains a private path")
}
const evidencePath = path.join(workDir, "real-local-evidence.json")
writeFileSync(evidencePath, serialized)
process.stdout.write(`${serialized}\n`)
log(`evidence written to ${evidencePath}`)

if (!keep) {
  log("tearing down")
  runCleanups()
  rmSync(path.join(workDir, "memd"), { force: true })
} else {
  log(`--keep: services left running, state in ${workDir}`)
}

if (!evidence.passed) {
  process.exitCode = 1
  log("one or more scenarios FAILED")
} else {
  log("all scenarios passed (real-local-e2e)")
}
