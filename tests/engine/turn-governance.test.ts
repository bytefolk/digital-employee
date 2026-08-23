import assert from "node:assert/strict"
import test from "node:test"

import {
  createInMemoryBudgetLedger,
  createInMemoryEscalationSink,
  createInMemoryEvidenceSink,
  evidenceRecordContainsForbiddenMaterial,
  executeTurn,
  isTerminalEngineEvent,
} from "../../packages/engine/src/index.js"
import type {
  EngineEvent,
  EngineTurnRequest,
  ModelPort,
  OrgReportingLookup,
} from "../../packages/engine/src/index.js"

const FIXED_NOW = () => new Date("2026-08-23T00:00:00.000Z")
let idCounter = 0
const NEW_ID = () => `id-${(idCounter += 1)}`

function baseRequest(overrides: Partial<EngineTurnRequest> = {}): EngineTurnRequest {
  return {
    workspaceRef: "ws-1",
    positionId: "issue-researcher",
    turnId: "turn-1",
    runId: "run-1",
    input: "Summarize issue 42.",
    budget: { maxIterations: 6 },
    position: { instructions: "You are the issue researcher." },
    ...overrides,
  }
}

const ORG: OrgReportingLookup = {
  reportTo: (positionId) =>
    positionId === "repo-owner" ? null : "repo-owner",
}

function scriptedModel(outputs: readonly string[], tokens = 0): ModelPort {
  let call = 0
  return {
    async complete() {
      const text = outputs[Math.min(call, outputs.length - 1)]!
      call += 1
      return tokens > 0
        ? { text, inputTokens: tokens, outputTokens: 0 }
        : { text }
    },
  }
}

interface RunResult {
  events: EngineEvent[]
  escalations: ReturnType<typeof createInMemoryEscalationSink>
  evidence: ReturnType<typeof createInMemoryEvidenceSink>
}

async function runWithGovernance(
  request: EngineTurnRequest,
  model: ModelPort,
  ledger = createInMemoryBudgetLedger(),
): Promise<RunResult> {
  const escalations = createInMemoryEscalationSink()
  const evidence = createInMemoryEvidenceSink()
  const events: EngineEvent[] = []
  for await (const event of executeTurn(request, {
    model,
    now: FIXED_NOW,
    newId: NEW_ID,
    budgetLedger: ledger,
    escalationSink: escalations,
    evidenceSink: evidence,
    orgLookup: ORG,
  })) {
    events.push(event)
  }
  return { events, escalations, evidence }
}

const terminalOf = (events: EngineEvent[]) =>
  events.filter(isTerminalEngineEvent)

test("position budget exceeded stops fail-safe, escalates to the direct superior, and records evidence", async () => {
  const request = baseRequest({
    positionBudget: {
      perTask: { tokens: 1_000, iterations: 1 },
      perDay: { tokens: 10_000, iterations: 10 },
    },
    taskId: "task-1",
    dayKey: "2026-08-23",
    outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
  })
  const model = scriptedModel(["bad-1", "bad-2", "bad-3"])
  const { events, escalations, evidence } = await runWithGovernance(request, model)

  const terminals = terminalOf(events)
  assert.equal(terminals.length, 1)
  assert.equal(terminals[0]!.type, "run.failed")
  if (terminals[0]!.type === "run.failed") {
    assert.equal(terminals[0]!.error.code, "engine.position_budget_exceeded")
    assert.equal(terminals[0]!.error.retryable, false)
  }

  assert.equal(escalations.records.length, 1)
  const record = escalations.records[0]!
  assert.equal(record.cause, "position_budget_exceeded")
  assert.equal(record.routing.directSuperior, "repo-owner")
  assert.equal(record.routing.resolvedFrom, "organization.v1alpha1#reportTo")
  assert.equal(record.schemaVersion, "escalation-record.v1")

  assert.equal(evidence.records.length, 1)
  const turnEvidence = evidence.records[0]!
  assert.equal(turnEvidence.terminal.status, "failed")
  assert.equal(turnEvidence.terminal.reason, "position_budget_exceeded")
  assert.equal(turnEvidence.escalationRef, record.escalationId)
  assert.equal(turnEvidence.schemaVersion, "turn-evidence.v1")
})

test("owner without a superior routes escalation to the workspace operator", async () => {
  const request = baseRequest({
    positionId: "repo-owner",
    positionBudget: {
      perTask: { iterations: 1, tokens: 1_000 },
      perDay: { iterations: 10, tokens: 10_000 },
    },
    taskId: "task-1",
    dayKey: "2026-08-23",
    outputSchema: { type: "object" },
  })
  const model = scriptedModel(["bad-1", "bad-2", "bad-3"])
  const { escalations } = await runWithGovernance(request, model)
  assert.equal(escalations.records.length, 1)
  assert.equal(escalations.records[0]!.routing.directSuperior, "workspace.operator")
  assert.equal(
    escalations.records[0]!.routing.resolvedFrom,
    "workspace.operator_default",
  )
})

