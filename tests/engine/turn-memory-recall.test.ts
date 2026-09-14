import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import {
  MemoryPortError,
  MEMORY_RECALL_SCHEMA_VERSION,
  type MemoryPort,
  type MemoryRecall,
  type MemoryRecallItem,
  type MemoryRecallRequest,
} from "../../packages/core/src/memory-port.js"
import {
  createDeterministicModelPort,
  createInMemoryEvidenceSink,
  evidenceRecordContainsForbiddenMaterial,
  executeTurn,
} from "../../packages/engine/src/index.js"
import type {
  EngineEvent,
  EngineMemoryOptions,
  EngineTurnRequest,
  TurnExecutorOptions,
} from "../../packages/engine/src/index.js"

const FIXED_NOW = () => new Date("2026-08-27T00:00:00.000Z")
const WS_INSTANCE = "00000000-0000-4000-8000-000000000002"
const SESSION = "00000000-0000-4000-8000-000000000003"
const SCOPE = "/workspaces/00000000-0000-4000-8000-000000000002/positions/repo-owner"

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

function recallItem(index: number, text: string): MemoryRecallItem {
  const id = `00000000-0000-4000-8000-0000000000a${index}`
  return {
    memoryId: id,
    kind: "task-state",
    text,
    digest: `sha256:${"ab".repeat(31)}${String(index).padStart(2, "0")}`,
    citation: `mem://memories/${id}`,
    locator: `mem://memories/${id}@1`,
    stateVersion: 1,
    recordedAt: "2026-08-26T00:00:00.000Z",
    provenance: { sourceType: "test" },
    trust: "untrusted",
    authority: "none",
  }
}

function makeRecall(
  request: MemoryRecallRequest,
  items: MemoryRecallItem[],
  schemaVersion: string = MEMORY_RECALL_SCHEMA_VERSION,
): MemoryRecall {
  return {
    schemaVersion: schemaVersion as typeof MEMORY_RECALL_SCHEMA_VERSION,
    workspaceInstanceId: request.workspaceInstanceId,
    sessionId: request.sessionId,
    positionId: request.positionId,
    principal: request.principal,
    retrievedAt: "2026-08-27T00:00:00.000Z",
    items,
    warnings: [],
  }
}

interface MockMemoryPort {
  port: MemoryPort
  requests: MemoryRecallRequest[]
}

function mockPort(
  behavior: (request: MemoryRecallRequest) => MemoryRecall,
): MockMemoryPort {
  const requests: MemoryRecallRequest[] = []
  return {
    requests,
    port: {
      async writeTaskState() {
        throw new MemoryPortError("MEMORY_DENIED", "writes are not under test")
      },
      async recall(request) {
        requests.push(request)
        return behavior(request)
      },
    },
  }
}

function memoryOptions(
  port: MemoryPort,
  overrides: Partial<EngineMemoryOptions> = {},
): EngineMemoryOptions {
  return {
    port,
    enabled: true,
    workspaceInstanceId: WS_INSTANCE,
    sessionId: SESSION,
    memoryScope: SCOPE,
    mode: "optional",
    adapterIdentity: "mem-http.v1",
    ...overrides,
  }
}

function expectedProvenanceDigest(provenance: Record<string, unknown>): string {
  const canonical = JSON.stringify(provenance, Object.keys(provenance).sort())
  return createHash("sha256").update(canonical ?? "{}", "utf8").digest("hex")
}

async function run(
  request: EngineTurnRequest,
  options: Omit<TurnExecutorOptions, "model" | "now"> &
    Partial<Pick<TurnExecutorOptions, "model" | "now">>,
): Promise<{ events: EngineEvent[]; evidence: ReturnType<typeof createInMemoryEvidenceSink> }> {
  const evidenceSink = createInMemoryEvidenceSink()
  const model =
    options.model ?? createDeterministicModelPort(["plain answer"])
  const events: EngineEvent[] = []
  for await (const event of executeTurn(request, {
    now: FIXED_NOW,
    evidenceSink,
    ...options,
    model,
  })) {
    events.push(event)
  }
  return { events, evidence: evidenceSink }
}

test("memory recall disabled by default: no port call, no memory evidence", async () => {
  const mock = mockPort((request) =>
    makeRecall(request, [recallItem(1, "forgotten decision")]),
  )
  const { events, evidence } = await run(baseRequest(), {})
  const terminals = events.filter(isTerminalEvent)
  assert.equal(terminals.length, 1)
  assert.equal(terminals[0]!.type, "run.completed")
  assert.equal(mock.requests.length, 0)
  assert.equal(evidence.records.length, 1)
  assert.equal(evidence.records[0]!.memory, undefined)
})

