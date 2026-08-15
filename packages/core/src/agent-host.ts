import type { SafeValue } from "./contracts.js"

export const AGENT_HOST_PROTOCOL_VERSION = "agent-host.v1" as const

export const AGENT_HOST_CAPABILITIES = [
  "non_interactive_run",
  "event_stream",
  "session_resume",
  "attachments",
  "mcp",
  "skills",
  "structured_output",
  "tool_allowlist",
  "filesystem_scope",
  "network_policy",
  "sandbox",
  "approval_callback",
  "cancellation",
  "usage_events",
] as const

/**
 * `structured_output` means adapter-enforced terminal validity: when a run
 * request includes a synchronous `outputSchema`, the adapter may emit
 * `run.completed` only with the unchanged JSON value accepted by that Schema.
 * Repair, coercion, defaults, field removal, or redaction must not manufacture
 * a passing value; if post-validation safety scrubbing would mutate a
 * schema-bound value, the run fails closed. Invalid JSON, asynchronous Schema,
 * Schema mismatch, cancellation, and cleanup failure also fail closed. This
 * capability does not imply host-native constrained generation.
 */

export type AgentHostCapability = (typeof AGENT_HOST_CAPABILITIES)[number]
export type AgentHostCapabilitySupport =
  | "supported"
  | "documented"
  | "unsupported"
  | "unknown"

export type AgentHostCapabilities = Record<
  AgentHostCapability,
  AgentHostCapabilitySupport
>

export type AgentHostProbeStatus =
  | "installed"
  | "ready"
  | "not_ready"
  | "not_found"
  | "probe_failed"

export interface AgentHostIssue {
  code: string
  message: string
  blocking: boolean
}

/**
 * A probe is deliberately local and side-effect free. It may verify that a
 * host executable exists and inspect its version, but it must not start a paid
 * model run or infer that authentication is valid.
 */
export interface AgentHostProbeResult {
  protocolVersion: typeof AGENT_HOST_PROTOCOL_VERSION
  hostId: string
  displayName: string
  status: AgentHostProbeStatus
  available: boolean
  adapterStatus: "probe_only" | "runnable"
  version?: string
  capabilities: AgentHostCapabilities
  capabilitySource: "adapter_declaration" | "conformance_test"
  issues: AgentHostIssue[]
}

export interface AgentHostRequirements {
  requiredCapabilities: AgentHostCapability[]
}

export interface AgentHostCompatibility {
  compatible: boolean
  missing: AgentHostCapability[]
  unknown: AgentHostCapability[]
  issues: AgentHostIssue[]
}

export type AgentHostAttachment = {
  mediaType?: string
  name?: string
} & (
  | { source: "path"; path: string }
  | { source: "uri"; uri: string }
)

export type AgentHostMcpServer =
  | {
      name: string
      transport: "stdio"
      command: string
      args?: string[]
      /** Names only. Secret values stay in the host process environment. */
      environment?: string[]
    }
  | {
      name: string
      transport: "http"
      url: string
      headers?: Array<{ name: string; valueFromEnv: string }>
    }

export interface AgentHostPolicy {
  tools: {
    default: "deny"
    allow: Array<{ name: string; mode: "read" | "write" }>
  }
  filesystem: {
    read: string[]
    write: string[]
  }
  network: {
    /**
     * Employee tool/MCP data-plane egress. The host's own authentication and
     * model control plane is outside this policy field.
     */
    mode: "deny" | "host_policy" | "allowlist"
    hosts?: string[]
  }
  approval: {
    mode: "never" | "required"
  }
  maxTurns?: number
}

export interface AgentHostRunRequest {
  runId: string
  employeeId: string
  workingDirectory: string
  /** Exact portable files selected by the outer package loader for projection. */
  workspaceFiles?: string[]
  prompt: string
  instructions?: string
  session?:
    | { mode: "new" }
    | { mode: "resume"; ref: string }
  attachments?: AgentHostAttachment[]
  mcpServers?: AgentHostMcpServer[]
  outputSchema?: SafeValue
  policy: AgentHostPolicy
  metadata?: Record<string, SafeValue>
  deadline?: string
  signal?: AbortSignal
}

interface AgentHostEventBase {
  runId: string
  timestamp: string
}

