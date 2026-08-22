import assert from "node:assert/strict"
import test from "node:test"

import {
  ClaudeStreamProtocolError,
  ClaudeZeroToolStreamNormalizer,
  extractClaudeSemver,
} from "../../apps/cli/claude-stream-agent-host.js"
import type { ClaudeStreamNormalizerOptions } from "../../apps/cli/claude-stream-agent-host.js"

const RUN_ID = "run-stream-fixture"
const CWD = "/tmp/claude-stream-fixture"
const SESSION_ID = "session-fixture-1"
const VERSION = "2.1.214 (Claude Code)"

function normalizer(
  overrides: Partial<ClaudeStreamNormalizerOptions> = {},
): ClaudeZeroToolStreamNormalizer {
  return new ClaudeZeroToolStreamNormalizer({
    runId: RUN_ID,
    expectedCwd: CWD,
    versionSupported: () => true,
    now: () => "2026-08-21T00:00:00.000Z",
    ...overrides,
  })
}

function initEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "system",
    subtype: "init",
    session_id: SESSION_ID,
    apiKeySource: "ANTHROPIC_API_KEY",
    cwd: CWD,
    permissionMode: "dontAsk",
    tools: [],
    mcp_servers: [],
    plugins: [],
    skills: [],
    slash_commands: [],
    claude_code_version: VERSION,
    ...overrides,
  }
}

function sessionEvent(
  type: string,
  payload: Record<string, unknown> = {},
  sessionId: unknown = SESSION_ID,
): Record<string, unknown> {
  return { type, session_id: sessionId, ...payload }
}

function streamEventPayload(
  event: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  sessionId: unknown = SESSION_ID,
): Record<string, unknown> {
  return sessionEvent(
    "stream_event",
    { parent_tool_use_id: null, event, ...extra },
    sessionId,
  )
}

function resultEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return sessionEvent("result", {
    subtype: "success",
    is_error: false,
    result: "plain answer",
    usage: { input_tokens: 10, output_tokens: 5 },
    total_cost_usd: 0.0125,
    ...overrides,
  })
}

function assertProtocolError(
  fn: () => unknown,
  code: string,
  retryable = false,
): void {
  assert.throws(
    fn,
    (error: unknown) =>
      error instanceof ClaudeStreamProtocolError &&
      error.code === code &&
      error.retryable === retryable &&
      error.name === "ClaudeStreamProtocolError" &&
      error.message === code,
  )
}

test("extractClaudeSemver extracts one canonical stable SemVer token", () => {
  assert.equal(extractClaudeSemver("2.1.214 (Claude Code)"), "2.1.214")
  assert.equal(extractClaudeSemver("Claude Code v2.1.214"), "2.1.214")
  assert.equal(extractClaudeSemver("claude 2.1.999"), "2.1.999")
  assert.equal(extractClaudeSemver("0.0.0"), "0.0.0")
})

test("extractClaudeSemver never truncates prerelease, build or four-part versions", () => {
  assert.equal(extractClaudeSemver("2.1.214-beta.1"), undefined)
  assert.equal(extractClaudeSemver("2.1.214+build.7"), undefined)
  assert.equal(extractClaudeSemver("2.1.214.1"), undefined)
  assert.equal(extractClaudeSemver("release.2.1.214"), undefined)
})

test("extractClaudeSemver rejects malformed, padded and embedded versions", () => {
  assert.equal(extractClaudeSemver(undefined), undefined)
  assert.equal(extractClaudeSemver(""), undefined)
  assert.equal(extractClaudeSemver("unknown"), undefined)
  assert.equal(extractClaudeSemver("2.1"), undefined)
  assert.equal(extractClaudeSemver("02.1.214"), undefined)
  assert.equal(extractClaudeSemver("release.2.1.214"), undefined)
  // A genuine multi-digit major stays canonical.
  assert.equal(extractClaudeSemver("12.1.214"), "12.1.214")
})

