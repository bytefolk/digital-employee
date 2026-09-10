/**
 * Spawn-surface semantics tests for `turn run` (#173 AC-001..AC-004):
 * golden-path single terminal, digest-mismatch rejection before any
 * consumption, modeled budget-exceeded terminals exiting 0, crash-level
 * failures exiting 1 without a terminal, and budget-injection mapping.
 */

import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import { runTurn } from "../../apps/cli/turn/turn-run.js"
import { QoderAgentHostAdapter } from "../../apps/cli/qoder-agent-host.js"
import { createEmployeePackage } from "../../apps/cli/employee-package.js"
import {
  computeEnvelopeDigest,
  TURN_ENVELOPE_V1_VERSION,
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
import { validateOrganizationDocument } from "../../apps/cli/org/budget.js"
import { deriveOrganizationPermissions } from "../../apps/cli/org/permissions.js"

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
)
const QODER_FIXTURE = path.join(
  repoRoot,
  "tests",
  "apps",
  "fixtures",
  "fake-qoder.mjs",
)

/**
 * The spawn surface spawns without a shell, so the qoder command must be one
 * executable path. This stub injects the zero-tool fixture mode and then runs
 * the conformance fixture (#185 AC-002).
 */
async function createZeroToolQoderStub(): Promise<string> {
  const stubDir = await mkdtemp(path.join(os.tmpdir(), "qoder-port-stub-"))
  const stub = path.join(stubDir, "qodercli-stub")
  await writeFile(
    stub,
    [
      `#!${process.execPath}`,
      `process.argv.splice(2, 0, "--fixture-mode", "zero-tool")`,
      `import(${JSON.stringify(pathToFileURL(QODER_FIXTURE).href)})`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  )
  return stub
}

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
  // Derive and write the org-permissions artifact so the turn-run spawn
  // surface can load it fresh (#159 REQ-009).
  const validated = validateOrganizationDocument(
    JSON.parse(new TextDecoder().decode(organization.content)),
  )
  const permissions = deriveOrganizationPermissions(validated)
  await mkdir(path.join(workspace, ".digital-employee"), { recursive: true })
  await writeFile(
    path.join(workspace, ".digital-employee", "permissions.json"),
    `${JSON.stringify(permissions, null, 2)}\n`,
  )
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

test("win32 Qoder turn rejects before any candidate version spawn", async (t) => {
  const workspace = await createWorkspace()
  t.after(() => rm(workspace, { recursive: true, force: true }))
  let candidateSpawns = 0
  // Count the executor seam used by the real candidate resolver, preventing
  // any real executable from being launched even when the gate regresses.
  const resolver = QoderAgentHostAdapter.prototype as unknown as {
    probeCommandCandidates(signal?: AbortSignal): Promise<unknown>
  }
  const originalResolve = resolver.probeCommandCandidates
  t.mock.method(resolver, "probeCommandCandidates", async () => {
    return originalResolve.call(new QoderAgentHostAdapter({
      environment: {},
      versionExecutor: async () => {
        candidateSpawns += 1
        return { status: "not_found" }
      },
    }))
  })
  const platform = Object.getOwnPropertyDescriptor(process, "platform")
  assert.ok(platform)
  Object.defineProperty(process, "platform", { value: "win32" })
  const diagnostics: string[] = []
  const events: string[] = []
  try {
    const result = await runTurn({
      workspace,
      positionId: "repo-owner",
      envelopeText: JSON.stringify(sealedEnvelope(workspace)),
      env: { DIGITAL_EMPLOYEE_ENGINE_MODEL: "qoder" },
      writeEvent: (line) => events.push(line),
      writeDiagnostic: (line) => diagnostics.push(line),
    })
    assert.deepEqual(result, { exitCode: 1, terminalEmitted: false })
    assert.deepEqual(events, [])
    assert.match(diagnostics.join("\n"), /host_platform_not_conformance_verified/)
    assert.equal(candidateSpawns, 0)
  } finally {
    Object.defineProperty(process, "platform", platform)
  }
})

test("#185 AC-002: qoder port completes a turn through the spawn surface", async () => {
  const workspace = await createWorkspace()
  const envelope = sealedEnvelope(workspace)
  const stub = await createZeroToolQoderStub()
  const events: Array<Record<string, unknown>> = [];
  const diagnostics: string[] = [];
  // #241: the credential decision reads the OPERATOR view (process.env), the
  // same one `doctor` evaluates — not the stripped run allowlist.
  const saved = process.env.QODER_PERSONAL_ACCESS_TOKEN;
  process.env.QODER_PERSONAL_ACCESS_TOKEN = "fixture-service-token";
  try {
  const result = await runTurn({
    workspace,
    positionId: "repo-owner",
    envelopeText: JSON.stringify(envelope),
    env: {
      DIGITAL_EMPLOYEE_ENGINE_MODEL: "qoder",
      DIGITAL_EMPLOYEE_QODER_COMMAND: stub,
      PATH: process.env.PATH,
    },
    writeEvent: (line) => events.push(JSON.parse(line)),
    writeDiagnostic: (line) => diagnostics.push(line),
  })
  assert.equal(result.exitCode, 0, diagnostics.join("\n"));
  assert.equal(result.terminalEmitted, true);
  const terminal = events.find((event) => event.type === "run.completed");
  assert.ok(terminal, `expected run.completed, got: ${diagnostics.join("\n")}`);
  assert.equal(terminal!.output, "fixture qoder answer");
  // Usage honesty (AC-005): the port reports no token counts, so no usage
  // event may be emitted for this turn.
  assert.ok(!events.some((event) => event.type === "usage"));
  } finally {
    if (saved === undefined) delete process.env.QODER_PERSONAL_ACCESS_TOKEN;
    else process.env.QODER_PERSONAL_ACCESS_TOKEN = saved;
  }
})

test("CN-only PATH completes doctor, setup, employee run and turn run in CLI processes", async (t) => {
  if (process.platform === "win32") return t.skip("fixture executable is POSIX-only")
  const workspace = await createWorkspace()
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const bin = path.join(workspace, "bin")
  const employee = path.join(workspace, "employee")
  const capture = path.join(workspace, "capture.json")
  await mkdir(bin)
  await createEmployeePackage(employee)
  // Only the CN name exists on PATH. An absolute interpreter prevents the
  // fixture from finding any installed Qoder binary or using a real account.
  await writeFile(path.join(bin, "qoderclicn"), [
    `#!${process.execPath}`,
    `const toolsIndex = process.argv.indexOf("--tools")`,
    `if (toolsIndex >= 0 && process.argv[toolsIndex + 1] === "") process.argv.push("--fixture-mode", "zero-tool")`,
    `process.argv.push("--capture", ${JSON.stringify(capture)})`,
    `import(${JSON.stringify(pathToFileURL(QODER_FIXTURE).href)})`,
    "",
  ].join("\n"), { mode: 0o755 })
  const environment = {
    PATH: bin,
    HOME: workspace,
    DIGITAL_EMPLOYEE_ENGINE_MODEL: "qoder",
    QODER_PERSONAL_ACCESS_TOKEN: "fixture-service-token",
  }
  const cli = (args: string[], input?: string, override?: string) => spawnSync(
    process.execPath,
    ["--import", "tsx", path.join(repoRoot, "apps/cli/bin.ts"), ...args],
    {
      cwd: repoRoot,
      env: { ...environment, ...(override === undefined ? {} : { DIGITAL_EMPLOYEE_QODER_COMMAND: override }) },
      encoding: "utf8",
      timeout: 30_000,
      input,
    },
  )
  // Exercise turn first so the baseline independently exposes its hardcoded
  // international command before the separate probe validators fail.
  const turn = cli(["turn", "run", workspace, "--position", "repo-owner", "--stdin"], JSON.stringify(sealedEnvelope(workspace)))
  assert.equal(turn.status, 0, turn.stderr)
  const events = turn.stdout.trim().split("\n").map((line) => JSON.parse(line))
  assert.equal(events.filter((event) => event.type === "run.completed").length, 1)
  assert.equal(events.find((event) => event.type === "run.completed")?.output, "fixture qoder answer")
  const doctor = cli(["doctor", "--engine", "qoder", "--json"])
  assert.equal(doctor.status, 0, doctor.stderr)
  const doctorProbe = JSON.parse(doctor.stdout).hosts[0]
  assert.equal(Object.hasOwn(doctorProbe, "resolvedCommand"), false)
  assert.equal(doctorProbe.issues.find((issue: { code: string }) => issue.code === "qoder_command_selected")?.message, "Qoder command: qoderclicn")
  const setup = cli(["setup", employee, "--json"])
  assert.equal(setup.status, 0, setup.stderr)
  assert.equal(JSON.parse(setup.stdout).hosts.find((host: { id: string }) => host.id === "qoder").available, true)
  const run = cli(["run", employee, "--engine", "qoder", "--stdin", "--json"], '{"message":"fixture question"}\n')
  assert.equal(run.status, 0, run.stderr)
  assert.equal(JSON.parse(run.stdout).output.answer, "fixture answer")
  const captured = JSON.parse(await readFile(capture, "utf8"))
  assert.equal(captured.authPayloadMetadata.mode, 0o600)
  assert.equal(captured.environmentKeys.includes("QODER_PERSONAL_ACCESS_TOKEN"), false)
  assert.equal(captured.args.includes(environment.QODER_PERSONAL_ACCESS_TOKEN), false)
  const missing = cli(["turn", "run", workspace, "--position", "repo-owner", "--stdin"], JSON.stringify(sealedEnvelope(workspace)), "missing-override")
  assert.equal(missing.status, 1)
  assert.equal(missing.stdout, "")
  assert.match(missing.stderr, /qoder_binary_unavailable/)
  assert.match(missing.stderr, /missing-override/)
})

test("#185 AC-003: missing service token fails closed at resolution, exit 1", async () => {
  const workspace = await createWorkspace()
  const envelope = sealedEnvelope(workspace)
  const stub = await createZeroToolQoderStub()
  const events: Array<Record<string, unknown>> = []
  const diagnostics: string[] = []
  const result = await runTurn({
    workspace,
    positionId: "repo-owner",
    envelopeText: JSON.stringify(envelope),
    env: {
      DIGITAL_EMPLOYEE_ENGINE_MODEL: "qoder",
      DIGITAL_EMPLOYEE_QODER_COMMAND: stub,
      PATH: process.env.PATH,
    },
    writeEvent: (line) => events.push(JSON.parse(line)),
    writeDiagnostic: (line) => diagnostics.push(line),
  })
  assert.equal(result.exitCode, 1)
  assert.equal(events.length, 0)
  assert.ok(
    diagnostics.some((line) =>
      line.includes("qoder_service_token_not_configured"),
    ),
    "the diagnostic must name the missing-token fault",
  )
  assert.ok(diagnostics.some((line) => line.includes(`Qoder command: ${stub}`)))
})

test("#185 AC-003: an out-of-family qodercli version fails closed", async () => {
  const workspace = await createWorkspace()
  const envelope = sealedEnvelope(workspace)
  const stubDir = await mkdtemp(path.join(os.tmpdir(), "qoder-port-oldver-"))
  const stub = path.join(stubDir, "qodercli-stub")
  await writeFile(
    stub,
    `#!${process.execPath}\nprocess.stdout.write("1.2.3\\n")\n`,
    { mode: 0o755 },
  )
  const diagnostics: string[] = []
  const result = await runTurn({
    workspace,
    positionId: "repo-owner",
    envelopeText: JSON.stringify(envelope),
    env: {
      DIGITAL_EMPLOYEE_ENGINE_MODEL: "qoder",
      DIGITAL_EMPLOYEE_QODER_COMMAND: stub,
      QODER_PERSONAL_ACCESS_TOKEN: "fixture-service-token",
      PATH: process.env.PATH,
    },
    writeEvent: () => undefined,
    writeDiagnostic: (line) => diagnostics.push(line),
  })
  assert.equal(result.exitCode, 1)
  assert.ok(
    diagnostics.some((line) =>
      line.includes("qoder_version_not_conformance_verified"),
    ),
    "an out-of-family version must be rejected as such, not as a missing binary",
  )
})

test("#185 AC-003: a missing qodercli binary is an environment fault, not a verdict", async () => {
  const workspace = await createWorkspace()
  const envelope = sealedEnvelope(workspace)
  const events: Array<Record<string, unknown>> = []
  const diagnostics: string[] = []
  const result = await runTurn({
    workspace,
    positionId: "repo-owner",
    envelopeText: JSON.stringify(envelope),
    env: {
      DIGITAL_EMPLOYEE_ENGINE_MODEL: "qoder",
      DIGITAL_EMPLOYEE_QODER_COMMAND: "/nonexistent/qodercli-for-this-test",
      QODER_PERSONAL_ACCESS_TOKEN: "fixture-service-token",
    },
    writeEvent: (line) => events.push(JSON.parse(line)),
    writeDiagnostic: (line) => diagnostics.push(line),
  })
  assert.equal(result.exitCode, 1)
  assert.equal(events.length, 0)
  assert.ok(
    diagnostics.some((line) => line.includes("qoder_binary_unavailable")),
  )
})

// #193: pendingApproval verdict fixtures — the five envelope forms
// (granted / denied / expired / malformed / absent) settling through the
// already-merged #187 engine gate with zero new engine changes.

test("#193 AC-001: granted verdict emits approval.granted before any model consumption", async () => {
  const workspace = await createWorkspace()
  const envelope = sealedEnvelope(workspace, {
    pendingApproval: {
      approvalId: "appr-granted-1",
      decision: "granted",
      decidedBy: "operator",
      scope: "once",
    },
  })
  let modelCalls = 0
  let modelCallsAtGranted = -1
  const events: Array<Record<string, unknown>> = []
  const result = await runTurn({
    workspace,
    positionId: "repo-owner",
    envelopeText: JSON.stringify(envelope),
    model: {
      async complete() {
        modelCalls += 1
        return { text: "write executed under approval" }
      },
    },
    writeEvent: (line) => {
      const event = JSON.parse(line) as Record<string, unknown>
      events.push(event)
      if (event.type === "approval.granted") modelCallsAtGranted = modelCalls
    },
    writeDiagnostic: () => undefined,
  })
  assert.equal(result.exitCode, 0)
  assert.equal(
    modelCallsAtGranted,
    0,
    "approval.granted must precede any model consumption",
  )
  assert.equal(modelCalls, 1)
  const granted = events.find((event) => event.type === "approval.granted")
  assert.ok(granted)
  assert.equal(granted!.approvalId, "appr-granted-1")
  const grantedIndex = events.indexOf(granted!)
  const terminal = events.find((event) => event.type === "run.completed")
  assert.ok(terminal)
  assert.ok(events.indexOf(terminal!) > grantedIndex)
})

test("#193 AC-002: denied verdict settles non-retryable with zero model consumption", async () => {
  const workspace = await createWorkspace()
  const envelope = sealedEnvelope(workspace, {
    pendingApproval: {
      approvalId: "appr-denied-1",
      decision: "denied",
      decidedBy: "operator",
      reason: "out of window",
    },
  })
  let modelCalls = 0
  const events: Array<Record<string, unknown>> = []
  const result = await runTurn({
    workspace,
    positionId: "repo-owner",
    envelopeText: JSON.stringify(envelope),
    model: {
      async complete() {
        modelCalls += 1
        return { text: "never" }
      },
    },
    writeEvent: (line) => events.push(JSON.parse(line)),
    writeDiagnostic: () => undefined,
  })
  assert.equal(result.exitCode, 0)
  assert.equal(result.terminalEmitted, true)
  assert.equal(modelCalls, 0)
  const deniedIndex = events.findIndex(
    (event) => event.type === "approval.denied",
  )
  assert.ok(deniedIndex >= 0)
  assert.equal(events[deniedIndex]!.reason, "out of window")
  const terminal = events.find((event) => event.type === "run.failed")
  assert.ok(terminal)
  assert.ok(events.indexOf(terminal!) > deniedIndex)
  const error = terminal!.error as {
    code: string
    retryable: boolean
    terminalReason: string
  }
  assert.equal(error.code, "engine.approval_denied")
  assert.equal(error.retryable, false)
  assert.equal(error.terminalReason, "cancelled")
})

test("#193 AC-003: an expired verdict fails closed with exactly one trusted terminal", async () => {
  const workspace = await createWorkspace()
  const envelope = sealedEnvelope(workspace, {
    pendingApproval: {
      approvalId: "appr-expired-1",
      decision: "granted",
      decidedBy: "operator",
      expiresAt: "2020-01-01T00:00:00.000Z",
    },
  })
  let modelCalls = 0
  const events: Array<Record<string, unknown>> = []
  const result = await runTurn({
    workspace,
    positionId: "repo-owner",
    envelopeText: JSON.stringify(envelope),
    model: {
      async complete() {
        modelCalls += 1
        return { text: "never" }
      },
    },
    writeEvent: (line) => events.push(JSON.parse(line)),
    writeDiagnostic: () => undefined,
  })
  assert.equal(result.exitCode, 0)
  assert.equal(modelCalls, 0)
  const terminals = events.filter((event) => event.type === "run.failed")
  assert.equal(terminals.length, 1)
  const error = terminals[0]!.error as { code: string; retryable: boolean }
  assert.equal(error.code, "engine.approval_expired")
  assert.equal(error.retryable, false)
})

test("#193 AC-005: a malformed verdict rejects at the envelope boundary, exit 1", async () => {
  const workspace = await createWorkspace()
  const envelope = sealedEnvelope(workspace, {
    pendingApproval: {
      approvalId: "appr-bad-1",
      decision: "maybe",
      decidedBy: "operator",
    },
  })
  let modelCalls = 0
  const events: Array<Record<string, unknown>> = []
  const diagnostics: string[] = []
  const result = await runTurn({
    workspace,
    positionId: "repo-owner",
    envelopeText: JSON.stringify(envelope),
    model: {
      async complete() {
        modelCalls += 1
        return { text: "never" }
      },
    },
    writeEvent: (line) => events.push(JSON.parse(line)),
    writeDiagnostic: (line) => diagnostics.push(line),
  })
  assert.equal(result.exitCode, 1)
  assert.equal(result.terminalEmitted, false)
  assert.equal(events.length, 0)
  assert.equal(modelCalls, 0)
  assert.ok(
    diagnostics.some((line) => line.includes("engine.input_invalid")),
  )
})

test("#193 AC-004: an envelope without pendingApproval keeps current behavior", async () => {
  const workspace = await createWorkspace()
  const envelope = sealedEnvelope(workspace)
  const { result, events } = await execute(
    workspace,
    JSON.stringify(envelope),
    createDeterministicModelPort(["done without a verdict"]),
  )
  assert.equal(result.exitCode, 0)
  assert.ok(events.some((event) => event.type === "run.completed"))
  assert.ok(
    !events.some((event) =>
      String(event.type).startsWith("approval."),
    ),
    "no approval lifecycle events without a verdict field",
  )
})

test("#205 AC-002: conversationRef back-links every event of the turn", async () => {
  const workspace = await createWorkspace()
  const envelope = sealedEnvelope(workspace, {
    conversationRef: "conv-group-42",
  })
  const { result, events } = await execute(
    workspace,
    JSON.stringify(envelope),
    createDeterministicModelPort(["all issues summarized"]),
  )
  assert.equal(result.exitCode, 0)
  assert.ok(events.length > 0)
  for (const event of events) {
    assert.equal(
      event.conversationRef,
      "conv-group-42",
      `event ${String(event.type)} must echo the conversation back-link`,
    )
  }
  assert.ok(events.some((event) => event.type === "run.completed"))
})

test("#205 AC-001: legacy v1 and ref-less v1alpha2 events stay byte-exact", async () => {
  const workspace = await createWorkspace()
  const model = createDeterministicModelPort(["all issues summarized"])
  for (const schemaVersion of [
    TURN_ENVELOPE_V1_VERSION,
    TURN_ENVELOPE_VERSION,
  ]) {
    const envelope = sealedEnvelope(workspace, { schemaVersion })
    const { result, events } = await execute(
      workspace,
      JSON.stringify(envelope),
      model,
    )
    assert.equal(result.exitCode, 0)
    assert.ok(events.length > 0)
    for (const event of events) {
      assert.equal(
        "conversationRef" in event,
        false,
        `event ${String(event.type)} must not gain a key without the field`,
      )
    }
  }
})

test("#205 AC-003: a non-string conversationRef fails spawn before any event", async () => {
  const workspace = await createWorkspace()
  const envelope = sealedEnvelope(workspace, { conversationRef: 42 })
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
    diagnostics.some((line) => line.includes("engine.input_invalid")),
  )
})

test("AC-010: missing permissions artifact fails the turn before model consumption", async () => {
  const workspace = await createWorkspace()
  // Remove the permissions artifact: the next turn must fail closed before
  // any model consumption (#159 REQ-009).
  await rm(path.join(workspace, ".digital-employee", "permissions.json"))
  const envelope = sealedEnvelope(workspace)
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
    diagnostics.some((line) => line.includes("engine.permissions_invalid")),
  )
})
