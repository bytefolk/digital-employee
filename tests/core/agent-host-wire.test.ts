import assert from "node:assert/strict"
import test from "node:test"

import {
  AGENT_HOST_PROTOCOL_VERSION,
  createUnknownAgentHostCapabilities,
} from "../../packages/core/src/agent-host.js"
import { CoreError } from "../../packages/core/src/contracts.js"
import {
  AGENT_HOST_VECTOR_CODES,
  classifyAgentHostCompatibility,
  classifyAgentHostEventStream,
  validateAgentHostEventWire,
  validateAgentHostProbeWire,
  validateAgentHostRunRequestWire,
} from "../../packages/core/src/agent-host-wire.js"

function readyProbe(hostId = "fixture") {
  return {
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    hostId,
    displayName: "Fixture Host",
    status: "ready",
    available: true,
    adapterStatus: "runnable",
    capabilities: {
      ...createUnknownAgentHostCapabilities(),
      non_interactive_run: "supported",
      event_stream: "supported",
    },
    capabilitySource: "conformance_test",
    issues: [],
  }
}

function minimalPolicy() {
  return {
    tools: { default: "deny", allow: [{ name: "read_file", mode: "read" }] },
    filesystem: { read: ["/tmp"], write: [] },
    network: { mode: "deny" },
    approval: { mode: "never" },
  }
}

function minimalRunRequest(overrides = {}) {
  return {
    runId: "run-1",
    employeeId: "employee-1",
    workingDirectory: "/tmp/work",
    prompt: "hello",
    policy: minimalPolicy(),
    ...overrides,
  }
}

function event(type: string, overrides = {}) {
  return {
    runId: "run-1",
    timestamp: "2026-08-06T08:00:00.000Z",
    type,
    ...overrides,
  }
}

test("probe wire accepts a valid probe", () => {
  const parsed = validateAgentHostProbeWire(readyProbe(), "fixture")
  assert.equal(parsed.hostId, "fixture")
})

test("probe wire rejects unknown fields fail-closed", () => {
  const probe = { ...readyProbe(), extraField: true }
  assert.throws(
    () => validateAgentHostProbeWire(probe, "fixture"),
    (error) =>
      error instanceof CoreError &&
      error.code === AGENT_HOST_VECTOR_CODES.probeInvalid,
  )
})

test("probe wire rejects host id mismatch and unknown issue keys", () => {
  assert.throws(() => validateAgentHostProbeWire(readyProbe(), "other"))
  const probe = {
    ...readyProbe(),
    issues: [{ code: "x", message: "m", blocking: false, extra: 1 }],
  }
  assert.throws(() => validateAgentHostProbeWire(probe, "fixture"))
})

test("probe wire rejects unknown capability keys", () => {
  const probe = readyProbe()
  ;(probe.capabilities as Record<string, string>).vendor_extension = "supported"
  assert.throws(
    () => validateAgentHostProbeWire(probe, "fixture"),
    (error) =>
      error instanceof CoreError &&
      error.code === AGENT_HOST_VECTOR_CODES.probeInvalid,
  )
})

test("run request wire accepts a minimal request", () => {
  const parsed = validateAgentHostRunRequestWire(minimalRunRequest())
  assert.equal(parsed.runId, "run-1")
})

test("run request wire rejects runtime signal and bad policy fields", () => {
  assert.throws(() =>
    validateAgentHostRunRequestWire(
      minimalRunRequest({ signal: { aborted: false } }),
    ),
  )
  assert.throws(() =>
    validateAgentHostRunRequestWire(
      minimalRunRequest({
        policy: { ...minimalPolicy(), tools: { default: "allow", allow: [] } },
      }),
    ),
  )
  assert.throws(() =>
    validateAgentHostRunRequestWire(minimalRunRequest({ maxTurns: 3 })),
  )
  assert.throws(() =>
    validateAgentHostRunRequestWire(
      minimalRunRequest({ session: { mode: "resume" } }),
    ),
  )
})

