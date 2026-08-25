/**
 * Isolated-service Qoder model port (#185).
 *
 * Wraps the conformance-verified `QoderAgentHostAdapter` as a zero-tool
 * `ModelPort` for the `turn run` spawn surface. The engine keeps ownership of
 * the turn loop, budget accounting, doom-loop detection and output schema
 * validation; this port is a pure inference seam.
 *
 * Credential boundary (#185 REQ-003): the only credential input is
 * `QODER_PERSONAL_ACCESS_TOKEN` read from the inherited process environment.
 * The token never appears in argv, envelope fields, events or diagnostics; it
 * flows through the adapter's existing auth-payload file discipline (0600,
 * run-local, removed on cleanup) unchanged.
 *
 * Usage honesty (#185 AC-005): the adapter's usage events are not a stable
 * contract (`usage_events: unknown`), so this port returns text only and no
 * token counts. Token budget accounting records zero for this port;
 * iteration budgets still apply.
 */

import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { AgentHostPolicy } from "../../../packages/core/src/agent-host.js"
import type {
  ModelPort,
  ModelTurnInput,
  ModelTurnResult,
} from "../../../packages/engine/src/model-port.js"
import {
  createQoderAgentHostAdapter,
  isConformantQoderCliVersion,
} from "../qoder-agent-host.js"

export class QoderModelPortError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code)
    this.name = "QoderModelPortError"
  }
}

/**
 * The port's defining constraint: zero tools. No filesystem grants, no
 * network, no approval surface, no MCP, a single host turn. The adapter
 * rejects any deviation from this shape, and its init assertion re-checks the
 * announced tool set against it at runtime.
 */
const ZERO_TOOL_POLICY: AgentHostPolicy = {
  tools: { default: "deny", allow: [] },
  filesystem: { read: [], write: [] },
  network: { mode: "deny" },
  approval: { mode: "never" },
  maxTurns: 1,
}

export interface QoderModelPortOptions {
  /** Binary to spawn; defaults to `qodercli` resolved from PATH. */
  command?: string
  /** Arguments prepended before the adapter's pinned flag set. Test seam. */
  commandPrefixArgs?: readonly string[]
  /** Inherited process environment. Test seam. */
  environment?: NodeJS.ProcessEnv
  timeoutMs?: number
  /** Test seam. */
  now?: () => Date
}

/**
 * Precondition probe, run before the turn starts (#185 REQ-004).
 *
 * `turn run` reserves exit 1 for spawn-level failures including a missing
 * model credential, and exit 0 for modeled governance verdicts. A missing or
 * out-of-family `qodercli` is an environment fault, not a verdict about the
 * employee, so it surfaces during port resolution. Token validity itself is
 * deliberately not probed: only a run verifies model access.
 *
 * Returns an error code, or undefined when the binary is usable.
 */
export function probeQoderModelPort(
  command: string,
  prefixArgs: readonly string[] = [],
  timeoutMs = 10_000,
): string | undefined {
  // The adapter's process-group cleanup discipline is POSIX-only.
  if (process.platform === "win32") {
    return "host_platform_not_conformance_verified"
  }
  let probe: ReturnType<typeof spawnSync>
  try {
    probe = spawnSync(command, [...prefixArgs, "--version"], {
      encoding: "utf8",
      timeout: timeoutMs,
      shell: false,
      windowsHide: true,
    })
  } catch {
    return "qoder_binary_unavailable"
  }
  if (probe.error !== undefined || probe.status !== 0) {
    return "qoder_binary_unavailable"
  }
  const announced = typeof probe.stdout === "string" ? probe.stdout : undefined
  if (!isConformantQoderCliVersion(announced)) {
    return "qoder_version_not_conformance_verified"
  }
  return undefined
}

/**
 * Render the assembled context into one prompt. Slots arrive already ordered
 * and window-managed by the engine's context assembler; prior output
 * violations are appended so the engine's repair loop stays observable to the
 * model without giving it a tool surface.
 */
function renderPrompt(input: ModelTurnInput): string {
  const sections = input.blocks.map((block) => `## ${block.slot}\n${block.text}`)
  if (input.priorViolations.length > 0) {
    const violations = input.priorViolations
      .map((entry) => `- attempt ${entry.attempt}: ${entry.summary}`)
      .join("\n")
    sections.push(`## output_violations\n${violations}`)
  }
  return sections.join("\n\n")
}

export function createQoderModelPort(
  options: QoderModelPortOptions = {},
): ModelPort {
  const adapter = createQoderAgentHostAdapter({
    ...(options.command !== undefined ? { command: options.command } : {}),
    ...(options.commandPrefixArgs !== undefined
      ? { commandPrefixArgs: [...options.commandPrefixArgs] }
      : {}),
    ...(options.environment !== undefined
      ? { environment: options.environment }
      : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  })

  return {
    async complete(
      input: ModelTurnInput,
      signal?: AbortSignal,
    ): Promise<ModelTurnResult> {
      if (signal?.aborted) {
        throw new QoderModelPortError("qoder_run_cancelled")
      }
      const prompt = renderPrompt(input)
      // Empty scratch working directory: the adapter requires a real
      // directory, and with zero projection there is nothing to read from it.
      const scratch = await mkdtemp(
        path.join(os.tmpdir(), "digital-employee-qoder-port-"),
      )
      try {
        let output: unknown
        let completed = false
        let terminalError:
          | { code: string; message: string; retryable: boolean }
          | undefined
        for await (const event of adapter.run({
          runId: randomUUID(),
          employeeId: "turn-run",
          workingDirectory: scratch,
          prompt,
          policy: ZERO_TOOL_POLICY,
          ...(signal !== undefined ? { signal } : {}),
        })) {
          if (event.type === "run.completed") {
            output = event.output
            completed = true
          } else if (event.type === "run.failed") {
            terminalError = event.error
          }
        }
        if (!completed) {
          throw new QoderModelPortError(
            terminalError?.code ?? "qoder_terminal_missing",
            terminalError?.message,
          )
        }
        const text =
          typeof output === "string" ? output : JSON.stringify(output)
        return { text }
      } finally {
        await rm(scratch, { recursive: true, force: true }).catch(
          () => undefined,
        )
      }
    },
  }
}