export type AgentHostEvent =
  | (AgentHostEventBase & {
      type: "run.started"
      sessionRef?: string
    })
  | (AgentHostEventBase & {
      type: "assistant.delta"
      text: string
    })
  | (AgentHostEventBase & {
      type: "tool.started"
      toolCallId: string
      toolName: string
      input?: SafeValue
    })
  | (AgentHostEventBase & {
      type: "tool.completed"
      toolCallId: string
      toolName: string
      output?: SafeValue
      isError: boolean
    })
  | (AgentHostEventBase & {
      type: "approval.required"
      approvalId: string
      toolName: string
      input?: SafeValue
    })
  | (AgentHostEventBase & {
      type: "usage"
      inputTokens?: number
      outputTokens?: number
      totalTokens?: number
      reportedCost?: number
      currency?: string
    })
  | (AgentHostEventBase & {
      type: "run.completed"
      output: SafeValue
      sessionRef?: string
    })
  | (AgentHostEventBase & {
      type: "run.failed"
      error: {
        /** Lowercase ASCII machine code: `[a-z0-9][a-z0-9._-]{0,127}`. */
        code: string
        message: string
        retryable: boolean
      }
    })

/**
 * The host owns the model, agent loop, context window, tool execution and
 * native session. Tool events are audit signals; the outer runtime does not
 * execute the tool or feed its result back into the loop. Every run stream
 * must emit exactly one terminal run.completed or run.failed event.
 * Digital Employee owns package projection, policy checks, outer orchestration
 * and normalized events.
 */
export interface AgentHostAdapter {
  readonly hostId: string
  probe(): Promise<AgentHostProbeResult>
  preflight(request: AgentHostRunRequest): Promise<AgentHostProbeResult>
  run(request: AgentHostRunRequest): AsyncIterable<AgentHostEvent>
  respondToApproval?(
    runId: string,
    approvalId: string,
    decision: "allow" | "deny",
  ): Promise<void>
  cancel?(runId: string): Promise<void>
  /**
   * Optional qualification-only binding for deterministic process fixtures.
   * Implementations expose an opaque configuration digest and the PID that
   * actually owns their runs; neither value is published in evidence.
   */
  qualificationIdentity?(): Promise<AgentHostQualificationIdentity>
}

export interface AgentHostQualificationIdentity {
  configurationDigest: string
  ownerPid: number
}

export function createUnknownAgentHostCapabilities(): AgentHostCapabilities {
  return Object.fromEntries(
    AGENT_HOST_CAPABILITIES.map((capability) => [capability, "unknown"]),
  ) as AgentHostCapabilities
}

export function assessAgentHostCompatibility(
  probe: AgentHostProbeResult,
  requirements: AgentHostRequirements,
): AgentHostCompatibility {
  const missing: AgentHostCapability[] = []
  const unknown: AgentHostCapability[] = []

  for (const capability of new Set(requirements.requiredCapabilities)) {
    const support = probe.capabilities[capability]
    if (support === "unsupported") {
      missing.push(capability)
    } else if (support !== "supported") {
      unknown.push(capability)
    }
  }

  const issues = [...probe.issues]
  if (
    probe.protocolVersion !== AGENT_HOST_PROTOCOL_VERSION ||
    probe.status !== "ready" ||
    !probe.available
  ) {
    issues.push({
      code: "host_not_ready",
      message: `${probe.displayName} is not ready`,
      blocking: true,
    })
  }
  if (probe.adapterStatus !== "runnable") {
    issues.push({
      code: "host_adapter_not_runnable",
      message: `${probe.displayName} adapter is probe-only`,
      blocking: true,
    })
  }
  if (probe.capabilitySource !== "conformance_test") {
    issues.push({
      code: "host_capabilities_not_conformance_verified",
      message: `${probe.displayName} capabilities are documentation-only`,
      blocking: true,
    })
  }
  for (const capability of missing) {
    issues.push({
      code: "required_capability_unsupported",
      message: `${probe.displayName} does not support ${capability}`,
      blocking: true,
    })
  }
  for (const capability of unknown) {
    issues.push({
      code: "required_capability_unverified",
      message: `${probe.displayName} has not verified ${capability}`,
      blocking: true,
    })
  }

  return {
    compatible:
      probe.available &&
      probe.status === "ready" &&
      probe.protocolVersion === AGENT_HOST_PROTOCOL_VERSION &&
      probe.adapterStatus === "runnable" &&
      probe.capabilitySource === "conformance_test" &&
      missing.length === 0 &&
      unknown.length === 0 &&
      !issues.some((issue) => issue.blocking),
    missing,
    unknown,
    issues,
  }
}