test("run request wire accepts full optional surface", () => {
  const parsed = validateAgentHostRunRequestWire(
    minimalRunRequest({
      workspaceFiles: ["a.md"],
      instructions: "be brief",
      session: { mode: "resume", ref: "session-1" },
      attachments: [{ source: "path", path: "/tmp/a.txt" }],
      mcpServers: [
        { name: "s", transport: "stdio", command: "/bin/s" },
        { name: "h", transport: "http", url: "https://example.com/mcp" },
      ],
      outputSchema: { type: "object" },
      metadata: { trace: "t-1" },
      deadline: "2026-08-06T09:00:00.000Z",
    }),
  )
  assert.equal(parsed.employeeId, "employee-1")
})

test("event wire accepts each event type and rejects malformed shapes", () => {
  assert.equal(validateAgentHostEventWire(event("run.started")).type, "run.started")
  assert.equal(
    validateAgentHostEventWire(event("run.completed", { output: "done" })).type,
    "run.completed",
  )
  assert.throws(() => validateAgentHostEventWire(event("unknown.type")))
  assert.throws(() =>
    validateAgentHostEventWire({ ...event("run.started"), extra: true }),
  )
  assert.throws(() =>
    validateAgentHostEventWire(
      event("run.failed", {
        error: { code: "UPPER_CASE", message: "m", retryable: false },
      }),
    ),
  )
  assert.throws(() =>
    validateAgentHostEventWire({ ...event("usage"), timestamp: "2026-08-06" }),
  )
})

test("event stream classifier enforces the single terminal invariant", () => {
  const completed = event("run.completed", { output: "done" })
  const ok = classifyAgentHostEventStream([
    event("run.started"),
    event("assistant.delta", { text: "hi" }),
    completed,
  ])
  assert.deepEqual(ok, { kind: "accept" })

  assert.deepEqual(classifyAgentHostEventStream([event("run.started")]), {
    kind: "reject",
    code: AGENT_HOST_VECTOR_CODES.terminalContractViolated,
  })
  assert.deepEqual(
    classifyAgentHostEventStream([completed, event("assistant.delta", { text: "late" })]),
    { kind: "reject", code: AGENT_HOST_VECTOR_CODES.terminalContractViolated },
  )
  assert.deepEqual(
    classifyAgentHostEventStream([completed, completed]),
    { kind: "reject", code: AGENT_HOST_VECTOR_CODES.terminalContractViolated },
  )
  assert.deepEqual(
    classifyAgentHostEventStream([event("run.started"), { type: "bogus" }]),
    { kind: "reject", code: AGENT_HOST_VECTOR_CODES.streamFailed },
  )
})

test("event stream classifier binds cancellation to the frozen code", () => {
  const cancelledTerminal = event("run.failed", {
    error: {
      code: AGENT_HOST_VECTOR_CODES.cancelled,
      message: "cancelled",
      retryable: false,
    },
  })
  assert.deepEqual(
    classifyAgentHostEventStream(
      [event("run.started"), cancelledTerminal],
      { cancelled: true },
    ),
    { kind: "accept" },
  )
  assert.deepEqual(
    classifyAgentHostEventStream(
      [event("run.started"), event("run.completed", { output: "done" })],
      { deadlineExpired: true },
    ),
    { kind: "reject", code: AGENT_HOST_VECTOR_CODES.cancelled },
  )
})

test("compatibility classifier accepts conformant probes and rejects drift", () => {
  assert.deepEqual(
    classifyAgentHostCompatibility(
      readyProbe(),
      ["non_interactive_run", "event_stream"],
      "fixture",
    ),
    { kind: "accept" },
  )
  assert.deepEqual(
    classifyAgentHostCompatibility(
      { ...readyProbe(), status: "not_ready" },
      [],
      "fixture",
    ),
    { kind: "reject", code: AGENT_HOST_VECTOR_CODES.incompatible },
  )
  assert.deepEqual(
    classifyAgentHostCompatibility({ broken: true }, [], "fixture"),
    { kind: "reject", code: AGENT_HOST_VECTOR_CODES.probeInvalid },
  )
})