test("ClaudeStreamProtocolError carries a stable code and retry flag", () => {
  const failure = new ClaudeStreamProtocolError("claude_execution_failed", true)
  assert.equal(failure.code, "claude_execution_failed")
  assert.equal(failure.retryable, true)
  assert.equal(failure instanceof Error, true)
  const plain = new ClaudeStreamProtocolError("claude_usage_invalid")
  assert.equal(plain.retryable, false)
})

test("init accepts the zero-tool conformance shape and emits run.started", () => {
  const events = normalizer().accept(initEvent({ capabilities: [] }))
  assert.deepEqual(events, [
    { type: "run.started", runId: RUN_ID, timestamp: "2026-08-21T00:00:00.000Z" },
  ])
})

for (const [name, overrides] of [
  ["missing session id", { session_id: undefined }],
  ["empty session id", { session_id: "" }],
  ["session id over 256", { session_id: "s".repeat(257) }],
  ["control char session id", { session_id: "bad\u0001session" }],
  ["wrong api key source", { apiKeySource: "claude_cli_oauth" }],
  ["wrong cwd", { cwd: "/tmp/elsewhere" }],
  ["wrong permission mode", { permissionMode: "acceptEdits" }],
  ["non-empty tools", { tools: ["Read"] }],
  ["non-empty mcp servers", { mcp_servers: [{ name: "x" }] }],
  ["non-empty plugins", { plugins: ["p"] }],
  ["non-empty skills", { skills: ["s"] }],
  ["non-empty slash commands", { slash_commands: ["/help"] }],
  ["non-string capability", { capabilities: ["ok", 3] }],
  ["non-array capabilities", { capabilities: {} }],
] as const) {
  test(`init rejects policy violation: ${name}`, () => {
    assertProtocolError(
      () => normalizer().accept(initEvent(overrides)),
      "claude_runtime_policy_mismatch",
    )
  })
}

test("init rejects unsupported versions and version announcement drift", () => {
  assertProtocolError(
    () =>
      normalizer({ versionSupported: () => false }).accept(initEvent()),
    "claude_runtime_policy_mismatch",
  )
  assertProtocolError(
    () =>
      normalizer({ expectedVersion: "2.1.214 (Claude Code)" }).accept(
        initEvent({ claude_code_version: "2.1.215 (Claude Code)" }),
      ),
    "claude_runtime_policy_mismatch",
  )
  // A four-part announcement must not be truncated into the supported release.
  assertProtocolError(
    () =>
      normalizer({ expectedVersion: "2.1.214 (Claude Code)" }).accept(
        initEvent({ claude_code_version: "2.1.214.1" }),
      ),
    "claude_runtime_policy_mismatch",
  )
  const matching = normalizer({ expectedVersion: "Claude Code v2.1.214" })
  assert.equal(matching.accept(initEvent()).length, 1)
})

test("duplicate init and events before init fail closed", () => {
  const host = normalizer()
  host.accept(initEvent())
  assertProtocolError(() => host.accept(initEvent()), "claude_duplicate_init")
  assertProtocolError(
    () => normalizer().accept(streamEventPayload({ type: "ping" })),
    "claude_init_required",
  )
})

test("accept rejects non-records, unknown events and user events", () => {
  assertProtocolError(() => normalizer().accept(null), "claude_stream_invalid_event")
  assertProtocolError(
    () => normalizer().accept("not-an-event"),
    "claude_stream_invalid_event",
  )
  assertProtocolError(
    () => normalizer().accept({ type: 7 }),
    "claude_stream_invalid_event",
  )
  const host = normalizer()
  host.accept(initEvent())
  assertProtocolError(
    () => host.accept(sessionEvent("user")),
    "claude_unexpected_user_event",
  )
  assertProtocolError(
    () => host.accept(sessionEvent("mystery")),
    "claude_stream_unknown_event",
  )
})

