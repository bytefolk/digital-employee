import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { dirname } from "node:path"
import { readFile } from "node:fs/promises"

import { Ajv2020 } from "ajv/dist/2020.js"

import { CoreError } from "../../packages/core/src/contracts.js"
import type {
  AgentHostAdapter,
  AgentHostEvent,
  AgentHostProbeResult,
  AgentHostRunRequest,
} from "../../packages/core/src/agent-host.js"
import {
  validateAgentHostEventWire,
  validateAgentHostRunRequestWire,
} from "../../packages/core/src/agent-host-wire.js"
import type { AgentHostRegistration } from "../../packages/core/src/agent-host-registry.js"
import type { StdioAdapterConfig } from "../../packages/core/src/agent-host-stdio-config.js"
import { stdioAdapterEnvironment } from "../../packages/core/src/agent-host-stdio-config.js"
import {
  AGENT_HOST_STDIO_PROTOCOL_VERSION,
  encodeAgentHostStdioLine,
  parseAgentHostStdioHostLine,
  probeResultFromStdioResponse,
} from "../../packages/core/src/agent-host-stdio.js"
import type { AgentHostStdioMessage } from "../../packages/core/src/agent-host-stdio.js"
import {
  signalAgentHostProcessTree,
  waitForAgentHostProcessTreeExit,
} from "./agent-host-process-tree.js"

const STDIO_CODES = {
  digestMismatch: "agent_host_stdio_digest_mismatch",
  spawnFailed: "agent_host_stdio_spawn_failed",
  timeout: "agent_host_stdio_timeout",
  badFraming: "agent_host_stdio_bad_framing",
  hostError: "agent_host_stdio_host_error",
  terminalContractViolated: "agent_host_terminal_contract_violated",
  cleanupFailed: "agent_host_stdio_cleanup_failed",
  streamFailed: "agent_host_stream_failed",
  outputSchemaInvalid: "agent_host_stdio_output_schema_invalid",
  outputSchemaMismatch: "agent_host_stdio_output_schema_mismatch",
} as const

const MAX_OUTPUT_SCHEMA_BYTES = 16 * 1024

function stdioError(
  code: string,
  message: string,
  details?: unknown,
): CoreError {
  return new CoreError(code, message, {
    status: 502,
    retryable: false,
    details,
  })
}

interface PreparedOutputSchema {
  validate: (output: unknown) => boolean
}

/**
 * Compiles the run output schema synchronously before any host exchange.
 * Invalid, oversized, or `$async` schemas fail closed here so an unusable
 * schema never reaches a model process.
 */
function prepareOutputSchema(
  schema: unknown,
): PreparedOutputSchema | undefined {
  if (schema === undefined) return undefined
  try {
    const serialized = JSON.stringify(schema)
    if (
      !serialized ||
      Buffer.byteLength(serialized, "utf8") > MAX_OUTPUT_SCHEMA_BYTES
    ) {
      throw stdioError(
        STDIO_CODES.outputSchemaInvalid,
        "run output schema is too large",
      )
    }
    const ajv = new Ajv2020({
      allErrors: true,
      allowUnionTypes: true,
      strict: false,
      validateSchema: true,
    })
    const validate = ajv.compile(JSON.parse(serialized) as object)
    if ("$async" in validate && validate.$async === true) {
      throw stdioError(
        STDIO_CODES.outputSchemaInvalid,
        "run output schema must be synchronous",
      )
    }
    return { validate: (output: unknown) => Boolean(validate(output)) }
  } catch (error) {
    if (error instanceof CoreError) throw error
    throw stdioError(
      STDIO_CODES.outputSchemaInvalid,
      "run output schema is not a valid JSON Schema",
    )
  }
}

interface StreamState {
  queue: AgentHostStdioMessage[]
  notify: (() => void) | null
  closed: boolean
  failure: CoreError | null
}

/**
 * SDK client for one digest-pinned external Adapter speaking
 * agent-host-stdio.v1. Every violation (digest mismatch, bad framing,
 * unknown fields, duplicate terminals, timeout) fails closed and the
 * detached process tree is always signalled on disposal.
 */
export class ExternalStdioAgentHostAdapter implements AgentHostAdapter {
  readonly hostId: string

  private readonly config: StdioAdapterConfig
  private readonly qualificationConfigurationDigest: string
  private child: ChildProcess | null = null
  private stdoutCarry = ""
  private stderrTail = ""
  private sequence = 0
  private readonly pending = new Map<
    string,
    { resolve: (message: AgentHostStdioMessage) => void }
  >()
  private readonly streams = new Map<string, StreamState>()
  private exited = false