test("enabled:false behaves as disabled", async () => {
  const mock = mockPort((request) => makeRecall(request, []))
  const { events } = await run(baseRequest(), {
    memory: memoryOptions(mock.port, { enabled: false }),
  })
  assert.equal(events.filter(isTerminalEvent).length, 1)
  assert.equal(mock.requests.length, 0)
})

test("optional happy path: recall feeds context, evidence is digest-only", async () => {
  const secretText = "decision: ship v0.5.0 on Friday"
  const mock = mockPort((request) =>
    makeRecall(request, [recallItem(1, secretText), recallItem(2, "second note")]),
  )
  const withMemory = await run(baseRequest(), {
    memory: memoryOptions(mock.port),
  })
  const baseline = await run(baseRequest(), {})

  const terminals = withMemory.events.filter(isTerminalEvent)
  assert.equal(terminals.length, 1)
  assert.equal(terminals[0]!.type, "run.completed")

  // The pinned port was called exactly once with the pinned binding.
  assert.equal(mock.requests.length, 1)
  const seen = mock.requests[0]!
  assert.equal(seen.workspaceInstanceId, WS_INSTANCE)
  assert.equal(seen.sessionId, SESSION)
  assert.equal(seen.memoryScope, SCOPE)
  assert.equal(seen.positionId, "repo-owner")
  assert.equal(seen.principal, "position.repo-owner")
  assert.equal(seen.mode, "optional")

  // Recalled text changed the assembled context (input digest differs).
  assert.equal(withMemory.evidence.records.length, 1)
  const record = withMemory.evidence.records[0]!
  assert.notEqual(
    record.inputDigest,
    baseline.evidence.records[0]!.inputDigest,
  )

  // Evidence carries digests/locators/versions only — never raw recall text.
  assert.ok(record.memory)
  assert.equal(record.memory!.mode, "optional")
  assert.equal(record.memory!.adapterIdentity, "mem-http.v1")
  assert.equal(record.memory!.memoryScope, SCOPE)
  assert.equal(record.memory!.itemCount, 2)
  assert.equal(record.memory!.items.length, 2)
  assert.equal(record.memory!.items[0]!.stateVersion, 1)
  assert.equal(record.memory!.items[0]!.locator.endsWith("@1"), true)
  // Provenance enters evidence only as the canonical digest (#209 REQ-001).
  assert.equal(
    record.memory!.items[0]!.provenanceDigest,
    expectedProvenanceDigest({ sourceType: "test" }),
  )
  assert.deepEqual(record.memory!.warnings, [])
  assert.equal(
    evidenceRecordContainsForbiddenMaterial(record, [
      secretText,
      "second note",
      '{"sourceType"',
    ]),
    false,
  )
})

test("optional outage: empty recall with warning, turn proceeds", async () => {
  const mock = mockPort(() => {
    throw new MemoryPortError("MEMORY_UNAVAILABLE", "mem is down", {
      retryable: true,
    })
  })
  const model = createDeterministicModelPort(["plain answer"])
  const { events, evidence } = await run(baseRequest(), {
    model,
    memory: memoryOptions(mock.port),
  })
  const terminals = events.filter(isTerminalEvent)
  assert.equal(terminals.length, 1)
  assert.equal(terminals[0]!.type, "run.completed")
  const record = evidence.records[0]!
  assert.ok(record.memory)
  assert.equal(record.memory!.itemCount, 0)
  assert.deepEqual(record.memory!.warnings, [{ code: "MEMORY_UNAVAILABLE" }])
})

test("required outage: retryable failure before any model consumption", async () => {
  const mock = mockPort(() => {
    throw new MemoryPortError("MEMORY_UNAVAILABLE", "mem is down", {
      retryable: true,
    })
  })
  const model = createDeterministicModelPort(["never reached"])
  const { events, evidence } = await run(baseRequest(), {
    model,
    memory: memoryOptions(mock.port, { mode: "required" }),
  })
  const terminals = events.filter(isTerminalEvent)
  assert.equal(terminals.length, 1)
  assert.equal(terminals[0]!.type, "run.failed")
  if (terminals[0]!.type === "run.failed") {
    assert.equal(terminals[0]!.error.code, "engine.memory_unavailable")
    assert.equal(terminals[0]!.error.terminalReason, "memory_unavailable")
    assert.equal(terminals[0]!.error.retryable, true)
  }
  // No evidence record: the failure precedes the evidence sequence, matching
  // the established early-fail paths. Model must not have been consumed.
  assert.equal(evidence.records.length, 0)
  assert.equal(events.some((event) => event.type === "model.delta"), false)
})