test("session binding is enforced on every post-init event", () => {
  const host = normalizer()
  host.accept(initEvent())
  assertProtocolError(
    () => host.accept(streamEventPayload({ type: "ping" }, {}, "other-session")),
    "claude_session_id_mismatch",
  )
  assertProtocolError(
    () =>
      host.accept({
        type: "stream_event",
        parent_tool_use_id: null,
        event: { type: "ping" },
      }),
    "claude_session_id_mismatch",
  )
  assertProtocolError(
    () =>
      host.accept(streamEventPayload({ type: "ping" }, {}, "s".repeat(257))),
    "claude_session_id_mismatch",
  )
})

test("stream events map the full zero-tool partial message grammar", () => {
  const host = normalizer()
  host.accept(initEvent())
  assert.deepEqual(
    host.accept(
      streamEventPayload({
        type: "message_start",
        message: { type: "message", role: "assistant", content: [] },
      }),
    ),
    [],
  )
  assert.deepEqual(
    host.accept(
      streamEventPayload({
        type: "content_block_start",
        content_block: { type: "text" },
      }),
    ),
    [],
  )
  assert.deepEqual(
    host.accept(
      streamEventPayload({
        type: "content_block_start",
        content_block: { type: "thinking" },
      }),
    ),
    [],
  )
  assert.deepEqual(
    host.accept(
      streamEventPayload({
        type: "content_block_start",
        content_block: { type: "redacted_thinking" },
      }),
    ),
    [],
  )
  assert.deepEqual(
    host.accept(
      streamEventPayload({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "partial " },
      }),
    ),
    [
      {
        type: "assistant.delta",
        runId: RUN_ID,
        timestamp: "2026-08-21T00:00:00.000Z",
        text: "partial ",
      },
    ],
  )
  assert.deepEqual(
    host.accept(
      streamEventPayload({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "" },
      }),
    ),
    [],
  )
  assert.deepEqual(
    host.accept(
      streamEventPayload({
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "hm" },
      }),
    ),
    [],
  )
  assert.deepEqual(
    host.accept(
      streamEventPayload({
        type: "content_block_delta",
        delta: { type: "signature_delta", signature: "sig" },
      }),
    ),
    [],
  )
  assert.deepEqual(
    host.accept(streamEventPayload({ type: "content_block_stop" })),
    [],
  )
  assert.deepEqual(
    host.accept(
      streamEventPayload({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
    ),
    [],
  )
  assert.deepEqual(host.accept(streamEventPayload({ type: "message_stop" })), [])
  assert.deepEqual(host.accept(streamEventPayload({ type: "ping" })), [])
})

for (const [name, event, code] of [
  [
    "subagent partial",
    { type: "ping" },
    "claude_subagent_event_denied",
  ],
  [
    "missing event record",
    null,
    "claude_stream_invalid_partial",
  ],
  [
    "non-string partial type",
    { type: 5 },
    "claude_stream_invalid_partial",
  ],
  [
    "unknown partial type",
    { type: "content_block_fly" },
    "claude_stream_unknown_partial",
  ],
  [
    "tool_use block start",
    { type: "content_block_start", content_block: { type: "tool_use" } },
    "claude_runtime_tool_mismatch",
  ],
  [
    "server_tool_use block start",
    { type: "content_block_start", content_block: { type: "server_tool_use" } },
    "claude_runtime_tool_mismatch",
  ],
  [
    "unknown block start",
    { type: "content_block_start", content_block: { type: "citation" } },
    "claude_stream_unknown_block",
  ],
  [
    "missing block start record",
    { type: "content_block_start", content_block: null },
    "claude_stream_invalid_block",
  ],
  [
    "input_json_delta",
    { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } },
    "claude_runtime_tool_mismatch",
  ],
  [
    "unknown delta",
    { type: "content_block_delta", delta: { type: "mystery_delta" } },
    "claude_stream_unknown_delta",
  ],
  [
    "missing delta record",
    { type: "content_block_delta", delta: null },
    "claude_stream_invalid_delta",
  ],
  [
    "non-string text delta",
    { type: "content_block_delta", delta: { type: "text_delta", text: 7 } },
    "claude_stream_invalid_text_delta",
  ],
  [
    "unsafe message_start",
    { type: "message_start", message: { type: "message", role: "assistant", content: [{ type: "text" }] } },
    "claude_stream_invalid_message_start",
  ],
  [
    "wrong message_start role",
    { type: "message_start", message: { type: "message", role: "user", content: [] } },
    "claude_stream_invalid_message_start",
  ],
  [
    "message_delta with content",
    { type: "message_delta", delta: { content: [] } },
    "claude_stream_invalid_message_delta",
  ],
  [
    "message_delta with tool_use",
    { type: "message_delta", delta: { tool_use: {} } },
    "claude_stream_invalid_message_delta",
  ],
  [
    "message_delta without record",
    { type: "message_delta", delta: null },
    "claude_stream_invalid_message_delta",
  ],
] as const) {
  test(`stream event fails closed: ${name}`, () => {
    const host = normalizer()
    host.accept(initEvent())
    assertProtocolError(
      () =>
        host.accept(
          event === null
            ? sessionEvent("stream_event", { parent_tool_use_id: null })
            : streamEventPayload(
                event,
                name === "subagent partial"
                  ? { parent_tool_use_id: "agent-1" }
                  : {},
              ),
        ),
      code,
    )
  })
}

