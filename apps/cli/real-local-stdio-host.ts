import readline from "node:readline"
import { readFileSync } from "node:fs"

import {
  AGENT_HOST_PROTOCOL_VERSION,
  createUnknownAgentHostCapabilities,
} from "../../packages/core/src/agent-host.js"
import type { AgentHostProbeResult } from "../../packages/core/src/agent-host.js"
import {
  AGENT_HOST_STDIO_PROTOCOL_VERSION,
  encodeAgentHostStdioLine,
  parseAgentHostStdioRequest,
} from "../../packages/core/src/agent-host-stdio.js"
import type { AgentHostStdioRequest } from "../../packages/core/src/agent-host-stdio.js"
import {
  REAL_LOCAL_CODES,
  requireMatrixComponent,
  validateComponentMatrix,
} from "../../packages/core/src/component-matrix.js"
import { CoreError } from "../../packages/core/src/contracts.js"
import {
  MCP_CONFORMANCE_CODES,
  checkCapabilityGrant,
  loadCapabilityGrants,
} from "../../packages/core/src/mcp-conformance.js"

export const REAL_LOCAL_STDIO_HOST_ID = "real-local-stdio-host"

export const REAL_MEM_SERVER = "real-mem"
export const REAL_DOC_SERVER = "real-doc"

export const MEM_COMPONENT_CONTRACT = "durable-context.v1"
export const DOC_COMPONENT_CONTRACT = "doc-api.v1"

/**
 * Environment names this host may receive through the adapter allowlist. The
 * values are operator-owned wiring for the pinned local services; none of
 * them is a model credential and none may point at a non-loopback service.
 */
export const REAL_LOCAL_HOST_ENV = [
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

const FETCH_TIMEOUT_MS = 10_000

// The synthetic conformance codes are frozen for fixtures only; every grant
// decision surfaced by this host is remapped into the real_local_* namespace
// so real-service evidence can never be mistaken for synthetic evidence.
const GRANT_CODE_MAP: Record<string, string> = {
  [MCP_CONFORMANCE_CODES.grantMissing]: REAL_LOCAL_CODES.grantMissing,
  [MCP_CONFORMANCE_CODES.grantInvalid]: REAL_LOCAL_CODES.grantInvalid,
  [MCP_CONFORMANCE_CODES.selfGrantRejected]: REAL_LOCAL_CODES.selfGrantRejected,
  [MCP_CONFORMANCE_CODES.revoked]: REAL_LOCAL_CODES.grantRevoked,
  [MCP_CONFORMANCE_CODES.scopeDenied]: REAL_LOCAL_CODES.scopeDenied,
  [MCP_CONFORMANCE_CODES.modeExcessive]: REAL_LOCAL_CODES.modeExcessive,
  // A grant file that is not even a plain object fails schema validation
  // before the conformance codes apply; it is still an invalid grant.
  VALIDATION_ERROR: REAL_LOCAL_CODES.grantInvalid,
}

export function realLocalStdioProbe(): AgentHostProbeResult {
  const capabilities = createUnknownAgentHostCapabilities()
  capabilities.non_interactive_run = "supported"
  capabilities.event_stream = "supported"
  capabilities.tool_allowlist = "supported"
  capabilities.filesystem_scope = "supported"
  capabilities.network_policy = "supported"
  // MCP is only declared when the operator grant boundary is wired in;
  // without it the host stays MCP-unknown and fail-closed.
  if (process.env.REAL_LOCAL_GRANT !== undefined) {
    capabilities.mcp = "supported"
  }
  return {
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    hostId: REAL_LOCAL_STDIO_HOST_ID,
    displayName: "Real Local Stdio Host",
    status: "ready",
    available: true,
    adapterStatus: "runnable",
    version: "1.0.0",
    capabilities,
    // Verified by this repository's own suite (tests/apps/real-local-host);
    // the frozen compatibility rule blocks documentation-only declarations.
    capabilitySource: "conformance_test",
    issues: [],
  }
}

function write(message: unknown): void {
  process.stdout.write(`${encodeAgentHostStdioLine(message)}\n`)
}

function diagnostics(text: string): void {
  process.stderr.write(`[real-local-stdio-host] ${text}\n`.slice(0, 512))
}

function successResponse(id: string, result?: unknown): void {
  write({
    protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
    id,
    kind: "response",
    ok: true,
    ...(result === undefined ? {} : { result }),
  })
}

function errorResponse(id: string, code: string): void {
  write({
    protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
    id,
    kind: "response",
    ok: false,
    error: { code, message: "real local host refused the request", retryable: false },
  })
}

function event(id: string, runId: string, body: Record<string, unknown>): void {
  write({
    protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
    id,
    kind: "event",
    event: { runId, timestamp: new Date().toISOString(), ...body },
  })
}

function realLocalError(code: string, message: string): CoreError {
  return new CoreError(code, message, { status: 400, retryable: false })
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (typeof value !== "string" || value.trim() === "") {
    throw realLocalError(
      REAL_LOCAL_CODES.serviceUnavailable,
      `${name} is not configured`,
    )
  }
  return value.trim()
}

function requireLoopbackBaseUrl(name: string): string {
  const value = requiredEnv(name)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw realLocalError(
      REAL_LOCAL_CODES.serviceUnavailable,
      `${name} is not a valid URL`,
    )
  }
  const loopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname === "localhost"
  if (url.protocol !== "http:" || !loopback) {
    // Phase A is local-only by design; anything non-loopback is refused so a
    // misconfigured harness can never call out to a remote service.
    throw realLocalError(
      REAL_LOCAL_CODES.serviceUnavailable,
      `${name} must be a loopback http URL`,
    )
  }
  return value.replace(/\/$/, "")
}

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<{ status: number; etag: string | null; body: unknown }> {
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      // A redirect could bounce the request off the loopback boundary; the
      // pinned local services never redirect, so refuse instead of following.
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch {
    throw realLocalError(
      REAL_LOCAL_CODES.serviceUnavailable,
      "local service is unreachable",
    )
  }
  let body: unknown = undefined
  const text = await response.text()
  if (text.length > 0) {
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
  }
  return { status: response.status, etag: response.headers.get("etag"), body }
}

