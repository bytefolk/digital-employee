import readline from "node:readline"
import { spawn } from "node:child_process"

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
import { CoreError } from "../../packages/core/src/contracts.js"
import {
  ADAPTER_QUALIFICATION_DRIVER_SCHEMA_ID,
  QUALIFICATION_CREDENTIAL_SENTINEL,
  QUALIFICATION_FILESYSTEM_DENIAL_CODE,
  QUALIFICATION_MCP_DENIAL_CODE,
  QUALIFICATION_NETWORK_DENIAL_CODE,
} from "../../packages/core/src/adapter-qualification.js"
import type {
  QualificationDriverOperation,
  QualificationProcessTreeScenario,
} from "../../packages/core/src/adapter-qualification.js"
import {
  MCP_CONFORMANCE_CODES,
  SYNTHETIC_DOC_SERVER,
  SYNTHETIC_MEM_SERVER,
  loadCapabilityGrants,
  readSyntheticDocument,
  recallSyntheticMemory,
  validateSyntheticDocumentFixture,
  validateSyntheticMemoryFixture,
} from "../../packages/core/src/mcp-conformance.js"
import { readFileSync } from "node:fs"

export const REFERENCE_STDIO_HOST_ID = "reference-stdio-host"

/**
 * Builds the reference Adapter's probe result. Conformance fixtures vary it
 * only through explicit overrides, never through runtime branching.
 */
export function referenceStdioProbe(
  overrides: {
    hostId?: string
    status?: AgentHostProbeResult["status"]
    adapterStatus?: AgentHostProbeResult["adapterStatus"]
    capabilitySource?: AgentHostProbeResult["capabilitySource"]
    missingCapability?: string
  } = {},
): AgentHostProbeResult {
  const capabilities = createUnknownAgentHostCapabilities()
  capabilities.non_interactive_run = "supported"
  capabilities.event_stream = "supported"
  capabilities.tool_allowlist = "supported"
  capabilities.filesystem_scope = "supported"
  capabilities.network_policy = "supported"
  // The MCP capability is only declared when the synthetic grant boundary is
  // wired into this host; without it the host stays MCP-unknown, fail-closed.
  if (process.env.SYNTHETIC_MCP_GRANT !== undefined) {
    capabilities.mcp = "supported"
  }
  if (overrides.missingCapability) {
    delete (capabilities as Record<string, unknown>)[overrides.missingCapability]
  }
  return {
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    hostId: overrides.hostId ?? REFERENCE_STDIO_HOST_ID,
    displayName: "Reference Stdio Host",
    status: overrides.status ?? "ready",
    available: true,
    adapterStatus: overrides.adapterStatus ?? "runnable",
    version: "1.0.0",
    capabilities,
    capabilitySource: overrides.capabilitySource ?? "conformance_test",
    issues: [],
  }
}

function envFlag(name: string): boolean {
  return process.env[name] === "1"
}

function write(message: unknown): void {
  process.stdout.write(`${encodeAgentHostStdioLine(message)}\n`)
}