test("assistant message emits deltas only for text unseen by partial stream", () => {
  const host = normalizer()
  host.accept(initEvent())
  assert.deepEqual(
    host.accept(
      sessionEvent("assistant", {
        uuid: "a-1",
        parent_tool_use_id: null,
        message: { content: [{ type: "text", text: "hello " }] },
      }),
    ),
    [
      {
        type: "assistant.delta",
        runId: RUN_ID,
        timestamp: "2026-08-21T00:00:00.000Z",
        text: "hello ",
      },
    ],
  )
  // Snapshot continuation: prefix already seen, only the suffix is emitted.
  assert.deepEqual(
    host.accept(
      sessionEvent("assistant", {
        uuid: "a-2",
        parent_tool_use_id: null,
        message: { content: [{ type: "text", text: "hello world" }] },
      }),
    ),
    [
      {
        type: "assistant.delta",
        runId: RUN_ID,
        timestamp: "2026-08-21T00:00:00.000Z",
        text: "world",
      },
    ],
  )
  // Divergent text is emitted in full rather than partially sliced.
  assert.deepEqual(
    host.accept(
      sessionEvent("assistant", {
        uuid: "a-3",
        parent_tool_use_id: null,
        message: { content: [{ type: "text", text: "goodbye" }] },
      }),
    ),
    [
      {
        type: "assistant.delta",
        runId: RUN_ID,
        timestamp: "2026-08-21T00:00:00.000Z",
        text: "goodbye",
      },
    ],
  )
})

test("assistant text is suppressed after partial text was already streamed", () => {
  const host = normalizer()
  host.accept(initEvent())
  host.accept(
    streamEventPayload({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "partial" },
    }),
  )
  assert.deepEqual(
    host.accept(
      sessionEvent("assistant", {
        uuid: "a-4",
        parent_tool_use_id: null,
        message: { content: [{ type: "text", text: "partial full" }] },
      }),
    ),
    [],
  )
})

