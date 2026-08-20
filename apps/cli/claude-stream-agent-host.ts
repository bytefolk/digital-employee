import { redactText } from "../../packages/core/src/contracts.js"
import type {
  AgentHostEvent,
} from "../../packages/core/src/agent-host.js"
import type { SafeValue } from "../../packages/core/src/contracts.js"

const MAX_OUTPUT_NODES = 20_000
const MAX_OUTPUT_DEPTH = 32
const MAX_SESSION_ID_LENGTH = 256

export class ClaudeStreamProtocolError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
  ) {
    super(code)
    this.name = "ClaudeStreamProtocolError"
  }
}

export interface ClaudeStreamNormalizerOptions {
  runId: string
  expectedCwd: string
  expectedVersion?: string
  versionSupported: (value: string | undefined) => boolean
  now: () => string
}

export interface ClaudeStreamCompletion {
  usage: Extract<AgentHostEvent, { type: "usage" }>
  output: SafeValue
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function boundedSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_SESSION_ID_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function exactEmptyArray(value: unknown): value is [] {
  return Array.isArray(value) && value.length === 0
}

function finiteNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function finiteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

export function extractClaudeSemver(
  value: string | undefined,
): string | undefined {
  // Accept vendor wrapper text, but only extract one canonical stable SemVer
  // token. In particular, do not truncate prerelease/build/four-part versions
  // or a version embedded in a larger numeric token into a supported release.
  const match = value?.match(
    /(?:^|[^0-9.+-])((?:0|[1-9]\d*))\.((?:0|[1-9]\d*))\.((?:0|[1-9]\d*))(?![0-9.+-])/,
  )
  return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : undefined
}

function normalizeOutputValue(
  value: unknown,
  depth = 0,
  state = { nodes: 0 },
): SafeValue {
  state.nodes += 1
  if (state.nodes > MAX_OUTPUT_NODES || depth > MAX_OUTPUT_DEPTH) {
    throw new ClaudeStreamProtocolError("claude_output_too_complex")
  }
  if (value === null) return null
  // Structured output must be validated exactly as produced. Redaction happens
  // after Schema validation and rejects any mutation on schema-bound output.
  if (typeof value === "string") return value
  if (typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ClaudeStreamProtocolError("claude_output_invalid_number")
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeOutputValue(entry, depth + 1, state))
  }
  const source = record(value)
  if (!source) {
    throw new ClaudeStreamProtocolError("claude_output_not_json")
  }
  const output: { [key: string]: SafeValue } = {}
  for (const [key, entry] of Object.entries(source)) {
    const safe = normalizeOutputValue(entry, depth + 1, state)
    Object.defineProperty(output, key, {
      value: safe,
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  return output
}

function validateStructuredOutput(
  value: unknown,
  validate: (candidate: unknown) => boolean,
): SafeValue {
  const normalized = normalizeOutputValue(value)
  // The validator is the Adapter's one prepared synchronous Schema
  // snapshot; the stream layer never recompiles or re-accepts a Schema.
  if (!validate(normalized)) {
    throw new ClaudeStreamProtocolError("claude_output_schema_mismatch")
  }
  return normalized
}

function resultFailure(event: Record<string, unknown>): ClaudeStreamProtocolError {
  switch (event.subtype) {
    case "error_max_turns":
      return new ClaudeStreamProtocolError("claude_max_turns_exceeded")
    case "error_max_budget_usd":
      return new ClaudeStreamProtocolError("claude_budget_exceeded")
    case "error_max_structured_output_retries":
      return new ClaudeStreamProtocolError(
        "claude_structured_output_retries_exceeded",
      )
    default:
      return new ClaudeStreamProtocolError("claude_execution_failed", true)
  }
}

/**
 * Strictly normalizes Claude-compatible stream-json output for a zero-tool
 * host. The caller owns process limits and lifecycle; this class owns framing
 * semantics, runtime policy attestation, session binding and result mapping.
 */
export class ClaudeZeroToolStreamNormalizer {
  private readonly options: ClaudeStreamNormalizerOptions
  private initSeen = false
  private result?: Record<string, unknown>
  private sessionId?: string
  private sawPartialText = false
  private assistantSnapshot = ""
  private readonly assistantMessages = new Set<string>()

  constructor(options: ClaudeStreamNormalizerOptions) {
    this.options = options
  }

  private assertSession(event: Record<string, unknown>): void {
    if (!boundedSessionId(event.session_id) || event.session_id !== this.sessionId) {
      throw new ClaudeStreamProtocolError("claude_session_id_mismatch")
    }
  }

  private initialize(event: Record<string, unknown>): AgentHostEvent[] {
    if (this.initSeen) {
      throw new ClaudeStreamProtocolError("claude_duplicate_init")
    }
    const version =
      typeof event.claude_code_version === "string"
        ? event.claude_code_version
        : undefined
    const expectedVersion = extractClaudeSemver(this.options.expectedVersion)
    const announcedVersion = extractClaudeSemver(version)
    const capabilitiesValid =
      event.capabilities === undefined ||
      (Array.isArray(event.capabilities) &&
        event.capabilities.every((entry) => typeof entry === "string"))
    if (
      !boundedSessionId(event.session_id) ||
      event.apiKeySource !== "ANTHROPIC_API_KEY" ||
      event.cwd !== this.options.expectedCwd ||
      event.permissionMode !== "dontAsk" ||
      !exactEmptyArray(event.tools) ||
      !exactEmptyArray(event.mcp_servers) ||
      !exactEmptyArray(event.plugins) ||
      !exactEmptyArray(event.skills) ||
      !exactEmptyArray(event.slash_commands) ||
      !capabilitiesValid ||
      !this.options.versionSupported(version) ||
      (expectedVersion !== undefined && announcedVersion !== expectedVersion)
    ) {
      throw new ClaudeStreamProtocolError("claude_runtime_policy_mismatch")
    }
    this.initSeen = true
    this.sessionId = event.session_id
    return [
      {
        type: "run.started",
        runId: this.options.runId,
        timestamp: this.options.now(),
      },
    ]
  }

  private streamEvent(event: Record<string, unknown>): AgentHostEvent[] {
    if (event.parent_tool_use_id !== null) {
      throw new ClaudeStreamProtocolError("claude_subagent_event_denied")
    }
    const streamEvent = record(event.event)
    if (!streamEvent || typeof streamEvent.type !== "string") {
      throw new ClaudeStreamProtocolError("claude_stream_invalid_partial")
    }
    if (streamEvent.type === "content_block_start") {
      const block = record(streamEvent.content_block)
      if (!block || typeof block.type !== "string") {
        throw new ClaudeStreamProtocolError("claude_stream_invalid_block")
      }
      if (block.type === "tool_use" || block.type === "server_tool_use") {
        throw new ClaudeStreamProtocolError("claude_runtime_tool_mismatch")
      }
      if (
        block.type === "text" ||
        block.type === "thinking" ||
        block.type === "redacted_thinking"
      ) {
        return []
      }
      throw new ClaudeStreamProtocolError("claude_stream_unknown_block")
    }
    if (streamEvent.type === "content_block_delta") {
      const delta = record(streamEvent.delta)
      if (!delta || typeof delta.type !== "string") {
        throw new ClaudeStreamProtocolError("claude_stream_invalid_delta")
      }
      if (delta.type === "text_delta") {
        if (typeof delta.text !== "string") {
          throw new ClaudeStreamProtocolError("claude_stream_invalid_text_delta")
        }
        this.sawPartialText = true
        return delta.text
          ? [
              {
                type: "assistant.delta",
                runId: this.options.runId,
                timestamp: this.options.now(),
                text: delta.text,
              },
            ]
          : []
      }
      if (delta.type === "input_json_delta") {
        throw new ClaudeStreamProtocolError("claude_runtime_tool_mismatch")
      }
      if (delta.type === "thinking_delta" || delta.type === "signature_delta") {
        return []
      }
      throw new ClaudeStreamProtocolError("claude_stream_unknown_delta")
    }
    if (streamEvent.type === "message_start") {
      const message = record(streamEvent.message)
      if (
        !message ||
        message.type !== "message" ||
        message.role !== "assistant" ||
        !exactEmptyArray(message.content)
      ) {
        throw new ClaudeStreamProtocolError(
          "claude_stream_invalid_message_start",
        )
      }
      return []
    }
    if (streamEvent.type === "message_delta") {
      const delta = record(streamEvent.delta)
      if (
        !delta ||
        Object.prototype.hasOwnProperty.call(delta, "content") ||
        Object.prototype.hasOwnProperty.call(delta, "tool_use")
      ) {
        throw new ClaudeStreamProtocolError(
          "claude_stream_invalid_message_delta",
        )
      }
      return []
    }
    if (
      streamEvent.type === "message_stop" ||
      streamEvent.type === "content_block_stop" ||
      streamEvent.type === "ping"
    ) {
      return []
    }
    throw new ClaudeStreamProtocolError("claude_stream_unknown_partial")
  }

  private assistant(event: Record<string, unknown>): AgentHostEvent[] {
    if (event.parent_tool_use_id !== null) {
      throw new ClaudeStreamProtocolError("claude_subagent_event_denied")
    }
    if (typeof event.uuid === "string") {
      if (this.assistantMessages.has(event.uuid)) {
        throw new ClaudeStreamProtocolError("claude_duplicate_assistant")
      }
      this.assistantMessages.add(event.uuid)
    }
    const message = record(event.message)
    if (!message || !Array.isArray(message.content)) {
      throw new ClaudeStreamProtocolError("claude_stream_invalid_assistant")
    }
    let nextSnapshot = this.assistantSnapshot
    const normalized: AgentHostEvent[] = []
    for (const rawBlock of message.content) {
      const block = record(rawBlock)
      if (!block || typeof block.type !== "string") {
        throw new ClaudeStreamProtocolError(
          "claude_stream_invalid_assistant_block",
        )
      }
      if (block.type === "tool_use" || block.type === "server_tool_use") {
        throw new ClaudeStreamProtocolError("claude_runtime_tool_mismatch")
      }
      if (block.type === "text") {
        if (typeof block.text !== "string") {
          throw new ClaudeStreamProtocolError(
            "claude_stream_invalid_assistant_text",
          )
        }
        if (!this.sawPartialText) {
          const delta = block.text.startsWith(nextSnapshot)
            ? block.text.slice(nextSnapshot.length)
            : block.text
          nextSnapshot = block.text
          if (delta) {
            normalized.push({
              type: "assistant.delta",
              runId: this.options.runId,
              timestamp: this.options.now(),
              text: delta,
            })
          }
        }
        continue
      }
      if (block.type === "thinking" || block.type === "redacted_thinking") {
        continue
      }
      throw new ClaudeStreamProtocolError("claude_stream_unknown_assistant_block")
    }
    this.assistantSnapshot = nextSnapshot
    return normalized
  }

  accept(value: unknown): AgentHostEvent[] {
    const event = record(value)
    if (!event || typeof event.type !== "string") {
      throw new ClaudeStreamProtocolError("claude_stream_invalid_event")
    }
    if (this.result) {
      throw new ClaudeStreamProtocolError(
        event.type === "result"
          ? "claude_duplicate_result"
          : "claude_event_after_result",
      )
    }
    if (event.type === "system" && event.subtype === "init") {
      return this.initialize(event)
    }
    if (!this.initSeen) {
      throw new ClaudeStreamProtocolError("claude_init_required")
    }
    this.assertSession(event)

    if (event.type === "stream_event") return this.streamEvent(event)
    if (event.type === "assistant") return this.assistant(event)
    if (event.type === "user") {
      throw new ClaudeStreamProtocolError("claude_unexpected_user_event")
    }
    if (event.type === "result") {
      this.result = event
      return []
    }
    if (event.type === "system") {
      if (event.subtype === "permission_denied") {
        throw new ClaudeStreamProtocolError("claude_runtime_tool_mismatch")
      }
      if (
        event.subtype === "api_retry" ||
        event.subtype === "status" ||
        event.subtype === "auth_status"
      ) {
        return []
      }
      throw new ClaudeStreamProtocolError("claude_stream_unknown_system_event")
    }
    if (event.type === "rate_limit_event") return []
    throw new ClaudeStreamProtocolError("claude_stream_unknown_event")
  }

  finish(
    outputValidator: ((candidate: unknown) => boolean) | undefined,
  ): ClaudeStreamCompletion {
    if (!this.initSeen) {
      throw new ClaudeStreamProtocolError("claude_init_missing")
    }
    if (!this.result) {
      throw new ClaudeStreamProtocolError("claude_result_missing")
    }
    if (this.result.subtype !== "success" || this.result.is_error !== false) {
      throw resultFailure(this.result)
    }

    let output: SafeValue
    if (outputValidator !== undefined) {
      if (typeof this.result.result !== "string") {
        throw new ClaudeStreamProtocolError("claude_result_text_missing")
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(this.result.result)
      } catch {
        throw new ClaudeStreamProtocolError("claude_output_not_json")
      }
      output = validateStructuredOutput(parsed, outputValidator)
    } else {
      if (typeof this.result.result !== "string") {
        throw new ClaudeStreamProtocolError("claude_result_text_missing")
      }
      output = redactText(this.result.result)
    }

    const usage = record(this.result.usage)
    const inputTokens = usage?.input_tokens
    const outputTokens = usage?.output_tokens
    const reportedCost = this.result.total_cost_usd
    if (
      !finiteNonNegativeInteger(inputTokens) ||
      !finiteNonNegativeInteger(outputTokens) ||
      !finiteNonNegativeNumber(reportedCost)
    ) {
      throw new ClaudeStreamProtocolError("claude_usage_invalid")
    }
    const totalTokens = inputTokens + outputTokens
    if (!Number.isSafeInteger(totalTokens)) {
      throw new ClaudeStreamProtocolError("claude_usage_invalid")
    }
    return {
      usage: {
        type: "usage",
        runId: this.options.runId,
        timestamp: this.options.now(),
        inputTokens,
        outputTokens,
        totalTokens,
        reportedCost,
        currency: "USD",
      },
      output,
    }
  }
}