function diagnostics(text: string): void {
  // stderr is diagnostics-only and bounded; stdout carries protocol only.
  process.stderr.write(`[reference-stdio-host] ${text}\n`.slice(0, 512))
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
    error: { code, message: "reference host refused the request", retryable: false },
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

const RUN_ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/

interface SyntheticRunPayload {
  mcpServers?: Array<{ name: string }>
  metadata?: Record<string, unknown>
  policy?: { tools?: { allow?: Array<{ name: string; mode: string }> } }
  workingDirectory?: string
}

function qualificationOperation(
  payload: { metadata?: Record<string, unknown> },
): QualificationDriverOperation | undefined {
  if (!envFlag("REFERENCE_STDIO_QUALIFICATION_MODE")) return undefined
  const driver = payload.metadata?.adapterQualification
  if (!driver || typeof driver !== "object" || Array.isArray(driver)) {
    return undefined
  }
  const driverRecord = driver as Record<string, unknown>
  if (
    Object.keys(driverRecord).some(
      (key) => key !== "schema" && key !== "operation",
    ) ||
    driverRecord.schema !== ADAPTER_QUALIFICATION_DRIVER_SCHEMA_ID ||
    !driverRecord.operation ||
    typeof driverRecord.operation !== "object" ||
    Array.isArray(driverRecord.operation)
  ) {
    return undefined
  }
  const operation = driverRecord.operation as Record<string, unknown>
  if (
    operation.kind === "filesystem.write" &&
    operation.path === "../qualification-denied/outside-scope" &&
    Object.keys(operation).length === 2
  ) {
    return {
      kind: "filesystem.write",
      path: "../qualification-denied/outside-scope",
    }
  }
  if (
    operation.kind === "network.connect" &&
    operation.url === "https://qualification.invalid/" &&
    Object.keys(operation).length === 2
  ) {
    return {
      kind: "network.connect",
      url: "https://qualification.invalid/",
    }
  }
  if (
    operation.kind === "mcp.invoke" &&
    operation.server === "qualification-denied" &&
    operation.tool === "qualification.noop" &&
    Object.keys(operation).length === 3
  ) {
    return {
      kind: "mcp.invoke",
      server: "qualification-denied",
      tool: "qualification.noop",
    }
  }
  if (
    operation.kind === "lifecycle.wait_for_cancel" &&
    Object.keys(operation).length === 1
  ) {
    return { kind: "lifecycle.wait_for_cancel" }
  }
  if (
    operation.kind === "process_tree" &&
    (operation.scenario === "normal" ||
      operation.scenario === "timeout" ||
      operation.scenario === "cancel") &&
    Object.keys(operation).length === 2
  ) {
    return {
      kind: "process_tree",
      scenario: operation.scenario,
    }
  }
  if (
    operation.kind === "output_schema.emit" &&
    (operation.scenario === "non_json" ||
      operation.scenario === "schema_mismatch" ||
      operation.scenario === "secret_rejected") &&
    Object.keys(operation).length === 2
  ) {
    return {
      kind: "output_schema.emit",
      scenario: operation.scenario,
    }
  }
  if (
    operation.kind === "output_schema.buffer_until_cancel" &&
    Object.keys(operation).length === 1
  ) {
    return { kind: "output_schema.buffer_until_cancel" }
  }
  if (
    operation.kind === "projection.read_search" &&
    Object.keys(operation).length === 1
  ) {
    return { kind: "projection.read_search" }
  }
  if (
    operation.kind === "projection.write_tool" &&
    Object.keys(operation).length === 1
  ) {
    return { kind: "projection.write_tool" }
  }
  return undefined
}

function loadJsonFile(path: string | undefined): unknown {
  if (!path) {
    throw new CoreError(
      MCP_CONFORMANCE_CODES.serviceUnavailable,
      "synthetic fixture is not configured",
      { status: 400, retryable: false },
    )
  }
  return JSON.parse(readFileSync(path, "utf8"))
}

/**
 * Binds declared synthetic-mem/synthetic-doc MCP servers to their public
 * fixtures through the operator grant. Returns a terminal output on granted
 * runs, a frozen failure code otherwise, or null when the run declares no
 * synthetic MCP server.
 */
function syntheticMcpOutcome(
  payload: SyntheticRunPayload,
): { output: Record<string, unknown> } | { failed: string } | null {
  const servers = payload.mcpServers ?? []
  const wantsMem = servers.some((server) => server.name === SYNTHETIC_MEM_SERVER)
  const wantsDoc = servers.some((server) => server.name === SYNTHETIC_DOC_SERVER)
  if (!wantsMem && !wantsDoc) return null
  try {
    const grants = loadCapabilityGrants(
      process.env.SYNTHETIC_MCP_GRANT ?? "",
      payload.workingDirectory,
    )
    const metadata = payload.metadata ?? {}
    // Embedders pass identity through run metadata; operator-driven runs pin
    // it through the host environment instead. Either way it is explicit.
    const principal =
      typeof metadata.principal === "string"
        ? metadata.principal
        : process.env.SYNTHETIC_MCP_PRINCIPAL
    const workspace =
      typeof metadata.workspace === "string"
        ? metadata.workspace
        : process.env.SYNTHETIC_MCP_WORKSPACE
    if (typeof principal !== "string" || typeof workspace !== "string") {
      return { failed: MCP_CONFORMANCE_CODES.scopeDenied }
    }
    const requestedMode = (payload.policy?.tools?.allow ?? []).some(
      (tool) =>
        tool.mode === "write" &&
        (tool.name.startsWith("mem.") || tool.name.startsWith("doc.")),
    )
      ? "write"
      : "read"
    const citations: Array<{ label: string; uri: string }> = []
    if (wantsMem) {
      const fixture = validateSyntheticMemoryFixture(
        loadJsonFile(process.env.SYNTHETIC_MCP_MEM_FIXTURE),
      )
      for (const item of recallSyntheticMemory({
        fixture,
        grants,
        principal,
        workspace,
        requestedMode,
      })) {
        citations.push({ label: item.locator, uri: item.locator })
      }
    }
    if (wantsDoc) {
      const fixture = validateSyntheticDocumentFixture(
        loadJsonFile(process.env.SYNTHETIC_MCP_DOC_FIXTURE),
      )
      const documentId = metadata.documentId
      const revision = metadata.revision
      if (typeof documentId === "string" && typeof revision === "number") {
        const document = readSyntheticDocument({
          fixture,
          grants,
          principal,
          workspace,
          documentId,
          revision,
          requestedMode,
        })
        citations.push({ label: document.title, uri: document.locator })
      }
    }
    return {
      output: {
        status: "answered",
        answer: "synthetic mcp context",
        citations,
      },
    }
  } catch (error) {
    if (error instanceof CoreError && RUN_ERROR_CODE_PATTERN.test(error.code)) {
      return { failed: error.code }
    }
    return { failed: MCP_CONFORMANCE_CODES.serviceUnavailable }
  }
}

/**
 * Serves agent-host-stdio.v1 on this process's stdio. Violation fixtures are
 * selected through REFERENCE_STDIO_* environment flags so each AC-002 path is
 * deterministic and reviewable.
 */
export function serveReferenceStdioHost(): void {
  const lineReader = readline.createInterface({ input: process.stdin })
  let cancelledRunId: string | null = null
  let activeRun: { id: string; runId: string } | null = null
  let descendantsReady: Promise<void> | undefined
  const qualificationTrees = new Set<ReturnType<typeof spawn>>()

  const spawnQualificationTree = (
    scenario: QualificationProcessTreeScenario,
  ): void => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        [
          'const { spawn } = require("node:child_process")',
          'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })',
          'process.stdout.write(String(grandchild.pid) + "\\n")',
          "setInterval(() => {}, 1000)",
        ].join(";"),
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    )
    qualificationTrees.add(child)
    child.once("exit", () => qualificationTrees.delete(child))
    child.once("error", () => {
      diagnostics(
        `qualification process_tree ${scenario} child pid ${child.pid ?? 0} grandchild pid 0`,
      )
    })
    child.stdout?.once("data", (chunk: Buffer) => {
      diagnostics(
        `qualification process_tree ${scenario} child pid ${child.pid ?? 0} grandchild pid ${Number(chunk.toString("utf8").trim())}`,
      )
    })
    child.unref()
  }

  if (envFlag("REFERENCE_STDIO_SPAWN_CHILD")) {
    // The child creates its own grandchild. Both inherit the reference host's
    // process group and survive a leader-only exit, so qualification can prove
    // that cleanup reaches two descendant generations.
    const leaked = spawn(
      process.execPath,
      [
        "-e",
        [
          'const { spawn } = require("node:child_process")',
          'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })',
          'process.stdout.write(String(grandchild.pid) + "\\n")',
          "setInterval(() => {}, 1000)",
        ].join(";"),
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    )
    descendantsReady = new Promise<void>((resolve) => {
      if (!leaked.stdout) {
        diagnostics(`spawned child pid ${leaked.pid ?? 0} grandchild pid 0`)
        resolve()
        return
      }
      leaked.stdout.once("data", (chunk: Buffer) => {
        const grandchildPid = Number(chunk.toString("utf8").trim())
        diagnostics(
          `spawned child pid ${leaked.pid ?? 0} grandchild pid ${grandchildPid}`,
        )
        resolve()
      })
      leaked.once("error", () => {
        diagnostics(`spawned child pid ${leaked.pid ?? 0} grandchild pid 0`)
        resolve()
      })
    })
    leaked.unref()
  }

  const handleLine = (line: string): void => {
    let request: AgentHostStdioRequest
    try {
      request = parseAgentHostStdioRequest(line)
    } catch (error) {
      diagnostics("rejecting malformed request line")
      errorResponse("unparsed", "agent_host_stdio_bad_framing")
      void error
      return
    }
    switch (request.kind) {
      case "probe": {
        const probe = referenceStdioProbe({
          status: envFlag("REFERENCE_STDIO_NOT_READY")
            ? "not_ready"
            : "ready",
          adapterStatus: envFlag("REFERENCE_STDIO_PROBE_ONLY")
            ? "probe_only"
            : "runnable",
          missingCapability: envFlag("REFERENCE_STDIO_MISSING_CAPABILITY")
            ? "tool_allowlist"
            : undefined,
        })
        if (envFlag("REFERENCE_STDIO_UNKNOWN_FIELD")) {
          write({
            protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
            id: request.id,
            kind: "response",
            ok: true,
            result: { ...probe, extraField: true },
          })
        } else {
          successResponse(request.id, probe)
        }
        return
      }
      case "preflight": {
        const payload = request.payload as {
          runId?: string
          policy?: { filesystem?: { write?: string[] } }
          metadata?: Record<string, unknown>
        }
        const operation = qualificationOperation(payload)
        if (operation?.kind === "filesystem.write") {
          if (!envFlag("REFERENCE_STDIO_HOSTILE_WRITE_OK")) {
            errorResponse(request.id, QUALIFICATION_FILESYSTEM_DENIAL_CODE)
            return
          }
        }
        const writes = payload.policy?.filesystem?.write ?? []
        if (writes.length > 0 && !envFlag("REFERENCE_STDIO_HOSTILE_WRITE_OK")) {
          errorResponse(request.id, "agent_host_preflight_invalid")
          return
        }
        if (operation?.kind === "network.connect") {
          errorResponse(request.id, QUALIFICATION_NETWORK_DENIAL_CODE)
          return
        }
        if (operation?.kind === "mcp.invoke") {
          errorResponse(request.id, QUALIFICATION_MCP_DENIAL_CODE)
          return
        }
        if (operation?.kind === "projection.write_tool") {
          // The reference projection is read-only by construction; a write
          // attempt is refused at preflight with the typed filesystem denial.
          errorResponse(request.id, QUALIFICATION_FILESYSTEM_DENIAL_CODE)
          return
        }
        successResponse(request.id, referenceStdioProbe())
        return
      }
      case "cancel": {
        const payload = request.payload as { runId: string }
        if (!envFlag("REFERENCE_STDIO_REFUSE_CANCEL")) {
          cancelledRunId = payload.runId
          diagnostics(`cancel requested for ${payload.runId}`)
          if (activeRun && activeRun.runId === payload.runId) {
            event(activeRun.id, payload.runId, {
              type: "run.failed",
              error: {
                code: "agent_host_cancelled",
                message: "run cancelled",
                retryable: false,
              },
            })
            successResponse(activeRun.id)
            activeRun = null
          }
        }
        return
      }
      case "run": {
        const payload = request.payload as {
          runId: string
          outputSchema?: unknown
          metadata?: Record<string, unknown>
        }
        const operation = qualificationOperation(payload)
        activeRun = { id: request.id, runId: payload.runId }
        diagnostics(`run started for ${payload.runId}`)
        event(request.id, payload.runId, { type: "run.started" })
        if (operation?.kind === "output_schema.emit") {
          // Deterministic hostile terminals: the adapter must reject every
          // one of these against the run's output schema.
          const output =
            operation.scenario === "non_json"
              ? "this terminal output is prose, not json"
              : operation.scenario === "schema_mismatch"
                ? { wrong_field: "mismatched" }
                : { answer: "ok", leaked: QUALIFICATION_CREDENTIAL_SENTINEL }
          event(request.id, payload.runId, {
            type: "run.completed",
            output,
          })
          successResponse(request.id)
          activeRun = null
          return
        }
        if (operation?.kind === "output_schema.buffer_until_cancel") {
          // Buffer partial output and never flush it; only a cancel produces
          // the terminal for this run.
          event(request.id, payload.runId, {
            type: "assistant.delta",
            text: '{"answer":"partial',
          })
          return
        }
        if (operation?.kind === "projection.read_search") {
          // The deterministic read-only projection: exactly the two allowed
          // read tools run to completion, then the run terminates.
          for (const [toolCallId, toolName] of [
            ["call-projection-read", "read_file"],
            ["call-projection-search", "search_workspace"],
          ] as const) {
            event(request.id, payload.runId, {
              type: "tool.started",
              toolCallId,
              toolName,
            })
            event(request.id, payload.runId, {
              type: "tool.completed",
              toolCallId,
              toolName,
              isError: false,
            })
          }
          event(request.id, payload.runId, {
            type: "run.completed",
            output: { status: "answered", answer: "reference host", citations: [] },
          })
          successResponse(request.id)
          activeRun = null
          return
        }
        if (operation?.kind === "process_tree") {
          spawnQualificationTree(operation.scenario)
        }
        if (envFlag("REFERENCE_STDIO_DISALLOWED_TOOL")) {
          event(request.id, payload.runId, {
            type: "tool.started",
            toolCallId: "call-1",
            toolName: "shell",
          })
        }
        if (
          envFlag("REFERENCE_STDIO_HANG") ||
          operation?.kind === "lifecycle.wait_for_cancel" ||
          (operation?.kind === "process_tree" &&
            operation.scenario !== "normal")
        ) {
          return
        }
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
          activeRun = null
          return
        }
        const synthetic = syntheticMcpOutcome(payload as SyntheticRunPayload)
        if (synthetic && "failed" in synthetic) {
          event(request.id, payload.runId, {
            type: "run.failed",
            error: {
              code: synthetic.failed,
              message: "synthetic mcp conformance decision",
              retryable: false,
            },
          })
          successResponse(request.id)
          activeRun = null
          return
        }
        const output =
          synthetic && "output" in synthetic
            ? synthetic.output
            : payload.outputSchema !== undefined
              ? { answer: "reference" }
              : { status: "answered", answer: "reference host", citations: [] }
        event(request.id, payload.runId, {
          type: "run.completed",
          output,
        })
        if (envFlag("REFERENCE_STDIO_DUP_TERMINAL")) {
          event(request.id, payload.runId, {
            type: "run.completed",
            output,
          })
        }
        if (envFlag("REFERENCE_STDIO_AFTER_TERMINAL")) {
          event(request.id, payload.runId, {
            type: "usage",
            totalTokens: 1,
          })
        }
        if (!envFlag("REFERENCE_STDIO_NO_CLOSE")) {
          successResponse(request.id)
        }
        activeRun = null
        if (envFlag("REFERENCE_STDIO_EXIT_AFTER_RUN")) {
          process.exit(0)
        }
        return
      }
      default:
        errorResponse(request.id, "agent_host_stdio_unknown_message")
    }
  }
  lineReader.on("line", (line) => {
    if (!descendantsReady) {
      handleLine(line)
      return
    }
    // When the deterministic process-tree fixture is enabled, do not answer
    // its probe until both descendant PIDs have been captured as evidence.
    void descendantsReady.then(() => handleLine(line))
  })
  lineReader.on("close", () => {
    process.exit(0)
  })
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  process.argv[1].includes("reference-stdio-host")
if (invokedDirectly) {
  serveReferenceStdioHost()
}
