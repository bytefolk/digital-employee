import { spawn } from "node:child_process"

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
import {
  signalAgentHostProcessTree,
  waitForAgentHostProcessTreeExit,
} from "./agent-host-process-tree.js"
import { resolveWindowsExecutable } from "./windows-exec.js"

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
    "installed" | "not_found" | "not_spawnable" | "probe_failed"
  >
  output?: string
}

export type VersionCommandExecutor = (
  command: string,
  args: string[],
  options?: { signal?: AbortSignal },
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
  options = {},
) =>
  new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ status: "probe_failed" })
      return
    }
    // On Windows, spawn(cmd, { shell: false }) hands the bare name to
    // CreateProcess, which does not apply PATHEXT — so `.cmd`/`.bat` shims
    // (the format npm installs global CLIs as) surface as ENOENT and get
    // collapsed into host_executable_not_found even though `where` resolves
    // them. Mirror the OS resolver: walk PATH × PATHEXT to a concrete file,
    // and spawn a resolved shim through cmd.exe. The argv vector here is a
    // compile-time constant declared by the adapter definitions ("--version",
    // optionally prefixed by a fixed "-p" / "code"), never user input, so the
    // DEP0190 unquoted-argument concern for shell:true does not apply.
    let spawnCommand = command
    let spawnShell: boolean = false
    let resolvedOnWindows = false
    if (process.platform === "win32") {
      const resolved = resolveWindowsExecutable(command)
      if (resolved) {
        spawnCommand = resolved.command
        spawnShell = resolved.needsShell
        resolvedOnWindows = true
      }
    }
    let child
    try {
      child = spawn(spawnCommand, args, {
        detached: process.platform !== "win32",
        env: versionProbeEnvironment(process.env),
        shell: spawnShell,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      resolve({
        status: code === "ENOENT"
          ? resolvedOnWindows
            ? "not_spawnable"
            : "not_found"
          : resolvedOnWindows
          ? "not_spawnable"
          : "probe_failed",
      })
      return
    }
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settling = false
    const outputLimit = 64 * 1024
    let timer: NodeJS.Timeout | undefined

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener("abort", abort)
    }
    const settle = async (result: VersionCommandResult) => {
      if (settling) return
      settling = true
      cleanup()
      // A version probe is disposable. Always terminate the detached group so
      // a wrapper cannot leave descendants after its leader exits, and do not
      // release the caller's admission slot until the group is gone.
      signalAgentHostProcessTree(child, "SIGKILL")
      await waitForAgentHostProcessTreeExit(child, 5_000)
      resolve(result)
    }
    const abort = () => {
      void settle({ status: "probe_failed" })
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > outputLimit) {
        void settle({ status: "probe_failed" })
        return
      }
      stdout.push(Buffer.from(chunk))
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength
      if (stderrBytes > outputLimit) {
        void settle({ status: "probe_failed" })
        return
      }
      stderr.push(Buffer.from(chunk))
    })
    child.once("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code
      void settle({
        status: code === "ENOENT"
          ? resolvedOnWindows
            ? "not_spawnable"
            : "not_found"
          : resolvedOnWindows
          ? "not_spawnable"
          : "probe_failed",
      })
    })
    child.once("close", (code) => {
      void settle(
        code === 0
          ? {
              status: "installed",
              output:
                cleanVersionOutput(Buffer.concat(stdout).toString("utf8")) ??
                cleanVersionOutput(Buffer.concat(stderr).toString("utf8")),
            }
          : { status: "probe_failed" },
      )
    })
    options.signal?.addEventListener("abort", abort, { once: true })
    timer = setTimeout(abort, 10_000)
    timer.unref()
    if (options.signal?.aborted) abort()
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
  } else if (result.status === "not_spawnable") {
    issues.push({
      code: "host_executable_not_spawnable",
      message: `${definition.displayName} executable was resolved on PATH but could not be spawned`,
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