test("scope mismatch fails closed in optional mode with zero model calls", async () => {
  const mock = mockPort(() => {
    throw new MemoryPortError("MEMORY_SCOPE_MISMATCH", "wrong scope")
  })
  const model = createDeterministicModelPort(["never reached"])
  const { events } = await run(baseRequest(), {
    model,
    memory: memoryOptions(mock.port, { mode: "optional" }),
  })
  const terminals = events.filter(isTerminalEvent)
  assert.equal(terminals.length, 1)
  assert.equal(terminals[0]!.type, "run.failed")
  if (terminals[0]!.type === "run.failed") {
    assert.equal(terminals[0]!.error.code, "engine.memory_denied")
    assert.equal(terminals[0]!.error.terminalReason, "memory_denied")
    assert.equal(terminals[0]!.error.retryable, false)
  }
  assert.equal(events.some((event) => event.type === "model.delta"), false)
})

test("malformed recall record fails closed in required mode", async () => {
  const mock = mockPort(() => {
    throw new MemoryPortError("MEMORY_RECORD_INVALID", "bad record")
  })
  const { events } = await run(baseRequest(), {
    memory: memoryOptions(mock.port, { mode: "required" }),
  })
  const terminals = events.filter(isTerminalEvent)
  assert.equal(terminals.length, 1)
  assert.equal(terminals[0]!.type, "run.failed")
  if (terminals[0]!.type === "run.failed") {
    assert.equal(terminals[0]!.error.code, "engine.memory_denied")
    assert.equal(terminals[0]!.error.retryable, false)
  }
})

test("unexpected wire schema version fails closed", async () => {
  const mock = mockPort((request) =>
    makeRecall(request, [recallItem(1, "x")], "memory-recall.v9"),
  )
  const { events } = await run(baseRequest(), {
    memory: memoryOptions(mock.port),
  })
  const terminals = events.filter(isTerminalEvent)
  assert.equal(terminals.length, 1)
  assert.equal(terminals[0]!.type, "run.failed")
  if (terminals[0]!.type === "run.failed") {
    assert.equal(terminals[0]!.error.code, "engine.memory_denied")
    assert.equal(terminals[0]!.error.retryable, false)
  }
})

// #209 AC-002 negative classes: revoked/expired grants, archived/forgotten
// items, and tampered digests surface through typed port codes and all fail
// closed before any model consumption with the stable engine.memory_denied
// code (code generation for these classes is proven at the adapter level in
// #181 AC-003; the seam must fail closed on every one of them).
const AC002_NEGATIVE_CODES = [
  "MEMORY_DENIED",
  "MEMORY_NOT_FOUND",
  "MEMORY_RECORD_INVALID",
  "MEMORY_SCOPE_INVALID",
] as const

for (const code of AC002_NEGATIVE_CODES) {
  test(`AC-002: ${code} fails closed before any model consumption`, async () => {
    const mock = mockPort(() => {
      throw new MemoryPortError(code, "negative fixture")
    })
    const model = createDeterministicModelPort(["never reached"])
    const { events, evidence } = await run(baseRequest(), {
      model,
      memory: memoryOptions(mock.port),
    })
    const terminals = events.filter(isTerminalEvent)
    assert.equal(terminals.length, 1)
    assert.equal(terminals[0]!.type, "run.failed")
    if (terminals[0]!.type === "run.failed") {
      assert.equal(terminals[0]!.error.code, "engine.memory_denied")
      assert.equal(terminals[0]!.error.terminalReason, "memory_denied")
      assert.equal(terminals[0]!.error.retryable, false)
    }
    assert.equal(mock.requests.length, 1)
    assert.equal(events.some((event) => event.type === "model.delta"), false)
    assert.equal(evidence.records.length, 0)
  })
}

test("AC-002: missing or malformed adapter identity fails closed before any port call", async () => {
  for (const bad of ["", " leading-space", "has space", "x".repeat(129)]) {
    const mock = mockPort((request) => makeRecall(request, []))
    const model = createDeterministicModelPort(["never reached"])
    const { events } = await run(baseRequest(), {
      model,
      memory: memoryOptions(mock.port, { adapterIdentity: bad }),
    })
    const terminals = events.filter(isTerminalEvent)
    assert.equal(terminals.length, 1, `identity ${JSON.stringify(bad)}`)
    assert.equal(terminals[0]!.type, "run.failed")
    if (terminals[0]!.type === "run.failed") {
      assert.equal(terminals[0]!.error.code, "engine.memory_denied")
      assert.equal(terminals[0]!.error.terminalReason, "memory_denied")
      assert.equal(terminals[0]!.error.retryable, false)
    }
    assert.equal(mock.requests.length, 0)
    assert.equal(events.some((event) => event.type === "model.delta"), false)
  }
})

function isTerminalEvent(event: EngineEvent): boolean {
  return event.type === "run.completed" || event.type === "run.failed"
}
