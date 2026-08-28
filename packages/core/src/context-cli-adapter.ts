import { spawn } from "node:child_process"

import {
  ContextPortError,
  CONTEXT_MAX_BUNDLE_BYTES,
  CONTEXT_MAX_BUNDLE_ITEMS,
  validateContextBundle,
  type ContextBundle,
  type ContextPort,
  type ContextReadRequest,
} from "./context-port.js"

/**
 * Pinned adapter for the workbench context plane (#179 REQ-002). Spawns the
 * public `context adapter recall` CLI/stdio envelope (context repository
 * pinned at f63f57f) and re-validates the returned `context-bundle.v1`
 * envelope byte-for-byte. The runtime credential lives only in the spawned
 * server-side environment (`CONTEXT_RUNTIME_TOKEN`); it never enters argv,
 * the stdin request JSON, engine events, turn records, or evidence
 * (#179 REQ-005). The adapter is read-only: no write path exists.
 */
export interface ContextCliAdapterOptions {
  /**
   * Executable plus fixed arguments that reach the context CLI, e.g.
   * `["context"]` or an absolute path to a pinned build. The adapter always
   * appends the `adapter recall` subcommand.
   */
  command: readonly string[]
  /** Pinned workspace identifier of the grant binding. */
  workspaceId: string
  /** Pinned position identifier of the grant binding. */
  positionId: string
  /** Spawn/execution timeout in milliseconds (default 10 s). */
  timeoutMs?: number
  /** Environment passed to the spawned CLI (defaults to process.env). */
  env?: NodeJS.ProcessEnv
  /** Clock for freshness validation (defaults to the system clock). */
  now?: () => Date
  /** Optional bound on the accepted envelope age (see validateContextBundle). */
  maxAgeMs?: number
  /** Optional bound on accepted forward clock skew. */
  maxSkewMs?: number
}

const OPAQUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MAX_STDOUT_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 10_000

function classifyFailure(stderr: string): ContextPortError {
  // The pinned CLI reports failures as `context 失败: <bounded message>`.
  // Classification matches the exact pinned messages; anything unrecognized
  // fails closed as a denial — never as a transient outage.
  if (stderr.includes("runtime authority denied")) {
    return new ContextPortError(
      "CONTEXT_AUTH_DENIED",
      "The context runtime authority is denied, revoked, or expired.",
      { status: 403 },
    )
  }
  if (stderr.includes("scope authority denied")) {
    return new ContextPortError(
      "CONTEXT_SCOPE_MISMATCH",
      "The context authority scope does not match the pinned binding.",
      { status: 403 },
    )
  }
  if (stderr.includes("occurrence is not available")) {
    return new ContextPortError(
      "CONTEXT_NOT_FOUND",
      "The requested context occurrence is not available.",
      { status: 404 },
    )
  }
  if (stderr.includes("stored context record is invalid")) {
    return new ContextPortError(
      "CONTEXT_CORRUPT_RECORD",
      "The stored context record is invalid.",
    )
  }
  if (
    stderr.includes("adapter configuration is unavailable") ||
    stderr.includes("authority configuration is invalid")
  ) {
    return new ContextPortError(
      "CONTEXT_CONFIGURATION_INVALID",
      "The context adapter configuration is invalid.",
    )
  }
  return new ContextPortError(
    "CONTEXT_DENIED",
    "The context adapter failed closed.",
  )
}

export function createContextCliAdapter(
  options: ContextCliAdapterOptions,
): ContextPort {
  if (
    !Array.isArray(options.command) ||
    options.command.length === 0 ||
    options.command.some(
      (part) => typeof part !== "string" || part.length === 0,
    )
  ) {
    throw new ContextPortError(
      "CONTEXT_CONFIGURATION_INVALID",
      "The context adapter command is invalid.",
    )
  }
  if (
    !OPAQUE_PATTERN.test(options.workspaceId) ||
    !OPAQUE_PATTERN.test(options.positionId)
  ) {
    throw new ContextPortError(
      "CONTEXT_CONFIGURATION_INVALID",
      "The pinned context scope is invalid.",
    )
  }
  const [executable, ...fixedArgs] = options.command
  const pinnedPrincipal = `position.${options.positionId}`

  return {
    async recall(request: ContextReadRequest): Promise<ContextBundle> {
      // The pinned binding is authoritative: the request must match it
      // exactly and the principal is always derived (#179 REQ-003).
      if (
        request.workspaceId !== options.workspaceId ||
        request.positionId !== options.positionId ||
        request.principal !== pinnedPrincipal
      ) {
        throw new ContextPortError(
          "CONTEXT_SCOPE_MISMATCH",
          "The recall request does not match the pinned context binding.",
          { status: 403 },
        )
      }
      const maxItems =
        request.maxItems === undefined
          ? 20
          : boundedInteger(request.maxItems, CONTEXT_MAX_BUNDLE_ITEMS)
      const maxBytes =
        request.maxBytes === undefined
          ? 16_384
          : boundedInteger(request.maxBytes, CONTEXT_MAX_BUNDLE_BYTES)

      let stdout = ""
      let stderr = ""
      let exitCode: number | null = null
      let spawnFailed = false
      try {
        const result = await runCli(
          executable!,
          [...fixedArgs, "adapter", "recall"],
          // The recall request carries only bounds — never a credential.
          JSON.stringify({ maxItems, maxBytes }),
        )
        stdout = result.stdout
        stderr = result.stderr
        exitCode = result.exitCode
      } catch (error) {
        spawnFailed = true
        void error
      }
      if (spawnFailed || exitCode === null) {
        throw new ContextPortError(
          "CONTEXT_UNAVAILABLE",
          "The context adapter process could not be completed.",
          { retryable: true },
        )
      }
      if (exitCode !== 0) {
        throw classifyFailure(stderr)
      }
      let envelope: unknown
      try {
        envelope = JSON.parse(stdout)
      } catch {
        throw new ContextPortError(
          "CONTEXT_BUNDLE_INVALID",
          "The context adapter returned an unparseable envelope.",
        )
      }
      return validateContextBundle(
        envelope,
        {
          workspaceId: options.workspaceId,
          positionId: options.positionId,
          principal: pinnedPrincipal,
        },
        {
          maxItems,
          maxBytes,
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(options.maxAgeMs === undefined
            ? {}
            : { maxAgeMs: options.maxAgeMs }),
          ...(options.maxSkewMs === undefined
            ? {}
            : { maxSkewMs: options.maxSkewMs }),
        },
      )
    },
  }

  function boundedInteger(value: number, max: number): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) {
      throw new ContextPortError(
        "CONTEXT_CONFIGURATION_INVALID",
        "The context recall bounds are invalid.",
      )
    }
    return value
  }

  function runCli(
    command: string,
    args: readonly string[],
    payload: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        env: options.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
      })
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      let settled = false
      let stdout = ""
      let stderr = ""
      let stdoutBytes = 0
      let stderrBytes = 0
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill("SIGKILL")
        reject(new Error("timeout"))
      }, timeoutMs)
      child.on("error", (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      })
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength
        if (stdoutBytes > MAX_STDOUT_BYTES) {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            child.kill("SIGKILL")
            reject(new Error("stdout overflow"))
          }
          return
        }
        stdout += chunk.toString("utf8")
      })
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength
        if (stderrBytes > MAX_STDOUT_BYTES) {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            child.kill("SIGKILL")
            reject(new Error("stderr overflow"))
          }
          return
        }
        stderr += chunk.toString("utf8")
      })
      child.on("close", (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ stdout, stderr, exitCode: code })
      })
      child.stdin.end(payload)
    })
  }
}