  constructor(config: StdioAdapterConfig) {
    this.config = config
    this.hostId = config.hostId
    this.qualificationConfigurationDigest = createHash("sha256")
      .update(
        JSON.stringify({
          schema: config.schema,
          hostId: config.hostId,
          displayName: config.displayName,
          executable: config.executable,
          args: [...config.args],
          digest: {
            algorithm: config.digest.algorithm,
            hex: config.digest.hex,
          },
          envAllowlist: [...config.envAllowlist],
          workingDirectoryPolicy: config.workingDirectoryPolicy,
          timeoutMs: config.timeoutMs,
          maxStderrBytes: config.maxStderrBytes,
        }),
      )
      .digest("hex")
  }

  /** Bounded stderr diagnostics tail; raw stderr is never surfaced unbounded. */
  diagnosticsTail(): string {
    return this.stderrTail
  }

  async probe(): Promise<AgentHostProbeResult> {
    const message = await this.exchange("probe")
    return probeResultFromStdioResponse(message, this.hostId)
  }

  async preflight(request: AgentHostRunRequest): Promise<AgentHostProbeResult> {
    prepareOutputSchema(request.outputSchema)
    const payload = validateAgentHostRunRequestWire(this.wirePayload(request))
    const message = await this.exchange("preflight", payload)
    return probeResultFromStdioResponse(message, this.hostId)
  }

  async qualificationIdentity(): Promise<{
    configurationDigest: string
    ownerPid: number
  }> {
    const child = await this.ensureChild()
    if (child.pid === undefined) {
      throw stdioError(
        STDIO_CODES.spawnFailed,
        "stdio adapter process has no qualification owner pid",
      )
    }
    return {
      configurationDigest: this.qualificationConfigurationDigest,
      ownerPid: child.pid,
    }
  }

  async *run(request: AgentHostRunRequest): AsyncGenerator<AgentHostEvent> {
    let preparedSchema: PreparedOutputSchema | undefined
    try {
      // Enforced before any host exchange: an invalid schema must never
      // spawn a run or reach a model process.
      preparedSchema = prepareOutputSchema(request.outputSchema)
    } catch {
      yield {
        type: "run.failed",
        runId: request.runId,
        timestamp: new Date().toISOString(),
        error: {
          code: STDIO_CODES.outputSchemaInvalid,
          message: "run output schema is invalid",
          retryable: false,
        },
      }
      return
    }
    const payload = validateAgentHostRunRequestWire(this.wirePayload(request))
    const child = await this.ensureChild()
    const id = this.nextId()
    const state: StreamState = {
      queue: [],
      notify: null,
      closed: false,
      failure: null,
    }
    this.streams.set(id, state)
    const timer = setTimeout(() => {
      this.failStream(id, stdioError(STDIO_CODES.timeout, "stdio run timed out"))
      void this.cancel(request.runId).catch(() => {})
      signalAgentHostProcessTree(child, "SIGTERM")
    }, this.config.timeoutMs)
    timer.unref?.()
    try {
      this.writeLine({
        protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
        id,
        kind: "run",
        payload,
      })
      let sawTerminal = false
      while (true) {
        const message = await this.nextMessage(id, state)
        if (message === null) {
          if (!sawTerminal) {
            throw stdioError(
              STDIO_CODES.terminalContractViolated,
              "stdio run stream closed without a terminal event",
            )
          }
          return
        }
        if (message.kind === "event") {
          if (sawTerminal) {
            throw stdioError(
              STDIO_CODES.terminalContractViolated,
              "stdio adapter emitted an event after the terminal outcome",
            )
          }
          const event = validateAgentHostEventWire(message.event)
          if (event.type === "run.completed" && preparedSchema !== undefined) {
            if (!preparedSchema.validate(event.output)) {
              // The terminal output is replaced, never echoed: raw output
              // bytes must not surface in the failure event. The mandated
              // closing response is still drained below so it cannot arrive
              // after this stream id is torn down.
              yield {
                type: "run.failed",
                runId: request.runId,
                timestamp: new Date().toISOString(),
                error: {
                  code: STDIO_CODES.outputSchemaMismatch,
                  message:
                    "agent host output did not match the run output schema",
                  retryable: false,
                },
              }
              sawTerminal = true
              continue
            }
          }
          yield event
          if (
            message.event.type === "run.completed" ||
            message.event.type === "run.failed"
          ) {
            sawTerminal = true
          }
          continue
        }
        if (message.kind !== "response") {
          throw stdioError(
            STDIO_CODES.streamFailed,
            "stdio run exchange received an unexpected message",
          )
        }
        if (message.ok !== true) {
          throw stdioError(
            STDIO_CODES.hostError,
            "agent host rejected the stdio run",
            { code: message.error.code, retryable: message.error.retryable },
          )
        }
        // A success response after the terminal closes the exchange.
        if (!sawTerminal) {
          throw stdioError(
            STDIO_CODES.terminalContractViolated,
            "stdio run response arrived before any terminal event",
          )
        }
        return
      }
    } finally {
      clearTimeout(timer)
      this.streams.delete(id)
    }
  }