interface RealRunPayload {
  runId: string
  mcpServers?: Array<{ name: string }>
  policy?: { tools?: { allow?: Array<{ name: string; mode: string }> } }
  workingDirectory?: string
  outputSchema?: unknown
}

function assertMatrixSupports(wantsMem: boolean, wantsDoc: boolean): void {
  const raw = readMatrixFile(requiredEnv("REAL_LOCAL_MATRIX"))
  const matrix = validateComponentMatrix(raw)
  if (wantsMem) requireMatrixComponent(matrix, "mem", MEM_COMPONENT_CONTRACT)
  if (wantsDoc) requireMatrixComponent(matrix, "doc", DOC_COMPONENT_CONTRACT)
}

function readMatrixFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    throw realLocalError(
      REAL_LOCAL_CODES.matrixUnsupported,
      "component matrix is missing or unreadable",
    )
  }
}

function checkGrantOrRemap(options: {
  grantPath: string
  workingDirectory: string | undefined
  server: string
  principal: string
  workspace: string
  requestedMode: "read" | "write"
}): void {
  try {
    const grants = loadCapabilityGrants(options.grantPath, options.workingDirectory)
    checkCapabilityGrant({
      grants,
      server: options.server,
      principal: options.principal,
      workspace: options.workspace,
      requestedMode: options.requestedMode,
    })
  } catch (error) {
    if (error instanceof CoreError && GRANT_CODE_MAP[error.code]) {
      throw realLocalError(GRANT_CODE_MAP[error.code], error.message)
    }
    throw error
  }
}

async function recallRealMemory(principal: string): Promise<
  Array<{ label: string; uri: string }>