for (const [name, payload, code] of [
  [
    "subagent assistant",
    { uuid: "a-x", parent_tool_use_id: "agent-1", message: { content: [] } },
    "claude_subagent_event_denied",
  ],
  [
    "missing content array",
    { uuid: "a-x", parent_tool_use_id: null, message: { content: "no" } },
    "claude_stream_invalid_assistant",
  ],
  [
    "missing message record",
    { uuid: "a-x", parent_tool_use_id: null, message: null },
    "claude_stream_invalid_assistant",
  ],
  [
    "tool_use block",
    {
      uuid: "a-x",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_use", name: "Read" }] },
    },
    "claude_runtime_tool_mismatch",
  ],
  [
    "server_tool_use block",
    {
      uuid: "a-x",
      parent_tool_use_id: null,
      message: { content: [{ type: "server_tool_use" }] },
    },
    "claude_runtime_tool_mismatch",
  ],
  [
    "unknown block",
    {
      uuid: "a-x",
      parent_tool_use_id: null,
      message: { content: [{ type: "citation" }] },
    },
    "claude_stream_unknown_assistant_block",
  ],
  [
    "invalid block record",
    { uuid: "a-x", parent_tool_use_id: null, message: { content: [null] } },
    "claude_stream_invalid_assistant_block",
  ],
  [
    "non-string text",
    {
      uuid: "a-x",
      parent_tool_use_id: null,
      message: { content: [{ type: "text", text: 42 }] },
    },
    "claude_stream_invalid_assistant_text",
  ],
] as const) {
  test(`assistant event fails closed: ${name}`, () => {
    const host = normalizer()
    host.accept(initEvent())
    assertProtocolError(
      () => host.accept(sessionEvent("assistant", payload)),
      code,
    )
  })
}

test("duplicate assistant uuid fails closed; thinking blocks pass through", () => {
  const host = normalizer()
  host.accept(initEvent())
  host.accept(
    sessionEvent("assistant", {
      uuid: "a-dup",
      parent_tool_use_id: null,
      message: {
        content: [
          { type: "thinking", thinking: "hm" },
          { type: "redacted_thinking" },
        ],
      },
    }),
  )
  assertProtocolError(
    () =>
      host.accept(
        sessionEvent("assistant", {
          uuid: "a-dup",
          parent_tool_use_id: null,
          message: { content: [] },
        }),
      ),
    "claude_duplicate_assistant",
  )
  // No uuid: no dedupe bookkeeping, accepted repeatedly.
  assert.deepEqual(
    host.accept(
      sessionEvent("assistant", {
        parent_tool_use_id: null,
        message: { content: [] },
      }),
    ),
    [],
  )
})

test("system, rate limit and result events are bounded after init", () => {
  const host = normalizer()
  host.accept(initEvent())
  assert.deepEqual(host.accept(sessionEvent("system", { subtype: "api_retry" })), [])
  assert.deepEqual(host.accept(sessionEvent("system", { subtype: "status" })), [])
  assert.deepEqual(
    host.accept(sessionEvent("system", { subtype: "auth_status" })),
    [],
  )
  assert.deepEqual(host.accept(sessionEvent("rate_limit_event")), [])
  assert.deepEqual(host.accept(resultEvent()), [])
  assertProtocolError(
    () => host.accept(resultEvent()),
    "claude_duplicate_result",
  )
  assertProtocolError(
    () => host.accept(streamEventPayload({ type: "ping" })),
    "claude_event_after_result",
  )
})

test("system permission_denied and unknown system subtypes fail closed", () => {
  const denied = normalizer()
  denied.accept(initEvent())
  assertProtocolError(
    () => denied.accept(sessionEvent("system", { subtype: "permission_denied" })),
    "claude_runtime_tool_mismatch",
  )
  const unknown = normalizer()
  unknown.accept(initEvent())
  assertProtocolError(
    () => unknown.accept(sessionEvent("system", { subtype: "mystery" })),
    "claude_stream_unknown_system_event",
  )
})

test("finish fails closed without init or result", () => {
  assertProtocolError(() => normalizer().finish(undefined), "claude_init_missing")
  const host = normalizer()
  host.accept(initEvent())
  assertProtocolError(() => host.finish(undefined), "claude_result_missing")
})