  async cancel(runId: string): Promise<void> {
    if (this.exited) return
    const id = this.nextId()
    // A host may acknowledge the cancel exchange itself; without a waiter the
    // reply would be dispatched as an unsolicited protocol violation.
    const waiter: { resolve: (message: AgentHostStdioMessage) => void } = {
      resolve: () => {},
    }
    this.pending.set(id, waiter)
    const timer = setTimeout(() => {
      this.pending.delete(id)
    }, this.config.timeoutMs)
    timer.unref?.()
    try {
      this.writeLine({
        protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
        id,
        kind: "cancel",
        payload: { runId },
      })
    } catch {
      clearTimeout(timer)
      this.pending.delete(id)
      return
    }
  }

  /** Signals the detached process tree and verifies it is gone. */
  async dispose(): Promise<void> {
    const child = this.child
    this.failAllStreams(
      stdioError(STDIO_CODES.cleanupFailed, "stdio adapter disposed"),
    )
    if (!child || child.pid === undefined) {
      this.exited = true
      return
    }
    signalAgentHostProcessTree(child, "SIGTERM")
    if (!(await waitForAgentHostProcessTreeExit(child, 2_000))) {
      signalAgentHostProcessTree(child, "SIGKILL")
      if (!(await waitForAgentHostProcessTreeExit(child, 2_000))) {
        throw stdioError(
          STDIO_CODES.cleanupFailed,
          "stdio adapter process tree did not exit after SIGTERM and SIGKILL",
        )
      }
    }
    this.exited = true
  }

  private wirePayload(request: AgentHostRunRequest): AgentHostRunRequest {
    const { signal: _runtimeSignal, ...wire } = request
    return wire
  }

  private nextId(): string {
    this.sequence += 1
    return `${this.hostId}-${this.sequence}`
  }

  private async exchange(
    kind: "probe" | "preflight",
    payload?: AgentHostRunRequest,
  ): Promise<AgentHostStdioMessage> {
    await this.ensureChild()
    const id = this.nextId()
    const waiter: { resolve: (message: AgentHostStdioMessage) => void } = {
      resolve: () => {},
    }
    const received = new Promise<AgentHostStdioMessage>((resolve) => {
      waiter.resolve = resolve
    })
    this.pending.set(id, waiter)
    const timer = setTimeout(() => {
      if (this.pending.delete(id)) {
        waiter.resolve({
          protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
          id,
          kind: "response",
          ok: false,
          error: {
            code: STDIO_CODES.timeout,
            message: "stdio exchange timed out",
            retryable: false,
          },
        })
      }
    }, this.config.timeoutMs)
    timer.unref?.()
    try {
      this.writeLine({
        protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
        id,
        kind,
        ...(payload ? { payload } : {}),
      })
      return await received
    } finally {
      clearTimeout(timer)
      this.pending.delete(id)
    }
  }

  private writeLine(message: unknown): void {
    const child = this.child
    const stdin = child?.stdin
    if (!child || !stdin || stdin.destroyed || this.exited) {
      throw stdioError(
        STDIO_CODES.spawnFailed,
        "stdio adapter process is not running",
      )
    }
    stdin.write(`${encodeAgentHostStdioLine(message)}\n`)
  }

  private async ensureChild(): Promise<ChildProcess> {
    if (this.child && !this.exited && this.child.exitCode === null) {
      return this.child
    }
    let bytes: Buffer
    try {
      bytes = await readFile(this.config.executable)
    } catch {
      throw stdioError(
        STDIO_CODES.spawnFailed,
        "stdio adapter executable is not readable",
        { hostId: this.hostId },
      )
    }
    const digest = createHash("sha256").update(bytes).digest("hex")
    if (digest !== this.config.digest.hex) {
      throw stdioError(
        STDIO_CODES.digestMismatch,
        "stdio adapter executable does not match the pinned sha256 digest",
        { hostId: this.hostId },
      )
    }
    const child = spawn(this.config.executable, [...this.config.args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: stdioAdapterEnvironment(this.config),
      cwd:
        this.config.workingDirectoryPolicy === "config_directory"
          ? dirname(this.config.executable)
          : process.cwd(),
      detached: process.platform !== "win32",
    })
    this.child = child
    this.exited = false
    child.on("error", () => {
      this.failAllStreams(
        stdioError(STDIO_CODES.spawnFailed, "stdio adapter failed to start"),
      )
      for (const waiter of this.pending.values()) {
        waiter.resolve(this.errorResponse("spawn_failed"))
      }
      this.pending.clear()
    })
    child.on("exit", () => {
      this.exited = true
      this.failAllStreams(
        stdioError(
          STDIO_CODES.streamFailed,
          "stdio adapter exited before completing the stream",
        ),
      )
      for (const waiter of this.pending.values()) {
        waiter.resolve(this.errorResponse("adapter_exited"))
      }
      this.pending.clear()
    })
    // Pipe failures on a dead Adapter are expected teardown conditions; they
    // must never escape as uncaught stream errors.
    child.stdin?.on("error", () => {})
    child.stdout?.on("error", () => {})
    child.stderr?.on("error", () => {})
    child.stdout?.on("data", (chunk: Buffer) => this.consumeStdout(chunk))
    child.stderr?.on("data", (chunk: Buffer) => this.consumeStderr(chunk))
    return child
  }

