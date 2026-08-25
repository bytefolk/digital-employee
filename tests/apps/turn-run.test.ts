/**
 * Spawn-surface semantics tests for `turn run` (#173 AC-001..AC-004):
 * golden-path single terminal, digest-mismatch rejection before any
 * consumption, modeled budget-exceeded terminals exiting 0, crash-level
 * failures exiting 1 without a terminal, and budget-injection mapping.
 */

import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { runTurn } from "../../apps/cli/turn/turn-run.js"
import {
  computeEnvelopeDigest,
  TURN_ENVELOPE_VERSION,
} from "../../apps/cli/turn/envelope.js"
import type { ModelPort } from "../../packages/engine/src/index.js"
import {
  createDeterministicModelPort,
} from "../../packages/engine/src/index.js"
import {
  OSS_MAINTAINER_TEMPLATE,
  renderOrganizationFile,
} from "../../apps/cli/workspace/templates.js"

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "turn-run-ws-"))
  const digests: Record<string, { name: string; version: string; digest: string }> = {}
  for (const role of OSS_MAINTAINER_TEMPLATE.roles) {
    digests[role.id] = {
      name: role.id,
      version: "0.1.0",
      digest: `sha256:${"a".repeat(64)}`,
    }
  }
  const organization = renderOrganizationFile(
    OSS_MAINTAINER_TEMPLATE,
    "oss-maintainer",
    workspace,
    digests,
    "2026-08-23T00:00:00.000Z",
  )
  await mkdir(workspace, { recursive: true })
  await writeFile(
    path.join(workspace, organization.portablePath),
    organization.content,
  )
  await mkdir(path.join(workspace, "positions"), { recursive: true })
  return workspace
}

function sealedEnvelope(
  workspaceRef: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const body = {
    schemaVersion: TURN_ENVELOPE_VERSION,
    workspaceRef,
    positionId: "repo-owner",
    turnId: "turn-1",
    input: "Summarize the open issues.",
    budget: { maxIterations: 2 },
    ...overrides,
  }
  return { ...body, envelopeDigest: computeEnvelopeDigest(body) }
}

interface CapturedRun {
  result: Awaited<ReturnType<typeof runTurn>>
  events: Array<Record<string, unknown>>
  diagnostics: string[]
}

async function execute(
  workspace: string,
  envelopeText: string,
  model?: ModelPort,
): Promise<CapturedRun> {
  const events: Array<Record<string, unknown>> = []
  const diagnostics: string[] = []
  const result = await runTurn({
    workspace,
    positionId: "repo-owner",
    envelopeText,
    model,
    writeEvent: (line) => events.push(JSON.parse(line)),
    writeDiagnostic: (line) => diagnostics.push(line),
  })
  return { result, events, diagnostics }
}

test("AC-001: golden path — sealed envelope yields one terminal, exit 0", async () => {
  const workspace = await createWorkspace()
  const envelope = sealedEnvelope(workspace)
  const { result, events } = await execute(
    workspace,
    JSON.stringify(envelope),
    createDeterministicModelPort(["all issues summarized"]),
  )
  assert.equal(result.exitCode, 0)
  assert.equal(result.terminalEmitted, true)
  assert.equal(events[0]!.type, "run.started")
  const terminals = events.filter(
    (event) => event.type === "run.completed" || event.type === "run.failed",
  )
  assert.equal(terminals.length, 1)
  assert.equal(terminals[0]!.type, "run.completed")
  for (const event of events) {
    assert.equal(typeof event.runId, "string")
    assert.equal(typeof event.timestamp, "string")
  }
})

test("AC-001: digest mismatch rejects before any model consumption, exit 1", async () => {
  const workspace = await createWorkspace()
  const envelope = sealedEnvelope(workspace)
  envelope.input = "tampered after sealing"
  let modelCalls = 0
  const model: ModelPort = {
    async complete() {
      modelCalls += 1
      return { text: "never" }
    },
  }
  const { result, events, diagnostics } = await execute(
    workspace,
    JSON.stringify(envelope),
    model,
  )
  assert.equal(result.exitCode, 1)
  assert.equal(result.terminalEmitted, false)
  assert.equal(events.length, 0)
  assert.equal(modelCalls, 0)
  assert.ok(
    diagnostics.some((line) =>
      line.includes("engine.envelope_digest_mismatch"),
    ),
  )
})

