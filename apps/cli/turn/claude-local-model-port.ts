/**
 * Local-operator Claude Code model port (#182).
 *
 * Drives the `claude` binary already installed and authenticated on the local
 * operator's machine, so a turn runs without `ANTHROPIC_API_KEY`. The port is
 * a pure inference seam: Claude Code runs with an empty tool, MCP, skill and
 * slash-command set, and the engine keeps ownership of the turn loop, budget
 * accounting, doom-loop detection and output validation.
 *
 * Boundary (#182 REQ-003, docs/agent-hosts.md): this port never reads, parses
 * or forwards any credential store. It spawns the official binary and lets
 * Claude Code resolve its own authentication. `HOME` and `CLAUDE_CONFIG_DIR`
 * are deliberately left untouched — that is the entire mechanism by which the
 * operator's existing login becomes visible.
 *
 * Scope (#182 non-goals): local operator use only. It is not for unattended
 * servers, multi-tenant execution, running third-party tasks, or resale, and
 * no credential may be bundled into a distributed employee package. The
 * isolated `ANTHROPIC_API_KEY` adapter in claude-agent-host.ts remains the
 * only option for those deployments.
 */

import { spawn, spawnSync } from "node:child_process"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"

import type { ModelPort, ModelTurnInput, ModelTurnResult } from "../../../packages/engine/src/model-port.js"
import {
  ClaudeStreamProtocolError,
  ClaudeZeroToolStreamNormalizer,
} from "../claude-stream-agent-host.js"

/**
 * Authentication sources accepted as a genuine operator login.
 *
 * `claude_cli_oauth` is the label the isolated adapter's own fixtures already
 * record for an operator-authenticated CLI. Deliberately excluded:
 *
 *   - `ANTHROPIC_API_KEY` — a service credential; this port must not be a
 *     second, unqualified path to the isolated adapter's deployment mode.
 *   - `none` — verified against Claude Code 2.1.223 to mean *not logged in*:
 *     the run answers `Not logged in · Please run /login` with
 *     `error: authentication_failed`. Accepting it would let an
 *     unauthenticated run past this gate, so it maps to its own actionable
 *     failure below instead.
 *
 * An unrecognized source fails closed. If a future release announces a
 * different operator-login label, the run reports a policy mismatch naming the
 * announced value rather than silently degrading.
 */
const LOCAL_API_KEY_SOURCES: readonly string[] = ["claude_cli_oauth"]

/** Claude Code announces this when no operator login is present. */
const NOT_LOGGED_IN_SOURCE = "none"
/** Same conformance-verified window as the isolated adapter. */
const MIN_CLAUDE_VERSION = [2, 1, 214] as const
const MAX_CLAUDE_VERSION = [2, 2, 0] as const
const DEFAULT_TIMEOUT_MS = 240_000
const MAX_STDOUT_BYTES = 4 * 1024 * 1024
const MAX_STDERR_BYTES = 256 * 1024
const MAX_LINE_BYTES = 1024 * 1024
const MAX_PROMPT_BYTES = 256 * 1024
const TERMINATION_GRACE_MS = 2_000

/**
 * Hardening kept from the isolated adapter (#182 OQ-2). The operator's real
 * HOME stays visible so their login works, so the exposure that can be closed
 * without breaking authentication is closed here: no project memory, no
 * attachments, no background work, no IDE handshake.
 */
const HARDENING_ENVIRONMENT: Readonly<Record<string, string>> = {
  CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1",
  CLAUDE_CODE_AUTO_CONNECT_IDE: "false",
  CLAUDE_CODE_DISABLE_ATTACHMENTS: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  CLAUDE_CODE_DISABLE_CRON: "1",
  CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: "1",
  DISABLE_UPDATES: "1",
}

export class ClaudeLocalModelPortError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code)
    this.name = "ClaudeLocalModelPortError"
  }
}

export interface ClaudeLocalModelPortOptions {
  /** Binary to spawn; defaults to `claude` resolved from PATH. */
  command?: string
  /** Arguments prepended before the pinned flag set. Test seam. */
  commandPrefixArgs?: readonly string[]
  /** Inherited process environment. Test seam. */
  environment?: NodeJS.ProcessEnv
  timeoutMs?: number
  /** Test seams. */
  now?: () => string
  newRunId?: () => string
}

