import { CoreError } from "./contracts.js"
import {
  AGENT_HOST_CAPABILITIES,
  assessAgentHostCompatibility,
} from "./agent-host.js"
import type {
  AgentHostCapability,
  AgentHostEvent,
  AgentHostProbeResult,
  AgentHostRunRequest,
} from "./agent-host.js"

/**
 * Stable frozen result codes for agent-host.v1 wire classification, from the
 * shipped PR #21 runtime line. Adding a code is a design decision, not an
 * implementation choice (Issue #40 design freeze).
 */
export const AGENT_HOST_VECTOR_CODES = {
  cancelled: "agent_host_cancelled",
  preflightFailed: "agent_host_preflight_failed",
  preflightInvalid: "agent_host_preflight_invalid",
  incompatible: "agent_host_incompatible",
  notRegistered: "agent_host_not_registered",
  adapterResolutionFailed: "agent_host_adapter_resolution_failed",
  adapterNotRunnable: "agent_host_adapter_not_runnable",
  streamFailed: "agent_host_stream_failed",
  terminalContractViolated: "agent_host_terminal_contract_violated",
  eventHandlerFailed: "agent_host_event_handler_failed",
  probeInvalid: "AGENT_HOST_PROBE_INVALID",
} as const

const EVENT_TYPES = new Set([
  "run.started",
  "assistant.delta",
  "tool.started",
  "tool.completed",
  "approval.required",
  "usage",
  "run.completed",
  "run.failed",
])

const TERMINAL_EVENT_TYPES = new Set(["run.completed", "run.failed"])

const PROBE_STATUSES = new Set([
  "installed",
  "ready",
  "not_ready",
  "not_found",
  "probe_failed",
])
const ADAPTER_STATUSES = new Set(["probe_only", "runnable"])
const CAPABILITY_SOURCES = new Set([
  "adapter_declaration",
  "conformance_test",
])
const CAPABILITY_SUPPORT = new Set([
  "supported",
  "documented",
  "unsupported",
  "unknown",
])
const TOOL_MODES = new Set(["read", "write"])
const NETWORK_MODES = new Set(["deny", "host_policy", "allowlist"])
const APPROVAL_MODES = new Set(["never", "required"])
const SESSION_MODES = new Set(["new", "resume"])
const ATTACHMENT_SOURCES = new Set(["path", "uri"])
const MCP_TRANSPORTS = new Set(["stdio", "http"])
const ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export const AGENT_HOST_PROBE_WIRE_KEYS = Object.freeze([
  "protocolVersion",
  "hostId",
  "displayName",
  "status",
  "available",
  "adapterStatus",
  "version",
  "capabilities",
  "capabilitySource",
  "issues",
])