for (const [name, overrides, code, retryable] of [
  ["max turns", { subtype: "error_max_turns", is_error: true }, "claude_max_turns_exceeded", false],
  ["budget", { subtype: "error_max_budget_usd", is_error: true }, "claude_budget_exceeded", false],
  [
    "structured retries",
    { subtype: "error_max_structured_output_retries", is_error: true },
    "claude_structured_output_retries_exceeded",
    false,
  ],
  ["generic failure", { subtype: "error_during_execution", is_error: true }, "claude_execution_failed", true],
  ["is_error true", { subtype: "success", is_error: true }, "claude_execution_failed", true],
] as const) {
  test(`finish maps terminal failure: ${name}`, () => {
    const host = normalizer()
    host.accept(initEvent())
    host.accept(resultEvent(overrides))
    assertProtocolError(() => host.finish(undefined), code, retryable)
  })
}

test("finish requires result text in both structured and unstructured paths", () => {
  for (const validator of [undefined, () => true] as const) {
    const host = normalizer()
    host.accept(initEvent())
    host.accept(resultEvent({ result: undefined }))
    assertProtocolError(() => host.finish(validator), "claude_result_text_missing")
  }
})

test("finish parses and validates structured output through one validator snapshot", () => {
  const host = normalizer()
  host.accept(initEvent())
  host.accept(resultEvent({ result: JSON.stringify({ answer: "ok", list: [1, null, true] }) }))
  const completion = host.finish((candidate) => {
    const value = candidate as { answer?: unknown }
    return typeof value.answer === "string"
  })
  assert.deepEqual(completion.output, { answer: "ok", list: [1, null, true] })
  assert.deepEqual(
    {
      input: completion.usage.inputTokens,
      output: completion.usage.outputTokens,
      total: completion.usage.totalTokens,
      cost: completion.usage.reportedCost,
      currency: completion.usage.currency,
    },
    { input: 10, output: 5, total: 15, cost: 0.0125, currency: "USD" },
  )
})

for (const [name, result, code] of [
  ["prose result", "this is not json", "claude_output_not_json"],
  ["fenced json", "```json\n{\"answer\":\"ok\"}\n```", "claude_output_not_json"],
  ["truncated json", "{\"answer\":", "claude_output_not_json"],
  ["trailing garbage", "{\"answer\":\"ok\"} extra", "claude_output_not_json"],
] as const) {
  test(`finish rejects malformed terminal json: ${name}`, () => {
    const host = normalizer()
    host.accept(initEvent())
    host.accept(resultEvent({ result }))
    assertProtocolError(() => host.finish(() => true), code)
  })
}

test("finish rejects schema mismatch without mutating the value", () => {
  const host = normalizer()
  host.accept(initEvent())
  host.accept(resultEvent({ result: JSON.stringify({ answer: 7 }) }))
  assertProtocolError(
    () =>
      host.finish((candidate) =>
        typeof (candidate as { answer?: unknown }).answer === "string",
      ),
    "claude_output_schema_mismatch",
  )
})

test("finish rejects non-finite numbers and non-JSON values inside output", () => {
  const nonFinite = normalizer()
  nonFinite.accept(initEvent())
  nonFinite.accept(resultEvent({ result: "0" }))
  // The parsed primitive is swapped for Infinity before validation; the stream
  // layer must fail closed instead of publishing a non-JSON number.
  assertProtocolError(() => {
    const originalParse = JSON.parse
    JSON.parse = () => Infinity
    try {
      nonFinite.finish(() => true)
    } finally {
      JSON.parse = originalParse
    }
  }, "claude_output_invalid_number")

  const nonJson = normalizer()
  nonJson.accept(initEvent())
  nonJson.accept(resultEvent({ result: "0" }))
  // A bigint is neither a JSON primitive nor a record; normalization must
  // reject it instead of silently publishing a non-JSON value.
  assertProtocolError(() => {
    const originalParse = JSON.parse
    JSON.parse = () => 10n
    try {
      nonJson.finish(() => true)
    } finally {
      JSON.parse = originalParse
    }
  }, "claude_output_not_json")
})

