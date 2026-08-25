import assert from "node:assert/strict"
import test from "node:test"

import {
  APPROVAL_DENIED_CODE,
  APPROVAL_EXPIRED_CODE,
  APPROVAL_PREVIEW_INVALID_CODE,
  APPROVAL_REQUIRED_CODE,
  createDeterministicModelPort,
  createInMemoryEvidenceSink,
  executeTurn,
  isTerminalEngineEvent,
} from "../../packages/engine/src/index.js"
import type {
  EngineEvent,
  EngineTurnRequest,
  TurnApprovalActionInput,
  TurnPendingApprovalInput,
} from "../../packages/engine/src/index.js"

const FIXED_NOW = () => new Date("2026-08-23T00:00:00.000Z")

function validPreviewRef(overrides: Record<string, string> = {}) {
  return {
    version: "write-approval.v1",
    previewId: "preview-1",
    previewDigest: "sha256:ab12",
    state: "preview_validated",
    ...overrides,
  }
}

function approvalAction(
  overrides: Partial<TurnApprovalActionInput> = {},
): TurnApprovalActionInput {
  return {
    kind: "write",
    description: "Update the roadmap milestone table",
    target: "docs/roadmap.md",
    preview: validPreviewRef(),
    ...overrides,
  }
}

function pendingApproval(
  overrides: Partial<TurnPendingApprovalInput> = {},
): TurnPendingApprovalInput {
  return {
    approvalId: "approval-1",
    decision: "granted",
    decidedBy: "operator",
    ...overrides,
  }
}

function baseRequest(overrides: Partial<EngineTurnRequest> = {}): EngineTurnRequest {
  return {
    workspaceRef: "ws-1",
    positionId: "repo-owner",
    turnId: "turn-1",
    runId: "run-1",
    input: "Apply the milestone update.",
    budget: { maxIterations: 2 },
    ...overrides,
  }
}

async function collect(request: EngineTurnRequest, script: string[] = []) {
  const evidenceSink = createInMemoryEvidenceSink()
  const model = createDeterministicModelPort(script)
  const events: EngineEvent[] = []
  for await (const event of executeTurn(request, {
    model,
    now: FIXED_NOW,
    evidenceSink,
    newId: () => "approval-1",
  })) {
    events.push(event)
  }
  return { events, evidence: evidenceSink.records }
}

test("#187 AC-001: request turn with a validated preview emits approval.requested and settles retryable", async () => {
  const { events, evidence } = await collect(
    baseRequest({
      approvalAction: approvalAction(),
      deadline: "2026-08-23T01:00:00.000Z",
    }),
  )
  assert.deepEqual(
    events.map((event) => event.type),
    ["run.started", "approval.requested", "run.failed"],
  )
  const requested = events[1]!
  assert.equal(requested.type, "approval.requested")
  if (requested.type === "approval.requested") {
    assert.equal(requested.approvalId, "approval-1")
    assert.equal(requested.action.kind, "write")
    assert.equal(requested.action.target, "docs/roadmap.md")
    assert.equal(requested.expiresAt, "2026-08-23T01:00:00.000Z")
  }
  const terminal = events[2]!
  assert.equal(terminal.type, "run.failed")
  if (terminal.type === "run.failed") {
    assert.equal(terminal.error.code, APPROVAL_REQUIRED_CODE)
    assert.equal(terminal.error.retryable, true)
    assert.equal(terminal.error.terminalReason, "cancelled")
  }
  // No model consumption before the gate settles.
  assert.equal(events.some((event) => event.type === "model.delta"), false)
  assert.equal(evidence.length, 1)
  assert.deepEqual(evidence[0]!.approvalRef, {
    approvalId: "approval-1",
    previewId: "preview-1",
    outcome: "requested",
  })
})