function wireError(
  code: string,
  message: string,
  details?: unknown,
): CoreError {
  return new CoreError(code, message, { status: 400, retryable: false, details })
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function boundedString(
  value: unknown,
  maximum: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    value.length <= maximum &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function stringArray(value: unknown, maximum: number): boolean {
  return (
    Array.isArray(value) &&
    value.length <= maximum &&
    value.every((entry) => boundedString(entry, 1024))
  )
}

/**
 * Strict agent-host.v1 probe wire validation. Unknown fields fail closed:
 * security-relevant or not, v1 adds fields only through a new protocol
 * version, never in place.
 */
export function validateAgentHostProbeWire(
  value: unknown,
  expectedHostId: string,
): AgentHostProbeResult {
  if (!plainRecord(value) || !exactKeys(value, AGENT_HOST_PROBE_WIRE_KEYS)) {
    throw wireError(
      AGENT_HOST_VECTOR_CODES.probeInvalid,
      `agent host ${expectedHostId} probe wire shape is invalid`,
      { hostId: expectedHostId },
    )
  }
  const capabilities = value.capabilities
  const issues = value.issues
  const shapeValid =
    boundedString(value.protocolVersion, 64) &&
    value.hostId === expectedHostId &&
    boundedString(value.displayName, 256) &&
    PROBE_STATUSES.has(value.status as string) &&
    typeof value.available === "boolean" &&
    ADAPTER_STATUSES.has(value.adapterStatus as string) &&
    (value.version === undefined || boundedString(value.version, 256)) &&
    plainRecord(capabilities) &&
    exactKeys(capabilities, AGENT_HOST_CAPABILITIES as unknown as readonly string[]) &&
    AGENT_HOST_CAPABILITIES.every((capability) =>
      CAPABILITY_SUPPORT.has(capabilities[capability] as string),
    ) &&
    CAPABILITY_SOURCES.has(value.capabilitySource as string) &&
    Array.isArray(issues) &&
    issues.length <= 256 &&
    issues.every(
      (entry) =>
        plainRecord(entry) &&
        exactKeys(entry, ["code", "message", "blocking"]) &&
        boundedString(entry.code, 128) &&
        boundedString(entry.message, 2_000, true) &&
        typeof entry.blocking === "boolean",
    )

  if (!shapeValid) {
    throw wireError(
      AGENT_HOST_VECTOR_CODES.probeInvalid,
      `agent host ${expectedHostId} probe wire shape is invalid`,
      { hostId: expectedHostId },
    )
  }
  return value as unknown as AgentHostProbeResult
}

function validatePolicyWire(value: unknown): boolean {
  if (!plainRecord(value)) return false
  if (
    !exactKeys(value, [
      "tools",
      "filesystem",
      "network",
      "approval",
      "maxTurns",
    ])
  ) {
    return false
  }
  const tools = value.tools
  const filesystem = value.filesystem
  const network = value.network
  const approval = value.approval
  if (
    !plainRecord(tools) ||
    !exactKeys(tools, ["default", "allow"]) ||
    tools.default !== "deny" ||
    !Array.isArray(tools.allow) ||
    tools.allow.length > 256 ||
    !tools.allow.every(
      (entry) =>
        plainRecord(entry) &&
        exactKeys(entry, ["name", "mode"]) &&
        boundedString(entry.name, 256) &&
        TOOL_MODES.has(entry.mode as string),
    )
  ) {
    return false
  }
  if (
    !plainRecord(filesystem) ||
    !exactKeys(filesystem, ["read", "write"]) ||
    !stringArray(filesystem.read, 1024) ||
    !stringArray(filesystem.write, 1024)
  ) {
    return false
  }
  if (
    !plainRecord(network) ||
    !exactKeys(network, ["mode", "hosts"]) ||
    !NETWORK_MODES.has(network.mode as string) ||
    (network.hosts !== undefined && !stringArray(network.hosts, 1024))
  ) {
    return false
  }
  if (
    !plainRecord(approval) ||
    !exactKeys(approval, ["mode"]) ||
    !APPROVAL_MODES.has(approval.mode as string)
  ) {
    return false
  }
  return (
    value.maxTurns === undefined ||
    (typeof value.maxTurns === "number" &&
      Number.isInteger(value.maxTurns) &&
      value.maxTurns > 0 &&
      value.maxTurns <= 10_000)
  )
}

function validateAttachmentWire(value: unknown): boolean {
  if (!plainRecord(value) || !exactKeys(value, ["mediaType", "name", "source", "path", "uri"])) {
    return false
  }
  if (
    (value.mediaType !== undefined && !boundedString(value.mediaType, 256)) ||
    (value.name !== undefined && !boundedString(value.name, 256)) ||
    !ATTACHMENT_SOURCES.has(value.source as string)
  ) {
    return false
  }
  if (value.source === "path") {
    return value.uri === undefined && boundedString(value.path, 2048)
  }
  return value.path === undefined && boundedString(value.uri, 2048)
}

function validateMcpServerWire(value: unknown): boolean {
  if (!plainRecord(value) || !exactKeys(value, ["name", "transport", "command", "args", "environment", "url", "headers"])) {
    return false
  }
  if (!boundedString(value.name, 256) || !MCP_TRANSPORTS.has(value.transport as string)) {
    return false
  }
  if (value.transport === "stdio") {
    return (
      value.url === undefined &&
      value.headers === undefined &&
      boundedString(value.command, 2048) &&
      (value.args === undefined || stringArray(value.args, 256)) &&
      (value.environment === undefined || stringArray(value.environment, 256))
    )
  }
  return (
    value.command === undefined &&
    value.args === undefined &&
    value.environment === undefined &&
    boundedString(value.url, 2048) &&
    (value.headers === undefined ||
      (Array.isArray(value.headers) &&
        value.headers.length <= 256 &&
        value.headers.every(
          (entry) =>
            plainRecord(entry) &&
            exactKeys(entry, ["name", "valueFromEnv"]) &&
            boundedString(entry.name, 256) &&
            boundedString(entry.valueFromEnv, 256),
        )))
  )
}

const RUN_REQUEST_WIRE_KEYS = Object.freeze([
  "runId",
  "employeeId",
  "workingDirectory",
  "workspaceFiles",
  "prompt",
  "instructions",
  "session",
  "attachments",
  "mcpServers",
  "outputSchema",
  "policy",
  "metadata",
  "deadline",
])

/**
 * Strict agent-host.v1 run-request wire validation. The runtime-only `signal`
 * field is not part of the wire contract and is rejected like any unknown
 * field.
 */
export function validateAgentHostRunRequestWire(
  value: unknown,
): AgentHostRunRequest {
  let valid = plainRecord(value) && exactKeys(value, RUN_REQUEST_WIRE_KEYS)
  if (valid && plainRecord(value)) {
    const session = value.session
    valid =
      boundedString(value.runId, 256) &&
      boundedString(value.employeeId, 256) &&
      boundedString(value.workingDirectory, 2048) &&
      (value.workspaceFiles === undefined ||
        stringArray(value.workspaceFiles, 4096)) &&
      boundedString(value.prompt, 65_536) &&
      (value.instructions === undefined ||
        boundedString(value.instructions, 65_536)) &&
      (session === undefined ||
        (plainRecord(session) &&
          exactKeys(session, ["mode", "ref"]) &&
          SESSION_MODES.has(session.mode as string) &&
          (session.mode === "new"
            ? session.ref === undefined
            : boundedString(session.ref, 512)))) &&
      (value.attachments === undefined ||
        (Array.isArray(value.attachments) &&
          value.attachments.length <= 256 &&
          value.attachments.every(validateAttachmentWire))) &&
      (value.mcpServers === undefined ||
        (Array.isArray(value.mcpServers) &&
          value.mcpServers.length <= 64 &&
          value.mcpServers.every(validateMcpServerWire))) &&
      validatePolicyWire(value.policy) &&
      (value.metadata === undefined || plainRecord(value.metadata)) &&
      (value.deadline === undefined ||
        (typeof value.deadline === "string" &&
          TIMESTAMP_PATTERN.test(value.deadline)))
  }
  if (!valid) {
    throw wireError(
      AGENT_HOST_VECTOR_CODES.preflightInvalid,
      "agent host run request wire shape is invalid",
    )
  }
  return value as unknown as AgentHostRunRequest
}

const EVENT_KEY_SETS: Record<string, readonly string[]> = {
  "run.started": ["runId", "timestamp", "type", "sessionRef"],
  "assistant.delta": ["runId", "timestamp", "type", "text"],
  "tool.started": ["runId", "timestamp", "type", "toolCallId", "toolName", "input"],
  "tool.completed": [
    "runId",
    "timestamp",
    "type",
    "toolCallId",
    "toolName",
    "output",
    "isError",
  ],
  "approval.required": [
    "runId",
    "timestamp",
    "type",
    "approvalId",
    "toolName",
    "input",
  ],
  usage: [
    "runId",
    "timestamp",
    "type",
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "reportedCost",
    "currency",
  ],
  "run.completed": ["runId", "timestamp", "type", "output", "sessionRef"],
  "run.failed": ["runId", "timestamp", "type", "error"],
}

/** Strict agent-host.v1 event wire validation with fail-closed unknown fields. */
export function validateAgentHostEventWire(value: unknown): AgentHostEvent {
  let valid = plainRecord(value)
  if (valid && plainRecord(value)) {
    const type = value.type
    valid =
      typeof type === "string" &&
      EVENT_TYPES.has(type) &&
      exactKeys(value, EVENT_KEY_SETS[type] ?? []) &&
      boundedString(value.runId, 256) &&
      typeof value.timestamp === "string" &&
      TIMESTAMP_PATTERN.test(value.timestamp)
    if (valid && plainRecord(value)) {
      switch (value.type) {
        case "run.started":
          valid =
            value.sessionRef === undefined ||
            boundedString(value.sessionRef, 512)
          break
        case "assistant.delta":
          valid = boundedString(value.text, 1_048_576, true)
          break
        case "tool.started":
        case "approval.required":
          valid =
            boundedString(
              value.type === "tool.started" ? value.toolCallId : value.approvalId,
              256,
            ) && boundedString(value.toolName, 256)
          break
        case "tool.completed":
          valid =
            boundedString(value.toolCallId, 256) &&
            boundedString(value.toolName, 256) &&
            typeof value.isError === "boolean"
          break
        case "usage":
          valid =
            (value.inputTokens === undefined ||
              typeof value.inputTokens === "number") &&
            (value.outputTokens === undefined ||
              typeof value.outputTokens === "number") &&
            (value.totalTokens === undefined ||
              typeof value.totalTokens === "number") &&
            (value.reportedCost === undefined ||
              typeof value.reportedCost === "number") &&
            (value.currency === undefined || boundedString(value.currency, 16))
          break
        case "run.completed":
          valid =
            value.output !== undefined &&
            (value.sessionRef === undefined ||
              boundedString(value.sessionRef, 512))
          break
        case "run.failed": {
          const error = value.error
          valid =
            plainRecord(error) &&
            exactKeys(error, ["code", "message", "retryable"]) &&
            typeof error.code === "string" &&
            ERROR_CODE_PATTERN.test(error.code) &&
            boundedString(error.message, 4096) &&
            typeof error.retryable === "boolean"
          break
        }
        default:
          valid = false
      }
    }
  }
  if (!valid) {
    throw wireError(
      AGENT_HOST_VECTOR_CODES.streamFailed,
      "agent host event wire shape is invalid",
    )
  }
  return value as unknown as AgentHostEvent
}

export type AgentHostVectorClassification =
  | { kind: "accept" }
  | { kind: "reject"; code: string }

/**
 * Classifies a wire event stream against the single-terminal invariant.
 * Cancellation or deadline context requires the terminal failure to carry the
 * frozen cancellation code; any other terminal shape violates the cancel path.
 */
export function classifyAgentHostEventStream(
  events: readonly unknown[],
  context: { cancelled?: boolean; deadlineExpired?: boolean } = {},
): AgentHostVectorClassification {
  const parsed: AgentHostEvent[] = []
  for (const event of events) {
    try {
      parsed.push(validateAgentHostEventWire(event))
    } catch {
      return {
        kind: "reject",
        code: AGENT_HOST_VECTOR_CODES.streamFailed,
      }
    }
  }

  let terminalIndex = -1
  for (let index = 0; index < parsed.length; index += 1) {
    if (TERMINAL_EVENT_TYPES.has(parsed[index].type)) {
      if (terminalIndex !== -1) {
        return {
          kind: "reject",
          code: AGENT_HOST_VECTOR_CODES.terminalContractViolated,
        }
      }
      terminalIndex = index
    }
  }
  if (terminalIndex === -1 || terminalIndex !== parsed.length - 1) {
    return {
      kind: "reject",
      code: AGENT_HOST_VECTOR_CODES.terminalContractViolated,
    }
  }

  const terminal = parsed[terminalIndex]
  const cancellationRequired =
    context.cancelled === true || context.deadlineExpired === true
  if (cancellationRequired) {
    const cancelledTerminal =
      terminal.type === "run.failed" &&
      terminal.error.code === AGENT_HOST_VECTOR_CODES.cancelled
    if (!cancelledTerminal) {
      return { kind: "reject", code: AGENT_HOST_VECTOR_CODES.cancelled }
    }
  }
  return { kind: "accept" }
}

/** Classifies probe compatibility for migration vectors. */
export function classifyAgentHostCompatibility(
  probe: unknown,
  requiredCapabilities: readonly string[],
  expectedHostId: string,
): AgentHostVectorClassification {
  let parsed
  try {
    parsed = validateAgentHostProbeWire(probe, expectedHostId)
  } catch {
    return { kind: "reject", code: AGENT_HOST_VECTOR_CODES.probeInvalid }
  }
  const result = assessAgentHostCompatibility(parsed, {
    requiredCapabilities: requiredCapabilities as AgentHostCapability[],
  })
  return result.compatible
    ? { kind: "accept" }
    : { kind: "reject", code: AGENT_HOST_VECTOR_CODES.incompatible }
}