test("AC-003: malformed envelope exits 1 with no terminal line", async () => {
  const workspace = await createWorkspace()
  const { result, events, diagnostics } = await execute(workspace, "{not json")
  assert.equal(result.exitCode, 1)
  assert.equal(events.length, 0)
  assert.ok(
    diagnostics.some((line) => line.includes("engine.envelope_invalid")),
  )
})

test("AC-003: missing model credentials exits 1, no terminal line", async () => {
  const workspace = await createWorkspace()
  const envelope = sealedEnvelope(workspace)
  const events: Array<Record<string, unknown>> = []
  const diagnostics: string[] = []
  const result = await runTurn({
    workspace,
    positionId: "repo-owner",
    envelopeText: JSON.stringify(envelope),
    env: {},
    writeEvent: (line) => events.push(JSON.parse(line)),
    writeDiagnostic: (line) => diagnostics.push(line),
  })
  assert.equal(result.exitCode, 1)
  assert.equal(events.length, 0)
  assert.ok(
    diagnostics.some((line) => line.includes("engine.model_unavailable")),
  )
})

test("model port resolves through the environment allowlist only", async () => {
  const workspace = await createWorkspace()
  const envelope = sealedEnvelope(workspace)
  const events: Array<Record<string, unknown>> = []
  const result = await runTurn({
    workspace,
    positionId: "repo-owner",
    envelopeText: JSON.stringify(envelope),
    env: {
      DIGITAL_EMPLOYEE_ENGINE_MODEL: "deterministic",
      DIGITAL_EMPLOYEE_ENGINE_MODEL_SCRIPT: '["done via env"]',
    },
    writeEvent: (line) => events.push(JSON.parse(line)),
    writeDiagnostic: () => undefined,
  })
  assert.equal(result.exitCode, 0)
  const terminal = events.find((event) => event.type === "run.completed")
  assert.ok(terminal)
  assert.equal(terminal!.output, "done via env")
})

test("#182 AC-004: an unknown model port still fails closed", async () => {
  const workspace = await createWorkspace()
  const envelope = sealedEnvelope(workspace)
  const events: Array<Record<string, unknown>> = []
  const diagnostics: string[] = []
  const result = await runTurn({
    workspace,
    positionId: "repo-owner",
    envelopeText: JSON.stringify(envelope),
    env: { DIGITAL_EMPLOYEE_ENGINE_MODEL: "not-a-real-port" },
    writeEvent: (line) => events.push(JSON.parse(line)),
    writeDiagnostic: (line) => diagnostics.push(line),
  })
  assert.equal(result.exitCode, 1)
  assert.equal(events.length, 0)
  assert.ok(
    diagnostics.some((line) => line.includes("engine.model_unavailable")),
    "an unrecognized port must not silently degrade",
  )
})

test("#182 AC-004: an unusable claude-local binary is an environment fault, not a verdict", async () => {
  const workspace = await createWorkspace()
  const envelope = sealedEnvelope(workspace)
  const events: Array<Record<string, unknown>> = []
  const diagnostics: string[] = []
  const result = await runTurn({
    workspace,
    positionId: "repo-owner",
    envelopeText: JSON.stringify(envelope),
    env: {
      DIGITAL_EMPLOYEE_ENGINE_MODEL: "claude-local",
      DIGITAL_EMPLOYEE_CLAUDE_COMMAND: "/nonexistent/claude-for-this-test",
    },
    writeEvent: (line) => events.push(JSON.parse(line)),
    writeDiagnostic: (line) => diagnostics.push(line),
  })
  // Exit 1 with no terminal: a missing binary must not be modeled as a failed
  // turn (which would exit 0 and read as a verdict about the employee).
  assert.equal(result.exitCode, 1)
  assert.equal(events.length, 0)
  assert.ok(
    diagnostics.some((line) => line.includes("claude_local_binary_unavailable")),
    "the diagnostic must name the environment fault, not just model_unavailable",
  )
})