function versionAtLeast(
  parts: readonly [number, number, number],
  bound: readonly [number, number, number],
): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (parts[index]! > bound[index]!) return true
    if (parts[index]! < bound[index]!) return false
  }
  return true
}

function versionBelow(
  parts: readonly [number, number, number],
  bound: readonly [number, number, number],
): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (parts[index]! < bound[index]!) return true
    if (parts[index]! > bound[index]!) return false
  }
  return false
}

/** Same pinned window as the isolated adapter: >=2.1.214 and <2.2.0. */
export function isSupportedLocalClaudeVersion(value: string | undefined): boolean {
  if (typeof value !== "string") return false
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(value)
  if (!match) return false
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as [
    number,
    number,
    number,
  ]
  if (parts.some((part) => !Number.isSafeInteger(part) || part < 0)) return false
  return (
    versionAtLeast(parts, MIN_CLAUDE_VERSION) &&
    versionBelow(parts, MAX_CLAUDE_VERSION)
  )
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

/** True for an init frame announcing that no operator login is present. */
function isNotLoggedInInit(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const frame = value as Record<string, unknown>
  return (
    frame.type === "system" &&
    frame.subtype === "init" &&
    frame.apiKeySource === NOT_LOGGED_IN_SOURCE
  )
}

function spawnArgs(prefix: readonly string[]): string[] {
  return [
    ...prefix,
    "--bare",
    "--print",
    "--input-format",
    "text",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    "dontAsk",
    "--tools",
    "",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-chrome",
    "--no-session-persistence",
    "--max-turns",
    "1",
  ]
}

/**
 * Build the child environment. Deliberately additive over the inherited
 * environment: `HOME` and `CLAUDE_CONFIG_DIR` are never set here, which is
 * what lets Claude Code find the operator's own login. `ANTHROPIC_API_KEY` is
 * stripped so this port cannot silently fall back to a service credential and
 * report an authentication source it did not verify.
 */
export function localRunEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...source, ...HARDENING_ENVIRONMENT }
  delete result.ANTHROPIC_API_KEY
  return result
}

/**
 * Precondition probe, run before the turn starts.
 *
 * `turn run` reserves exit 1 for spawn-level failures including a missing
 * model credential, and exit 0 for modeled governance verdicts. A missing or
 * out-of-window `claude` is an environment fault, not a verdict about the
 * employee, so it has to surface during port resolution — otherwise the engine
 * models it as a failed turn and reports exit 0.
 *
 * Returns an error code, or undefined when the binary is usable. Login state
 * is deliberately not probed here: it is asserted from the announced
 * `apiKeySource` in the run stream, so no credential store is ever inspected.
 */
export function probeLocalClaude(
  command: string,
  prefixArgs: readonly string[] = [],
  timeoutMs = 10_000,
): string | undefined {
  let probe: ReturnType<typeof spawnSync>
  try {
    probe = spawnSync(command, [...prefixArgs, "--version"], {
      encoding: "utf8",
      timeout: timeoutMs,
      shell: false,
      windowsHide: true,
    })
  } catch {
    return "claude_local_binary_unavailable"
  }
  if (probe.error !== undefined || probe.status !== 0) {
    return "claude_local_binary_unavailable"
  }
  const announced = typeof probe.stdout === "string" ? probe.stdout : undefined
  if (!isSupportedLocalClaudeVersion(announced)) {
    return "claude_local_version_not_supported"
  }
  return undefined
}