test("#187 AC-001: write without a validated preview fails closed", async () => {
  for (const preview of [
    validPreviewRef({ state: "preview_pending" }),
    validPreviewRef({ version: "write-approval.v0" }),
  ]) {
    const { events } = await collect(
      baseRequest({ approvalAction: approvalAction({ preview }) }),
    )
    assert.equal(events.some((event) => event.type === "approval.requested"), false)
    const terminal = events.filter(isTerminalEngineEvent)
    assert.equal(terminal.length, 1)
    assert.equal(terminal[0]!.type, "run.failed")
    if (terminal[0]!.type === "run.failed") {
      assert.equal(terminal[0]!.error.code, APPROVAL_PREVIEW_INVALID_CODE)
      assert.equal(terminal[0]!.error.retryable, false)
    }
  }
})

test("#187 AC-003: denied verdict settles a denied terminal with evidence and no retry", async () => {
  const { events, evidence } = await collect(
    baseRequest({
      pendingApproval: pendingApproval({
        decision: "denied",
        reason: "out of scope for this release",
      }),
    }),
    ["should never run"],
  )
  assert.deepEqual(
    events.map((event) => event.type),
    ["run.started", "approval.denied", "run.failed"],
  )
  const denied = events[1]!
  if (denied.type === "approval.denied") {
    assert.equal(denied.approvalId, "approval-1")
    assert.equal(denied.deniedBy, "operator")
    assert.equal(denied.reason, "out of scope for this release")
  } else {
    assert.fail("expected approval.denied")
  }
  const terminal = events[2]!
  if (terminal.type === "run.failed") {
    assert.equal(terminal.error.code, APPROVAL_DENIED_CODE)
    assert.equal(terminal.error.retryable, false)
    assert.equal(terminal.error.terminalReason, "cancelled")
  } else {
    assert.fail("expected run.failed")
  }
  // Denied terminal never consumes the model: no downgrade to an unapproved write.
  assert.equal(events.some((event) => event.type === "model.delta"), false)
  assert.equal(evidence.length, 1)
  assert.deepEqual(evidence[0]!.approvalRef, {
    approvalId: "approval-1",
    outcome: "denied",
  })
  assert.equal(evidence[0]!.terminal.errorCode, APPROVAL_DENIED_CODE)
})

test("#187 AC-003: granted verdict records consumption before executing, then completes", async () => {
  const { events, evidence } = await collect(
    baseRequest({ pendingApproval: pendingApproval({ scope: "run" }) }),
    ["done"],
  )
  const types = events
    .map((event) => event.type)
    .filter((type) => type !== "usage")
  assert.deepEqual(types, [
    "run.started",
    "approval.granted",
    "model.delta",
    "run.completed",
  ])
  const granted = events[1]!
  if (granted.type === "approval.granted") {
    assert.equal(granted.grantedBy, "operator")
    assert.equal(granted.scope, "run")
  } else {
    assert.fail("expected approval.granted")
  }
  const terminal = events[events.length - 1]!
  assert.equal(terminal.type, "run.completed")
  assert.equal(evidence[0]!.approvalRef?.outcome, "granted")
  assert.equal(evidence[0]!.terminal.reason, "goal_met")
})

test("#187 AC-003: granted verdict defaults scope to once", async () => {
  const { events } = await collect(
    baseRequest({ pendingApproval: pendingApproval() }),
    ["done"],
  )
  const granted = events.find((event) => event.type === "approval.granted")
  if (granted?.type === "approval.granted") {
    assert.equal(granted.scope, "once")
  } else {
    assert.fail("expected approval.granted")
  }
})

test("#187 AC-005: expired verdict fails closed, distinguishable from denied", async () => {
  const { events, evidence } = await collect(
    baseRequest({
      pendingApproval: pendingApproval({
        decision: "granted",
        expiresAt: "2026-08-22T23:59:59.000Z",
      }),
    }),
    ["should never run"],
  )
  assert.equal(events.some((event) => event.type === "approval.granted"), false)
  const terminal = events.filter(isTerminalEngineEvent)
  assert.equal(terminal.length, 1)
  if (terminal[0]!.type === "run.failed") {
    // Same terminal family as denied (cancelled), distinct error code.
    assert.equal(terminal[0]!.error.code, APPROVAL_EXPIRED_CODE)
    assert.notEqual(terminal[0]!.error.code, APPROVAL_DENIED_CODE)
    assert.equal(terminal[0]!.error.terminalReason, "cancelled")
    assert.equal(terminal[0]!.error.retryable, false)
  } else {
    assert.fail("expected run.failed")
  }
  assert.equal(evidence[0]!.approvalRef?.outcome, "expired")
})