test("#182 AC-005: a claude-local binary outside the version window fails closed", async () => {
  const workspace = await createWorkspace()
  const envelope = sealedEnvelope(workspace)
  const diagnostics: string[] = []
  const stubDir = await mkdtemp(path.join(os.tmpdir(), "claude-local-oldver-"))
  // A single executable path: the probe spawns without a shell, so the command
  // must not be a space-separated "node <script>" string.
  const stub = path.join(stubDir, "claude-stub")
  await writeFile(
    stub,
    `#!${process.execPath}\nprocess.stdout.write("2.0.1 (Claude Code)\\n")\n`,
    { mode: 0o755 },
  )
  const result = await runTurn({
    workspace,
    positionId: "repo-owner",
    envelopeText: JSON.stringify(envelope),
    env: {
      DIGITAL_EMPLOYEE_ENGINE_MODEL: "claude-local",
      DIGITAL_EMPLOYEE_CLAUDE_COMMAND: stub,
    },
    writeEvent: () => undefined,
    writeDiagnostic: (line) => diagnostics.push(line),
  })
  assert.equal(result.exitCode, 1)
  assert.ok(
    diagnostics.some((line) => line.includes("claude_local_version_not_supported")),
    "an out-of-window version must be rejected as such, not as a missing binary",
  )
})

test("AC-002: modeled budget-exceeded terminal exits 0 with escalation verdict", async () => {
  const workspace = await createWorkspace()
  const envelope = sealedEnvelope(workspace, {
    budget: { maxIterations: 4, maxTokens: 50 },
  })
  const model: ModelPort = {
    async complete() {
      return { text: "verbose", inputTokens: 60, outputTokens: 60 }
    },
  }
  const { result, events } = await execute(
    workspace,
    JSON.stringify(envelope),
    model,
  )
  assert.equal(result.exitCode, 0)
  const terminal = events.find((event) => event.type === "run.failed")
  assert.ok(terminal, "expected a modeled run.failed terminal")
  const error = terminal!.error as { code: string; terminalReason: string }
  assert.equal(error.code, "engine.turn_budget_exceeded")
  assert.equal(error.terminalReason, "turn_budget_exceeded")
})

test("AC-004: position-budget triple accepted with in-memory ledger", async () => {
  const workspace = await createWorkspace()
  const envelope = sealedEnvelope(workspace, {
    positionBudget: {
      perTask: { iterations: 4 },
      perDay: { iterations: 100 },
    },
    taskId: "task-1",
    dayKey: "2026-08-23",
  })
  const { result, events } = await execute(
    workspace,
    JSON.stringify(envelope),
    createDeterministicModelPort(["done"]),
  )
  assert.equal(result.exitCode, 0)
  const terminal = events.find((event) => event.type === "run.completed")
  assert.ok(terminal)
})

test("AC-004: partial position-budget triple fails closed", async () => {
  const workspace = await createWorkspace()
  const envelope = sealedEnvelope(workspace, {
    taskId: "task-1",
    dayKey: "2026-08-23",
  })
  const { result, events, diagnostics } = await execute(
    workspace,
    JSON.stringify(envelope),
    createDeterministicModelPort(["never"]),
  )
  assert.equal(result.exitCode, 1)
  assert.equal(events.length, 0)
  assert.ok(
    diagnostics.some((line) => line.includes("engine.input_invalid")),
  )
})

test("envelope positionId must match the --position argument", async () => {
  const workspace = await createWorkspace()
  const envelope = sealedEnvelope(workspace, { positionId: "other-role" })
  const { result, events } = await execute(
    workspace,
    JSON.stringify(envelope),
    createDeterministicModelPort(["never"]),
  )
  assert.equal(result.exitCode, 1)
  assert.equal(events.length, 0)
})

test("uninitialized workspace fails closed", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "turn-run-empty-"))
  const envelope = sealedEnvelope(workspace)
  const { result, events, diagnostics } = await execute(
    workspace,
    JSON.stringify(envelope),
    createDeterministicModelPort(["never"]),
  )
  assert.equal(result.exitCode, 1)
  assert.equal(events.length, 0)
  assert.ok(
    diagnostics.some((line) =>
      line.includes("workspace_org_workspace_not_initialized"),
    ),
  )
})

test("workspaceRef mismatch fails closed", async () => {
  const workspace = await createWorkspace()
  const envelope = sealedEnvelope(path.join(workspace, "elsewhere"))
  const { result, events } = await execute(
    workspace,
    JSON.stringify(envelope),
    createDeterministicModelPort(["never"]),
  )
  assert.equal(result.exitCode, 1)
  assert.equal(events.length, 0)
})