> {
  const baseUrl = requireLoopbackBaseUrl("REAL_MEM_BASE_URL")
  const token = requiredEnv("REAL_MEM_TOKEN")
  const workspaceId = requiredEnv("REAL_LOCAL_WORKSPACE")
  const sessionRef = process.env.REAL_LOCAL_SESSION_REF
  const { status, body } = await fetchJson(`${baseUrl}/v1/durable-context/recall`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-Workspace-ID": workspaceId,
    },
    body: JSON.stringify({
      contract: MEM_COMPONENT_CONTRACT,
      principal,
      ...(sessionRef ? { session_ref: sessionRef } : {}),
    }),
  })
  if (status === 403) {
    throw realLocalError(REAL_LOCAL_CODES.scopeDenied, "mem denied the principal")
  }
  if (status === 400) {
    throw realLocalError(
      REAL_LOCAL_CODES.contractUnsupported,
      "mem rejected the pinned contract",
    )
  }
  if (status !== 200) {
    throw realLocalError(
      REAL_LOCAL_CODES.serviceUnavailable,
      `mem recall returned status ${status}`,
    )
  }
  const result = body as { contract?: string; hits?: Array<{ locator?: string }> }
  if (result?.contract !== MEM_COMPONENT_CONTRACT || !Array.isArray(result.hits)) {
    throw realLocalError(
      REAL_LOCAL_CODES.contractUnsupported,
      "mem recall response does not match the pinned contract",
    )
  }
  const citations: Array<{ label: string; uri: string }> = []
  for (const hit of result.hits) {
    if (typeof hit.locator !== "string" || hit.locator === "") {
      throw realLocalError(
        REAL_LOCAL_CODES.contractUnsupported,
        "mem recall hit is missing its locator",
      )
    }
    citations.push({ label: hit.locator, uri: hit.locator })
  }
  return citations
}