test("finish enforces the depth bound on structured output", () => {
  let deep: unknown = "leaf"
  for (let index = 0; index < 40; index += 1) {
    deep = { next: deep }
  }
  const host = normalizer()
  host.accept(initEvent())
  host.accept(resultEvent({ result: JSON.stringify(deep) }))
  assertProtocolError(() => host.finish(() => true), "claude_output_too_complex")
})

test("finish enforces the output node bound", () => {
  const host = normalizer()
  host.accept(initEvent())
  host.accept(
    resultEvent({ result: JSON.stringify({ values: new Array(20_001).fill(0) }) }),
  )
  assertProtocolError(() => host.finish(() => true), "claude_output_too_complex")
})

test("finish without a validator redacts plain text output", () => {
  const host = normalizer()
  host.accept(initEvent())
  host.accept(resultEvent({ result: "answer with token=abc123def456ghi789jkl" }))
  const completion = host.finish(undefined)
  assert.equal(typeof completion.output, "string")
  assert.equal(
    JSON.stringify(completion.output).includes("abc123def456ghi789jkl"),
    false,
  )
})

for (const [name, usage, cost] of [
  ["missing usage", undefined, 0.0125],
  ["negative input", { input_tokens: -1, output_tokens: 5 }, 0.0125],
  ["non-integer output", { input_tokens: 10, output_tokens: 1.5 }, 0.0125],
  ["negative cost", { input_tokens: 10, output_tokens: 5 }, -0.01],
  ["infinite cost", { input_tokens: 10, output_tokens: 5 }, Infinity],
] as const) {
  test(`finish rejects invalid usage: ${name}`, () => {
    const host = normalizer()
    host.accept(initEvent())
    host.accept(resultEvent({ usage, total_cost_usd: cost }))
    assertProtocolError(() => host.finish(undefined), "claude_usage_invalid")
  })
}

test("finish rejects usage totals that overflow safe integers", () => {
  const host = normalizer()
  host.accept(initEvent())
  host.accept(
    resultEvent({
      usage: {
        input_tokens: Number.MAX_SAFE_INTEGER,
        output_tokens: 1,
      },
    }),
  )
  assertProtocolError(() => host.finish(undefined), "claude_usage_invalid")
})

test("zero-tool capability stream matches the conformance shape end to end", () => {
  const host = normalizer()
  const started = host.accept(initEvent())
  assert.deepEqual(started.map((event) => event.type), ["run.started"])
  assert.deepEqual(
    host.accept(
      streamEventPayload({
        type: "message_start",
        message: { type: "message", role: "assistant", content: [] },
      }),
    ),
    [],
  )
  assert.deepEqual(
    host.accept(
      streamEventPayload({
        type: "content_block_start",
        content_block: { type: "text" },
      }),
    ),
    [],
  )
  assert.deepEqual(
    host.accept(
      streamEventPayload({
        type: "content_block_delta",
        delta: { type: "text_delta", text: "streamed " },
      }),
    ),
    [
      {
        type: "assistant.delta",
        runId: RUN_ID,
        timestamp: "2026-08-21T00:00:00.000Z",
        text: "streamed ",
      },
    ],
  )
  assert.deepEqual(
    host.accept(streamEventPayload({ type: "content_block_stop" })),
    [],
  )
  // Once partial text was streamed, assistant snapshots stop emitting deltas
  // entirely — the partial stream is the single source of visible text.
  assert.deepEqual(
    host.accept(
      sessionEvent("assistant", {
        uuid: "a-final",
        parent_tool_use_id: null,
        message: { content: [{ type: "text", text: "streamed answer" }] },
      }),
    ),
    [],
  )
  assert.deepEqual(host.accept(streamEventPayload({ type: "message_stop" })), [])
  assert.deepEqual(
    host.accept(
      resultEvent({ result: JSON.stringify({ answer: "streamed answer" }) }),
    ),
    [],
  )
  const completion = host.finish(() => true)
  assert.deepEqual(completion.output, { answer: "streamed answer" })
  assert.equal(completion.usage.type, "usage")
  assert.equal(completion.usage.totalTokens, 15)
})
