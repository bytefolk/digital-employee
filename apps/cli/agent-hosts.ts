import { execFile } from "node:child_process"

import {
  AGENT_HOST_PROTOCOL_VERSION,
  createUnknownAgentHostCapabilities,
} from "../../packages/core/src/agent-host.js"
import type {
  AgentHostCapabilities,
  AgentHostCapability,
  AgentHostProbeResult,
  AgentHostProbeStatus,
} from "../../packages/core/src/agent-host.js"

export const BUILT_IN_AGENT_HOST_IDS = [
  "claude-code",
  "qoder",
  "codex",
  "qwen-code",
  "codebuddy",
] as const

export type BuiltInAgentHostId = (typeof BUILT_IN_AGENT_HOST_IDS)[number]

interface CliAgentHostDefinition {
  id: BuiltInAgentHostId
  displayName: string
  command: string
  versionArgs: string[]
  capabilities: AgentHostCapabilities
}

export interface VersionCommandResult {
  status: Extract<
    AgentHostProbeStatus,
    "installed" | "not_found" | "probe_failed"
  >
  output?: string
}

export type VersionCommandExecutor = (
  command: string,
  args: string[],
) => Promise<VersionCommandResult>

function versionProbeEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const key of [
    "PATH",
    "PATHEXT",
    "HOME",
    "LANG",
    "LC_ALL",
    "TZ",
    "SystemRoot",
    "WINDIR",
  ]) {
    if (source[key]) result[key] = source[key]
  }
  return result
}

function documentedCapabilities(
  documented: AgentHostCapability[],
  unsupported: AgentHostCapability[] = [],
): AgentHostCapabilities {
  const result = createUnknownAgentHostCapabilities()
  for (const capability of documented) result[capability] = "documented"
  for (const capability of unsupported) result[capability] = "unsupported"
  return result
}

const CLI_AGENT_HOST_DEFINITIONS: Record<
  BuiltInAgentHostId,
  CliAgentHostDefinition
> = {
  "claude-code": {
    id: "claude-code",
    displayName: "Claude Code",
    command: "claude",
    versionArgs: ["--version"],
    capabilities: documentedCapabilities([
      "non_interactive_run",
      "event_stream",
      "session_resume",
      "mcp",
      "skills",
      "structured_output",
      "tool_allowlist",
      "filesystem_scope",
      "cancellation",
      "usage_events",
    ]),
  },
  qoder: {
    id: "qoder",
    displayName: "Qoder CLI",
    command: "qodercli",
    versionArgs: ["--version"],
    capabilities: documentedCapabilities([
      "non_interactive_run",
      "event_stream",
      "session_resume",
      "attachments",
      "mcp",
      "skills",
      "tool_allowlist",
      "filesystem_scope",
      "cancellation",
      "usage_events",
    ]),
  },
  codex: {
    id: "codex",
    displayName: "Codex CLI",
    command: "codex",
    versionArgs: ["--version"],
    capabilities: documentedCapabilities([
      "non_interactive_run",
      "event_stream",
      "session_resume",
      "attachments",
      "mcp",
      "skills",
      "structured_output",
      "filesystem_scope",
      "network_policy",
      "sandbox",
      "cancellation",
      "usage_events",
    ]),
  },
  "qwen-code": {
    id: "qwen-code",
    displayName: "Qwen Code",
    command: "qwen",
    versionArgs: ["--version"],
    capabilities: documentedCapabilities([
      "non_interactive_run",
      "event_stream",
      "session_resume",
      "mcp",
      "skills",
      "structured_output",
      "filesystem_scope",
      "sandbox",
      "cancellation",
      "usage_events",
    ]),
  },
  codebuddy: {
    id: "codebuddy",
    displayName: "CodeBuddy Code",
    command: "codebuddy",
    versionArgs: ["--version"],
    capabilities: documentedCapabilities([
      "non_interactive_run",
      "event_stream",
      "session_resume",
      "mcp",
      "skills",
      "structured_output",
      "filesystem_scope",
      "sandbox",
      "cancellation",
      "usage_events",
    ]),
  },
}

function cleanVersionOutput(value: string): string | undefined {
  const line = value
    .split(/\r?\n/)
    .map((entry) => entry.replace(/[\u0000-\u001f\u007f]/g, "").trim())
    .find(Boolean)
  return line ? line.slice(0, 256) : undefined
}

export const executeVersionCommand: VersionCommandExecutor = (
  command,
  args,
) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        env: versionProbeEnvironment(process.env),
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({
            status: "installed",
            output: cleanVersionOutput(stdout) ?? cleanVersionOutput(stderr),
          })
          return
        }

        const code = (error as NodeJS.ErrnoException).code
        resolve({ status: code === "ENOENT" ? "not_found" : "probe_failed" })
      },
    )
  })

export function isBuiltInAgentHostId(
  value: string,
): value is BuiltInAgentHostId {
  return (BUILT_IN_AGENT_HOST_IDS as readonly string[]).includes(value)
}

export function getCliAgentHostDefinition(
  hostId: BuiltInAgentHostId,
): Readonly<CliAgentHostDefinition> {
  return CLI_AGENT_HOST_DEFINITIONS[hostId]
}

export async function probeCliAgentHost(
  hostId: BuiltInAgentHostId,
  executor: VersionCommandExecutor = executeVersionCommand,
): Promise<AgentHostProbeResult> {
  const definition = getCliAgentHostDefinition(hostId)
  const result = await executor(definition.command, [...definition.versionArgs])
  const issues = []

  if (result.status === "not_found") {
    issues.push({
      code: "host_executable_not_found",
      message: `${definition.displayName} executable was not found on PATH`,
      blocking: true,
    })
  } else if (result.status === "probe_failed") {
    issues.push({
      code: "host_version_probe_failed",
      message: `${definition.displayName} did not complete its version probe`,
      blocking: true,
    })
  } else {
    issues.push({
      code: "authentication_not_checked",
      message: "Executable is installed; login and model access were not checked",
      blocking: false,
    })
  }

  return {
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    hostId: definition.id,
    displayName: definition.displayName,
    status: result.status,
    available: result.status === "installed",
    adapterStatus: "probe_only",
    ...(result.output ? { version: result.output } : {}),
    capabilities: { ...definition.capabilities },
    capabilitySource: "adapter_declaration",
    issues,
  }
}

export async function probeCliAgentHosts(
  hostIds: readonly BuiltInAgentHostId[] = BUILT_IN_AGENT_HOST_IDS,
): Promise<AgentHostProbeResult[]> {
  return Promise.all(hostIds.map((hostId) => probeCliAgentHost(hostId)))
}