async function readRealDocument(): Promise<{ label: string; uri: string }> {
  const baseUrl = requireLoopbackBaseUrl("REAL_DOC_BASE_URL")
  const token = requiredEnv("REAL_DOC_TOKEN")
  const documentId = requiredEnv("REAL_DOC_DOCUMENT_ID")
  const { status, etag, body } = await fetchJson(
    `${baseUrl}/api/v1/documents/${encodeURIComponent(documentId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (status === 401 || status === 403) {
    throw realLocalError(REAL_LOCAL_CODES.scopeDenied, "doc denied the token")
  }
  if (status === 404) {
    // Revoked, unlisted, and absent documents are indistinguishable by the
    // doc API's non-enumeration design; all fail closed the same way.
    throw realLocalError(
      REAL_LOCAL_CODES.itemUnavailable,
      "document is unavailable for this token",
    )
  }
  if (status !== 200) {
    throw realLocalError(
      REAL_LOCAL_CODES.serviceUnavailable,
      `doc read returned status ${status}`,
    )
  }
  const revision = (etag ?? "").replace(/^W\//, "").replace(/"/g, "")
  if (revision === "") {
    throw realLocalError(
      REAL_LOCAL_CODES.contractUnsupported,
      "doc read did not return a revision etag",
    )
  }
  const expected = process.env.REAL_DOC_EXPECTED_ETAG
  if (expected !== undefined && expected !== revision) {
    throw realLocalError(
      REAL_LOCAL_CODES.revisionMismatch,
      "document revision does not match the pinned revision",
    )
  }
  const data =
    body && typeof body === "object"
      ? ((body as { data?: unknown }).data ?? body)
      : undefined
  const title =
    data && typeof data === "object" && typeof (data as { title?: unknown }).title === "string"
      ? ((data as { title: string }).title)
      : documentId
  return { label: title, uri: `doc://${documentId}@${revision}` }
}

/**
 * Resolves declared real-mem/real-doc MCP servers against the actual pinned
 * local services through the operator grant. Returns a terminal output for
 * granted runs, a real_local_* failure code otherwise, or null when the run
 * declares no real-local MCP server.
 */
export async function realLocalMcpOutcome(
  payload: RealRunPayload,
): Promise<{ output: Record<string, unknown> } | { failed: string } | null> {
  const servers = payload.mcpServers ?? []
  const wantsMem = servers.some((server) => server.name === REAL_MEM_SERVER)
  const wantsDoc = servers.some((server) => server.name === REAL_DOC_SERVER)
  if (!wantsMem && !wantsDoc) return null
  try {
    assertMatrixSupports(wantsMem, wantsDoc)
    const grantPath = requiredEnv("REAL_LOCAL_GRANT")
    const principal = requiredEnv("REAL_LOCAL_PRINCIPAL")
    const workspace = requiredEnv("REAL_LOCAL_WORKSPACE")
    const requestedMode = (payload.policy?.tools?.allow ?? []).some(
      (tool) =>
        tool.mode === "write" &&
        (tool.name.startsWith("mem.") || tool.name.startsWith("doc.")),
    )
      ? "write"
      : "read"
    const citations: Array<{ label: string; uri: string }> = []
    if (wantsMem) {
      checkGrantOrRemap({
        grantPath,
        workingDirectory: payload.workingDirectory,
        server: REAL_MEM_SERVER,
        principal,
        workspace,
        requestedMode,
      })
      citations.push(...(await recallRealMemory(principal)))
    }
    if (wantsDoc) {
      checkGrantOrRemap({
        grantPath,
        workingDirectory: payload.workingDirectory,
        server: REAL_DOC_SERVER,
        principal,
        workspace,
        requestedMode,
      })
      citations.push(await readRealDocument())
    }
    return {
      output: {
        status: "answered",
        answer: "real local context",
        citations,
      },
    }
  } catch (error) {
    if (
      error instanceof CoreError &&
      Object.values(REAL_LOCAL_CODES).includes(
        error.code as (typeof REAL_LOCAL_CODES)[keyof typeof REAL_LOCAL_CODES],
      )
    ) {
      return { failed: error.code }
    }
    diagnostics("unexpected failure resolving real local context")
    return { failed: REAL_LOCAL_CODES.serviceUnavailable }
  }
}

/** Serves agent-host-stdio.v1 on this process's stdio against real services. */
export function serveRealLocalStdioHost(): void {
  const lineReader = readline.createInterface({ input: process.stdin })
  let cancelledRunId: string | null = null

  lineReader.on("line", (line) => {
    let request: AgentHostStdioRequest
    try {
      request = parseAgentHostStdioRequest(line)
    } catch {
      diagnostics("rejecting malformed request line")
      errorResponse("unparsed", "agent_host_stdio_bad_framing")
      return
    }
    switch (request.kind) {
      case "probe": {
        successResponse(request.id, realLocalStdioProbe())
        return
      }
      case "preflight": {
        const payload = request.payload as {
          policy?: { filesystem?: { write?: string[] } }
        }
        if ((payload.policy?.filesystem?.write ?? []).length > 0) {
          errorResponse(request.id, "agent_host_preflight_invalid")
          return
        }
        successResponse(request.id, realLocalStdioProbe())
        return
      }
      case "cancel": {
        const payload = request.payload as { runId: string }
        cancelledRunId = payload.runId
        return
      }
      case "run": {
        const payload = request.payload as unknown as RealRunPayload
        void (async () => {
          event(request.id, payload.runId, { type: "run.started" })
          if (cancelledRunId === payload.runId) {
            event(request.id, payload.runId, {
              type: "run.failed",
              error: {
                code: "agent_host_cancelled",
                message: "run cancelled",
                retryable: false,
              },
            })
            successResponse(request.id)
            return
          }
          const outcome = await realLocalMcpOutcome(payload)
          if (outcome && "failed" in outcome) {
            event(request.id, payload.runId, {
              type: "run.failed",
              error: {
                code: outcome.failed,
                message: "real local context decision",
                retryable: false,
              },
            })
            successResponse(request.id)
            return
          }
          const output =
            outcome && "output" in outcome
              ? outcome.output
              : { status: "answered", answer: "real local host", citations: [] }
          event(request.id, payload.runId, { type: "run.completed", output })
          successResponse(request.id)
        })()
        return
      }
      default:
        errorResponse(request.id, "agent_host_stdio_unknown_message")
    }
  })
  lineReader.on("close", () => {
    process.exit(0)
  })
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  process.argv[1].includes("real-local-stdio-host")
if (invokedDirectly) {
  serveRealLocalStdioHost()
}