export function createClaudeLocalModelPort(
  options: ClaudeLocalModelPortOptions = {},
): ModelPort {
  const command = options.command ?? "claude"
  const commandPrefixArgs = options.commandPrefixArgs ?? []
  const environment = options.environment ?? process.env
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const now = options.now ?? (() => new Date().toISOString())
  const newRunId = options.newRunId ?? (() => `claude-local-${process.pid}`)

  return {
    async complete(
      input: ModelTurnInput,
      signal?: AbortSignal,
    ): Promise<ModelTurnResult> {
      if (signal?.aborted) {
        throw new ClaudeLocalModelPortError("claude_local_aborted")
      }
      const prompt = renderPrompt(input)
      if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
        throw new ClaudeLocalModelPortError("claude_local_prompt_too_large")
      }

      // An empty scratch cwd: the run has no tools, so nothing may be read
      // from it, and the announced `cwd` stays assertable.
      const runRoot = await mkdtemp(path.join(os.tmpdir(), "digital-employee-claude-local-"))
      let child: ReturnType<typeof spawn> | undefined
      try {
        const expectedCwd = await realpath(runRoot)
        child = spawn(command, spawnArgs(commandPrefixArgs), {
          cwd: expectedCwd,
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: localRunEnvironment(environment),
        })
        const active = child

        const normalizer = new ClaudeZeroToolStreamNormalizer({
          runId: newRunId(),
          expectedCwd,
          versionSupported: isSupportedLocalClaudeVersion,
          now,
          expectedApiKeySources: LOCAL_API_KEY_SOURCES,
        })

        return await new Promise<ModelTurnResult>((resolve, reject) => {
          let settled = false
          let stdoutBytes = 0
          let stderrBytes = 0
          let stderrText = ""
          let timer: NodeJS.Timeout | undefined
          let onAbort: (() => void) | undefined

          const finish = (outcome: () => void): void => {
            if (settled) return
            settled = true
            if (timer) clearTimeout(timer)
            if (onAbort && signal) signal.removeEventListener("abort", onAbort)
            outcome()
          }

          const fail = (code: string, message?: string): void => {
            finish(() => {
              killTree(active)
              reject(new ClaudeLocalModelPortError(code, message))
            })
          }

          timer = setTimeout(() => fail("claude_local_deadline_exceeded"), timeoutMs)
          if (signal) {
            onAbort = () => fail("claude_local_aborted")
            signal.addEventListener("abort", onAbort, { once: true })
          }

          active.on("error", () => fail("claude_local_spawn_failed"))

          active.stderr?.on("data", (chunk: Buffer) => {
            stderrBytes += chunk.byteLength
            if (stderrBytes > MAX_STDERR_BYTES) {
              fail("claude_local_stderr_limit")
              return
            }
            if (stderrText.length < 2048) stderrText += String(chunk)
          })

          const lines = createInterface({ input: active.stdout!, crlfDelay: Infinity })
          lines.on("line", (line) => {
            if (settled) return
            stdoutBytes += Buffer.byteLength(line, "utf8") + 1
            if (stdoutBytes > MAX_STDOUT_BYTES) {
              fail("claude_local_stdout_limit")
              return
            }
            if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
              fail("claude_local_line_too_large")
              return
            }
            if (line.trim().length === 0) return
            let parsed: unknown
            try {
              parsed = JSON.parse(line)
            } catch {
              fail("claude_local_stream_not_json")
              return
            }
            // "Failure still has a path": a missing login is the most likely
            // first-run fault, and the announced init already says so. Name it
            // before the generic policy assertion turns it into a mismatch.
            if (isNotLoggedInInit(parsed)) {
              fail(
                "claude_local_not_logged_in",
                "the local Claude Code install has no operator login: run `claude /login` and retry",
              )
              return
            }
            try {
              normalizer.accept(parsed)
            } catch (error) {
              fail(
                error instanceof ClaudeStreamProtocolError
                  ? error.message
                  : "claude_local_stream_invalid",
              )
            }
          })

          active.on("close", (exitCode) => {
            if (settled) return
            if (exitCode !== 0) {
              fail(
                "claude_local_process_failed",
                `claude exited with code ${String(exitCode)}${
                  stderrText.length > 0 ? `: ${stderrText.trim()}` : ""
                }`,
              )
              return
            }
            let completion
            try {
              // No output validator: the engine owns schema validation, so the
              // port hands back text and usage only.
              completion = normalizer.finish(undefined)
            } catch (error) {
              fail(
                error instanceof ClaudeStreamProtocolError
                  ? error.message
                  : "claude_local_stream_invalid",
              )
              return
            }
            const text = completion.output
            if (typeof text !== "string") {
              fail("claude_local_result_text_missing")
              return
            }
            finish(() =>
              resolve({
                text,
                inputTokens: completion.usage.inputTokens,
                outputTokens: completion.usage.outputTokens,
              }),
            )
          })

          active.stdin!.on("error", () => fail("claude_local_stdin_failed"))
          active.stdin!.end(prompt)
        })
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
          killTree(child)
        }
        await rm(runRoot, { recursive: true, force: true }).catch(() => undefined)
      }
    },
  }
}

function killTree(child: ReturnType<typeof spawn>): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGTERM")
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
  }, TERMINATION_GRACE_MS)
  timer.unref()
}