test("#187 ordering: request turn and resume turn fields are mutually exclusive", async () => {
  const evidenceSink = createInMemoryEvidenceSink()
  const events: EngineEvent[] = []
  for await (const event of executeTurn(
    baseRequest({
      approvalAction: approvalAction(),
      pendingApproval: pendingApproval(),
    }),
    {
      model: createDeterministicModelPort(["never"]),
      now: FIXED_NOW,
      evidenceSink,
    },
  )) {
    events.push(event)
  }
  const terminal = events.filter(isTerminalEngineEvent)
  assert.equal(terminal.length, 1)
  if (terminal[0]!.type === "run.failed") {
    assert.equal(terminal[0]!.error.code, "engine.input_invalid")
  } else {
    assert.fail("expected run.failed")
  }
  assert.equal(
    events.some((event) => event.type.startsWith("approval.")),
    false,
  )
})

test("#187 AC-004: approval settlements reuse the existing terminal-reason vocabulary", async () => {
  const { events } = await collect(
    baseRequest({ approvalAction: approvalAction() }),
  )
  const terminal = events.filter(isTerminalEngineEvent)
  assert.equal(terminal.length, 1)
  if (terminal[0]!.type === "run.failed") {
    // No new TerminalReason value is introduced for the approval lifecycle.
    const knownReasons = new Set([
      "goal_met",
      "invalid_output_exhausted",
      "turn_budget_exceeded",
      "position_budget_exceeded",
      "iteration_cap",
      "doom_loop",
      "deadline_exceeded",
      "cancelled",
      "engine_internal_error",
    ])
    assert.equal(knownReasons.has(terminal[0]!.error.terminalReason), true)
  }
})

test("#187 hardening: oversized pendingApproval.reason rejects at the boundary", async () => {
  const { events } = await collect(
    baseRequest({
      pendingApproval: pendingApproval({ reason: "x".repeat(2048) }),
    }),
    ["should never run"],
  )
  const terminal = events.filter(isTerminalEngineEvent)
  assert.equal(terminal.length, 1)
  if (terminal[0]!.type === "run.failed") {
    assert.equal(terminal[0]!.error.code, "engine.input_invalid")
  } else {
    assert.fail("expected run.failed")
  }
  assert.equal(
    events.some((event) => event.type.startsWith("approval.")),
    false,
  )
})

test("#187 hardening: evidence persists before the approval.denied event", async () => {
  const order: string[] = []
  const evidenceSink = {
    async write() {
      order.push("evidence")
    },
  }
  const events: EngineEvent[] = []
  for await (const event of executeTurn(
    baseRequest({
      pendingApproval: pendingApproval({ decision: "denied" }),
    }),
    {
      model: createDeterministicModelPort(["never"]),
      now: FIXED_NOW,
      evidenceSink,
    },
  )) {
    if (event.type === "approval.denied") order.push("event")
    events.push(event)
  }
  assert.deepEqual(order, ["evidence", "event"])
})

test("#187 hardening: failing evidence sink settles engine.internal_error fail closed", async () => {
  const evidenceSink = {
    async write(): Promise<void> {
      throw new Error("evidence sink unavailable")
    },
  }
  const events: EngineEvent[] = []
  for await (const event of executeTurn(
    baseRequest({
      pendingApproval: pendingApproval({ decision: "denied" }),
    }),
    {
      model: createDeterministicModelPort(["never"]),
      now: FIXED_NOW,
      evidenceSink,
    },
  )) {
    events.push(event)
  }
  const terminal = events.filter(isTerminalEngineEvent)
  assert.equal(terminal.length, 1)
  if (terminal[0]!.type === "run.failed") {
    assert.equal(terminal[0]!.error.code, "engine.internal_error")
    assert.equal(terminal[0]!.error.retryable, false)
    assert.equal(terminal[0]!.error.terminalReason, "engine_internal_error")
  } else {
    assert.fail("expected run.failed")
  }
  assert.equal(
    events.some((event) => event.type.startsWith("approval.")),
    false,
  )
})
