import assert from "node:assert/strict"
import test from "node:test"

import {
  createDeterministicModelPort,
  executeTurn,
  isTerminalEngineEvent,
} from "../../packages/engine/src/index.js"
import type {
  EngineEvent,
  EngineTurnRequest,
} from "../../packages/engine/src/index.js"

const FIXED_NOW = () => new Date("2026-08-23T00:00:00.000Z")

function baseRequest(overrides: Partial<EngineTurnRequest> = {}): EngineTurnRequest {
  return {
    workspaceRef: "ws-1",
    positionId: "repo-owner",
    turnId: "turn-1",
    runId: "run-1",
    input: "Summarize the open issues.",
    budget: { maxIterations: 3 },
    position: {
      instructions: "You are the repo owner.",
      spec: "mode=read_only",
    },
    ...overrides,
  }
}

async function collect(
  request: EngineTurnRequest,
  model: ReturnType<typeof createDeterministicModelPort>,
): Promise<EngineEvent[]> {
  const events: EngineEvent[] = []
  for await (const event of executeTurn(request, { model, now: FIXED_NOW })) {
    events.push(event)
  }
  return events
}

test("completes with a single terminal event and no schema", async () => {
  const model = createDeterministicModelPort(["plain answer"])
  const events = await collect(baseRequest(), model)
  const terminals = events.filter(isTerminalEngineEvent)
  assert.equal(terminals.length, 1)
  assert.equal(terminals[0]!.type, "run.completed")
  if (terminals[0]!.type === "run.completed") {
    assert.equal(terminals[0]!.output, "plain answer")
    assert.equal(terminals[0]!.terminalReason, "goal_met")
  }
  assert.equal(events[0]!.type, "run.started")
})

test("repair loop recovers within the iteration budget", async () => {
  const schema = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  }
  const model = createDeterministicModelPort([
    "not json",
    '{"answer":"fixed"}',
  ])
  const events = await collect(baseRequest({ outputSchema: schema }), model)
  const terminal = events.filter(isTerminalEngineEvent)
  assert.equal(terminal.length, 1)
  assert.equal(terminal[0]!.type, "run.completed")
  if (terminal[0]!.type === "run.completed") {
    assert.deepEqual(terminal[0]!.output, { answer: "fixed" })
  }
})

test("exhausted repair attempts fail closed with a stable code", async () => {
  const schema = { type: "object", properties: { ok: { type: "boolean" } } }
  const model = createDeterministicModelPort(["bad", "still bad", "nope"])
  const events = await collect(
    baseRequest({ outputSchema: schema, budget: { maxIterations: 3 } }),
    model,
  )
  const terminal = events.filter(isTerminalEngineEvent)
  assert.equal(terminal.length, 1)
  assert.equal(terminal[0]!.type, "run.failed")
  if (terminal[0]!.type === "run.failed") {
    assert.equal(terminal[0]!.error.code, "engine.output_invalid")
    assert.equal(terminal[0]!.error.terminalReason, "invalid_output_exhausted")
    assert.equal(terminal[0]!.error.retryable, true)
  }
})

test("malformed request fails closed before model consumption", async () => {
  let calls = 0
  const model = {
    async complete() {
      calls += 1
      return { text: "never" }
    },
  }
  const events = await collect(
    baseRequest({ budget: { maxIterations: 0 } }),
    model,
  )
  assert.equal(calls, 0)
  const terminal = events.filter(isTerminalEngineEvent)
  assert.equal(terminal.length, 1)
  assert.equal(terminal[0]!.type, "run.failed")
  if (terminal[0]!.type === "run.failed") {
    assert.equal(terminal[0]!.error.code, "engine.input_invalid")
  }
})

test("oversized output schema is rejected before any model call", async () => {
  let calls = 0
  const model = {
    async complete() {
      calls += 1
      return { text: "{}" }
    },
  }
  const hugeSchema = {
    type: "object",
    properties: { filler: { type: "string", description: "x".repeat(20_000) } },
  }
  const events = await collect(
    baseRequest({ outputSchema: hugeSchema }),
    model,
  )
  assert.equal(calls, 0)
  const terminal = events.filter(isTerminalEngineEvent)
  assert.equal(terminal.length, 1)
  assert.equal(terminal[0]!.type, "run.failed")
  if (terminal[0]!.type === "run.failed") {
    assert.equal(terminal[0]!.error.code, "engine.output_schema_too_large")
  }
})

test("abort signal yields the cancelled terminal", async () => {
  const controller = new AbortController()
  controller.abort()
  const model = createDeterministicModelPort(["unused"])
  const events = await collect(
    baseRequest({ signal: controller.signal }),
    model,
  )
  const terminal = events.filter(isTerminalEngineEvent)
  assert.equal(terminal.length, 1)
  assert.equal(terminal[0]!.type, "run.failed")
  if (terminal[0]!.type === "run.failed") {
    assert.equal(terminal[0]!.error.terminalReason, "cancelled")
  }
})

test("deadline exceeded fails closed retryable", async () => {
  const model = createDeterministicModelPort(["unused"])
  const events = await collect(
    baseRequest({ deadline: "2026-08-22T00:00:00.000Z" }),
    model,
  )
  const terminal = events.filter(isTerminalEngineEvent)
  assert.equal(terminal.length, 1)
  assert.equal(terminal[0]!.type, "run.failed")
  if (terminal[0]!.type === "run.failed") {
    assert.equal(terminal[0]!.error.terminalReason, "deadline_exceeded")
    assert.equal(terminal[0]!.error.retryable, true)
  }
})

test("model failure surfaces as engine_internal_error with one terminal", async () => {
  const model = {
    async complete(): Promise<{ text: string }> {
      throw new Error("inference unavailable")
    },
  }
  const events = await collect(baseRequest(), model)
  const terminal = events.filter(isTerminalEngineEvent)
  assert.equal(terminal.length, 1)
  assert.equal(terminal[0]!.type, "run.failed")
  if (terminal[0]!.type === "run.failed") {
    assert.equal(terminal[0]!.error.code, "engine.internal_error")
    assert.equal(terminal[0]!.error.terminalReason, "engine_internal_error")
  }
})

test("usage events are emitted when the model reports tokens", async () => {
  const model = {
    async complete() {
      return { text: "answer", inputTokens: 10, outputTokens: 4 }
    },
  }
  const events = await collect(baseRequest(), model)
  const usage = events.filter((event) => event.type === "usage")
  assert.equal(usage.length, 1)
  assert.equal(usage[0]!.type, "usage")
  if (usage[0]!.type === "usage") {
    assert.equal(usage[0]!.inputTokens, 10)
    assert.equal(usage[0]!.outputTokens, 4)
  }
})