test("turn token budget exceeded stops with the turn dimension snapshot", async () => {
  const request = baseRequest({
    budget: { maxIterations: 6, maxTokens: 15 },
    outputSchema: { type: "object" },
  })
  const model = scriptedModel(["{}", "{}", "{}"], 20)
  const { events, escalations } = await runWithGovernance(request, model)
  const terminals = terminalOf(events)
  assert.equal(terminals.length, 1)
  assert.equal(terminals[0]!.type, "run.failed")
  if (terminals[0]!.type === "run.failed") {
    assert.equal(terminals[0]!.error.code, "engine.turn_budget_exceeded")
  }
  assert.equal(escalations.records.length, 1)
  assert.equal(escalations.records[0]!.cause, "turn_budget_exceeded")
  assert.equal(escalations.records[0]!.budgetSnapshot.dimension, "turn_tokens")
})

test("doom-loop repetition stops with a stable code and an escalation record", async () => {
  const request = baseRequest({
    outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
  })
  const model = scriptedModel(["not json", "not json", "not json", "not json"])
  const { events, escalations, evidence } = await runWithGovernance(request, model)
  const terminals = terminalOf(events)
  assert.equal(terminals.length, 1)
  assert.equal(terminals[0]!.type, "run.failed")
  if (terminals[0]!.type === "run.failed") {
    assert.equal(terminals[0]!.error.code, "engine.doom_loop_detected")
    assert.equal(terminals[0]!.error.terminalReason, "doom_loop")
  }
  assert.equal(escalations.records.length, 1)
  assert.equal(escalations.records[0]!.cause, "doom_loop")
  assert.equal(evidence.records.length, 1)
})

test("successful turns record completed evidence without escalation", async () => {
  const request = baseRequest({
    outputSchema: {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
    },
  })
  const model = scriptedModel(['{"answer":"done"}'])
  const { events, escalations, evidence } = await runWithGovernance(request, model)
  const terminals = terminalOf(events)
  assert.equal(terminals.length, 1)
  assert.equal(terminals[0]!.type, "run.completed")
  assert.equal(escalations.records.length, 0)
  assert.equal(evidence.records.length, 1)
  const record = evidence.records[0]!
  assert.equal(record.terminal.status, "completed")
  assert.equal(record.terminal.reason, "goal_met")
  assert.equal(record.engineVersion, "0.1.0")
  assert.equal(record.escalationRef, undefined)
  assert.equal(
    evidenceRecordContainsForbiddenMaterial(record, ["Summarize issue 42.", "done"]),
    false,
  )
})

test("schema-repair exhaustion writes evidence but no escalation", async () => {
  const request = baseRequest({
    budget: { maxIterations: 2 },
    outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
  })
  const model = scriptedModel(["bad", "still bad"])
  const { events, escalations, evidence } = await runWithGovernance(request, model)
  const terminals = terminalOf(events)
  assert.equal(terminals.length, 1)
  assert.equal(terminals[0]!.type, "run.failed")
  if (terminals[0]!.type === "run.failed") {
    assert.equal(terminals[0]!.error.code, "engine.output_invalid")
    assert.equal(terminals[0]!.error.terminalReason, "invalid_output_exhausted")
    assert.equal(terminals[0]!.error.retryable, true)
  }
  assert.equal(escalations.records.length, 0)
  assert.equal(evidence.records.length, 1)
  assert.equal(evidence.records[0]!.terminal.reason, "invalid_output_exhausted")
})

test("a failing evidence sink fails the turn closed", async () => {
  const request = baseRequest({})
  const model = scriptedModel(["plain answer"])
  const events: EngineEvent[] = []
  for await (const event of executeTurn(request, {
    model,
    now: FIXED_NOW,
    evidenceSink: {
      async write() {
        throw new Error("evidence store unavailable")
      },
    },
  })) {
    events.push(event)
  }
  const terminals = terminalOf(events)
  assert.equal(terminals.length, 1)
  assert.equal(terminals[0]!.type, "run.failed")
  if (terminals[0]!.type === "run.failed") {
    assert.equal(terminals[0]!.error.code, "engine.internal_error")
  }
})

test("position budget declaration without ledger identifiers fails closed", async () => {
  const request = baseRequest({
    positionBudget: {
      perTask: { tokens: 10, iterations: 1 },
      perDay: { tokens: 100, iterations: 5 },
    },
  })
  const model = scriptedModel(["answer"])
  const events: EngineEvent[] = []
  for await (const event of executeTurn(request, { model, now: FIXED_NOW })) {
    events.push(event)
  }
  const terminals = terminalOf(events)
  assert.equal(terminals.length, 1)
  assert.equal(terminals[0]!.type, "run.failed")
  if (terminals[0]!.type === "run.failed") {
    assert.equal(terminals[0]!.error.code, "engine.input_invalid")
  }
})
