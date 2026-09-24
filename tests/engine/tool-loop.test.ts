import assert from "node:assert/strict"
import test from "node:test"

import {
  executeToolCalls,
  isTerminalEngineEvent,
  TOOL_ADVERTISED_NARROWED_CODE,
  TOOL_OUT_OF_ALLOWLIST_CODE,
} from "../../packages/engine/src/index.js"

const stamp = () => new Date("2026-09-24T00:00:00.000Z")

test("#302 AC-001: two in-allowlist calls emit bounded tool.* and no terminal", async () => {
  const invoked: string[] = []
  const events = []
  for await (const event of executeToolCalls({
    runId: "run-1",
    now: stamp,
    projectedAllowlist: ["Read", "Grep"],
    calls: [
      { toolCallId: "c1", toolName: "Read" },
      { toolCallId: "c2", toolName: "Grep" },
    ],
    invoke: async (call) => {
      invoked.push(call.toolName)
      return { ok: true, tool: call.toolName }
    },
  })) {
    events.push(event)
  }
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "tool.requested",
      "tool.started",
      "tool.completed",
      "tool.requested",
      "tool.started",
      "tool.completed",
    ],
  )
  assert.deepEqual(invoked, ["Read", "Grep"])
  assert.equal(events.some(isTerminalEngineEvent), false)
})

test("#302 AC-002: out-of-allowlist is denied with zero execution", async () => {
  let invoked = 0
  const events = []
  for await (const event of executeToolCalls({
    runId: "run-1",
    now: stamp,
    projectedAllowlist: ["Read"],
    calls: [{ toolCallId: "c1", toolName: "Write" }],
    invoke: async () => {
      invoked += 1
      return {}
    },
  })) {
    events.push(event)
  }
  assert.equal(invoked, 0)
  assert.equal(events.length, 1)
  assert.equal(events[0]?.type, "tool.failed")
  assert.equal(
    (events[0] as { code: string }).code,
    TOOL_OUT_OF_ALLOWLIST_CODE,
  )
})

test("#302 AC-003: advertised disagreement narrows and never widens", async () => {
  const invoked: string[] = []
  const events = []
  for await (const event of executeToolCalls({
    runId: "run-1",
    now: stamp,
    projectedAllowlist: ["Read", "Grep"],
    advertisedTools: ["Read", "Secret"],
    calls: [
      { toolCallId: "c1", toolName: "Read" },
      { toolCallId: "c2", toolName: "Grep" },
      { toolCallId: "c3", toolName: "Secret" },
    ],
    invoke: async (call) => {
      invoked.push(call.toolName)
      return { ok: true }
    },
  })) {
    events.push(event)
  }
  assert.deepEqual(invoked, ["Read"])
  const failed = events.filter((event) => event.type === "tool.failed")
  assert.equal(
    (failed.find((event) => event.toolName === "Grep") as { code: string }).code,
    TOOL_ADVERTISED_NARROWED_CODE,
  )
  assert.equal(
    (failed.find((event) => event.toolName === "Secret") as { code: string }).code,
    TOOL_OUT_OF_ALLOWLIST_CODE,
  )
})