  private errorResponse(code: string): AgentHostStdioMessage {
    return {
      protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
      id: "runtime",
      kind: "response",
      ok: false,
      error: {
        code: `${STDIO_CODES.hostError}.${code}`,
        message: "stdio adapter is unavailable",
        retryable: false,
      },
    }
  }

  private consumeStdout(chunk: Buffer): void {
    this.stdoutCarry += chunk.toString("utf8")
    let newline = this.stdoutCarry.indexOf("\n")
    while (newline !== -1) {
      const line = this.stdoutCarry.slice(0, newline)
      this.stdoutCarry = this.stdoutCarry.slice(newline + 1)
      this.dispatchLine(line)
      newline = this.stdoutCarry.indexOf("\n")
    }
  }

  private consumeStderr(chunk: Buffer): void {
    // Bounded diagnostics only; raw stderr is never surfaced to callers.
    const text = chunk.toString("utf8")
    this.stderrTail = `${this.stderrTail}${text}`.slice(
      -this.config.maxStderrBytes,
    )
  }

  private dispatchLine(line: string): void {
    let message: AgentHostStdioMessage
    try {
      message = parseAgentHostStdioHostLine(line, this.hostId)
    } catch (error) {
      this.failAllStreams(
        error instanceof CoreError
          ? error
          : stdioError(STDIO_CODES.badFraming, "stdio framing failed"),
      )
      if (this.child) signalAgentHostProcessTree(this.child, "SIGTERM")
      return
    }
    const waiter = this.pending.get(message.id)
    if (waiter && message.kind === "response") {
      this.pending.delete(message.id)
      waiter.resolve(message)
      return
    }
    const stream = this.streams.get(message.id)
    if (stream) {
      stream.queue.push(message)
      stream.notify?.()
      return
    }
    // Unsolicited traffic from an Adapter is a protocol violation.
    this.failAllStreams(
      stdioError(
        STDIO_CODES.streamFailed,
        "stdio adapter sent an unsolicited message",
      ),
    )
    if (this.child) signalAgentHostProcessTree(this.child, "SIGTERM")
  }

  private failStream(id: string, error: CoreError): void {
    const stream = this.streams.get(id)
    if (!stream) return
    stream.failure = stream.failure ?? error
    stream.closed = true
    stream.notify?.()
  }

  private failAllStreams(error: CoreError): void {
    for (const stream of this.streams.values()) {
      stream.failure = stream.failure ?? error
      stream.closed = true
      stream.notify?.()
    }
  }

  private nextMessage(
    id: string,
    state: StreamState,
  ): Promise<AgentHostStdioMessage | null> {
    if (state.queue.length > 0) {
      return Promise.resolve(state.queue.shift() ?? null)
    }
    if (state.failure) return Promise.reject(state.failure)
    if (state.closed) return Promise.resolve(null)
    return new Promise((resolve, reject) => {
      state.notify = () => {
        state.notify = null
        if (state.queue.length > 0) {
          resolve(state.queue.shift() ?? null)
        } else if (state.failure) {
          reject(state.failure)
        } else {
          resolve(null)
        }
      }
      void id
    })
  }
}

/**
 * Builds an explicit AgentHostRegistry registration for one configured
 * external Adapter. Core assembly carries no vendor switch: the trusted
 * embedder opts in with exactly this registration.
 */
export function createExternalStdioHostRegistration(
  config: StdioAdapterConfig,
): AgentHostRegistration {
  const adapter = new ExternalStdioAgentHostAdapter(config)
  return {
    id: config.hostId,
    probe: () => adapter.probe(),
    createAdapter: async () => adapter,
  }
}
