/**
 * Fail-closed Codex CLI Adapter (#329 R2).
 *
 * Doctor and run share this probe. `--version` is never entitlement.
 * Missing/ineligible binaries fail closed with a next step. A deterministic
 * fixture turn is the only evidence path in this slice; live Codex remains
 * HOLD without a named operator receipt.
 */

import {
  AGENT_HOST_PROTOCOL_VERSION,
  createUnknownAgentHostCapabilities,
} from "../../packages/core/src/agent-host.js"
import type {
  AgentHostAdapter,
  AgentHostCapabilities,
  AgentHostEvent,
  AgentHostIssue,
  AgentHostProbeResult,
  AgentHostRunRequest,
} from "../../packages/core/src/agent-host.js"
import {
  executeVersionCommand,
  type VersionCommandExecutor,
} from "./agent-hosts.js"

const HOST_ID = "codex"
const DISPLAY_NAME = "Codex CLI"
const VERSION_PATTERN = /^codex-cli\s+\d+\.\d+/i

export const CODEX_FIXTURE_ENV = "DIGITAL_EMPLOYEE_CODEX_FIXTURE"

function capabilities(): AgentHostCapabilities {
  const result = createUnknownAgentHostCapabilities()
  result.non_interactive_run = "documented"
  result.event_stream = "documented"
  result.sandbox = "documented"
  result.cancellation = "documented"
  result.tool_allowlist = "unknown"
  return result
}

function issue(code: string, message: string, blocking = true): AgentHostIssue {
  return { code, message, blocking }
}

function nextStep(code: string): string {
  if (code === "host_executable_not_found") {
    return "Install Codex CLI on PATH, then retry doctor --engine codex"
  }
  if (code === "codex_version_ineligible") {
    return "Install a codex-cli x.y.z family binary; --version alone is not entitlement"
  }
  return "Provide a named live Codex receipt or DIGITAL_EMPLOYEE_CODEX_FIXTURE=1 for the fixture turn"
}

export interface CodexAgentHostAdapterOptions {
  command?: string
  executeVersion?: VersionCommandExecutor
  environment?: NodeJS.ProcessEnv
}

export function createCodexAgentHostAdapter(
  options: CodexAgentHostAdapterOptions = {},
): AgentHostAdapter {
  const command = options.command ?? "codex"
  const executeVersion = options.executeVersion ?? executeVersionCommand
  const environment = options.environment ?? process.env

  const probeFromVersion = async (
    signal?: AbortSignal,
  ): Promise<AgentHostProbeResult> => {
    const result = await executeVersion(command, ["--version"], {
      signal,
      environment,
    })
    const issues: AgentHostIssue[] = []
    let status: AgentHostProbeResult["status"] = "not_ready"
    let available = false

    if (result.status === "not_found") {
      issues.push(
        issue(
          "host_executable_not_found",
          `${DISPLAY_NAME} executable was not found on PATH. ${nextStep("host_executable_not_found")}`,
        ),
      )
      status = "not_found"
    } else if (result.status !== "installed") {
      issues.push(
        issue(
          "host_version_probe_failed",
          `${DISPLAY_NAME} did not complete its version probe. ${nextStep("host_version_probe_failed")}`,
        ),
      )
    } else if (!result.output || !VERSION_PATTERN.test(result.output.trim())) {
      issues.push(
        issue(
          "codex_version_ineligible",
          `${DISPLAY_NAME} version is not a codex-cli family string. ${nextStep("codex_version_ineligible")}`,
        ),
      )
    } else if (environment[CODEX_FIXTURE_ENV] === "1") {
      available = true
      status = "ready"
      issues.push(
        issue(
          "codex_fixture_turn",
          "Fixture mode is evidence-only; --version is not live entitlement",
          false,
        ),
      )
    } else {
      available = true
      status = "not_ready"
      issues.push(
        issue(
          "codex_live_hold_no_receipt",
          `${DISPLAY_NAME} is installed; live entitlement is HOLD. ${nextStep("codex_live_hold_no_receipt")}`,
        ),
      )
    }

    return {
      protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
      hostId: HOST_ID,
      displayName: DISPLAY_NAME,
      status,
      available,
      adapterStatus: "runnable",
      ...(result.output ? { version: result.output.trim() } : {}),
      capabilities: capabilities(),
      capabilitySource: "adapter_declaration",
      issues,
    }
  }

  return {
    hostId: HOST_ID,
    probe: () => probeFromVersion(),
    preflight: (request) => probeFromVersion(request.signal),
    async *run(request: AgentHostRunRequest): AsyncIterable<AgentHostEvent> {
      const probe = await probeFromVersion(request.signal)
      const timestamp = () => new Date().toISOString()
      if (probe.status !== "ready") {
        const blocking = probe.issues.find((entry) => entry.blocking)
        yield {
          type: "run.failed",
          runId: request.runId,
          timestamp: timestamp(),
          error: {
            code: blocking?.code ?? "codex_not_ready",
            message: blocking?.message ?? "Codex Adapter is not ready",
            retryable: false,
          },
        }
        return
      }
      yield { type: "run.started", runId: request.runId, timestamp: timestamp() }
      yield {
        type: "run.completed",
        runId: request.runId,
        timestamp: timestamp(),
        output: { status: "codex_fixture_turn" },
      }
    },
  }
}
