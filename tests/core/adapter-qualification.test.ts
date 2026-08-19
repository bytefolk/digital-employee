import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  AGENT_HOST_CAPABILITIES,
  AGENT_HOST_PROTOCOL_VERSION,
  createUnknownAgentHostCapabilities,
} from "../../packages/core/src/agent-host.js"
import type {
  AgentHostAdapter,
  AgentHostEvent,
  AgentHostPolicy,
  AgentHostProbeResult,
  AgentHostRunRequest,
} from "../../packages/core/src/agent-host.js"
import { CoreError } from "../../packages/core/src/contracts.js"
import {
  AGENT_HOST_STDIO_PROTOCOL_VERSION,
  encodeAgentHostStdioLine,
  parseAgentHostStdioHostLine,
  parseAgentHostStdioRequest,
  probeResultFromStdioResponse,
} from "../../packages/core/src/agent-host-stdio.js"
import {
  ADAPTER_QUALIFICATION_KIT_VERSION,
  ADAPTER_QUALIFICATION_SCHEMA_ID,
  DEFAULT_QUALIFICATION_CASE_TIMEOUT_MS,
  MAX_QUALIFICATION_CASE_TIMEOUT_MS,
  MIN_QUALIFICATION_CASE_TIMEOUT_MS,
  QUALIFICATION_DOMAINS,
  QUALIFICATION_FILESYSTEM_DENIAL_CODE,
  QUALIFICATION_MCP_DENIAL_CODE,
  QUALIFICATION_NETWORK_DENIAL_CODE,
  canonicalPolicyDigest,
  runQualificationSuite,
  validateAdapterQualificationRecord,
} from "../../packages/core/src/adapter-qualification.js"
import type { AdapterQualificationRecord } from "../../packages/core/src/adapter-qualification.js"
import type { QualificationProcessTreeFixture } from "../../packages/core/src/adapter-qualification.js"

const GENERATED_AT = "2026-08-06T03:00:00Z"
const SENTINEL = "qualification-sentinel-do-not-leak"

function verifiedProbe(hostId = "fixture-host"): AgentHostProbeResult {
  const capabilities = createUnknownAgentHostCapabilities()
  capabilities.non_interactive_run = "supported"
  capabilities.event_stream = "supported"
  capabilities.tool_allowlist = "supported"
  capabilities.filesystem_scope = "supported"
  capabilities.network_policy = "supported"
  return {
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    hostId,
    displayName: "Fixture Host",
    status: "ready",
    available: true,
    adapterStatus: "runnable",
    version: "9.9.9",
    capabilities,
    capabilitySource: "conformance_test",
    issues: [],
  }
}

interface FixtureBehavior {
  eventAfterTerminal?: boolean
  disallowedTool?: boolean
  outputSchemaViolation?: boolean
  forwardBadOutputSchemaTerminal?: boolean
  acceptAsyncOutputSchema?: boolean
  flushBufferedOutput?: boolean
  echoMetadata?: boolean
  missingCapability?: boolean
  probeOnly?: boolean
  acceptHostileWrite?: boolean
  acceptNetworkDeny?: boolean
  acceptMcpDeny?: boolean
  failNetworkDenyAtRun?: boolean
  failMcpDenyAtRun?: boolean
  genericNetworkDeny?: boolean
  genericMcpDeny?: boolean
  wrongNetworkDenyAtRun?: boolean
  wrongMcpDenyAtRun?: boolean
  omitNetworkDenyAttempt?: boolean
  omitMcpDenyAttempt?: boolean
  cancelCompletes?: boolean
  eventAfterCancel?: boolean
  hangEventStream?: boolean
  capabilitySource?: unknown
  hostVersion?: string
  lifecycle?: string[]
}

function qualificationOperation(request: AgentHostRunRequest): string {
  const driver = request.metadata?.adapterQualification
  if (!driver || typeof driver !== "object" || Array.isArray(driver)) return ""
  const operation = (driver as Record<string, unknown>).operation
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    return ""
  }
  return String((operation as Record<string, unknown>).kind ?? "")
}

function qualificationScenario(request: AgentHostRunRequest): string {
  const driver = request.metadata?.adapterQualification
  if (!driver || typeof driver !== "object" || Array.isArray(driver)) return ""
  const operation = (driver as Record<string, unknown>).operation
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    return ""
  }
  return String((operation as Record<string, unknown>).scenario ?? "")
}

function qualificationAdapter(
  behavior: FixtureBehavior = {},
): AgentHostAdapter {
  const cancelled = new Set<string>()
  const cancelWaiters = new Map<string, () => void>()
  return {
    hostId: "fixture-host",
    async probe() {
      const probe = verifiedProbe()
      if (behavior.missingCapability) {
        probe.capabilities = Object.fromEntries(
          Object.entries(probe.capabilities).filter(
            ([key]) => key !== "tool_allowlist",
          ),
        ) as typeof probe.capabilities
      }
      if (behavior.probeOnly) {
        probe.adapterStatus = "probe_only"
      }
      if (behavior.capabilitySource !== undefined) {
        ;(probe as unknown as Record<string, unknown>).capabilitySource =
          behavior.capabilitySource
      }
      if (behavior.hostVersion !== undefined) probe.version = behavior.hostVersion
      return probe
    },
    async preflight(request: AgentHostRunRequest) {
      const operation = qualificationOperation(request)
      if (operation === "filesystem.write" && !behavior.acceptHostileWrite) {
        throw new CoreError(
          QUALIFICATION_FILESYSTEM_DENIAL_CODE,
          "filesystem operation denied by policy",
          { status: 403, retryable: false },
        )
      }
      if (!behavior.acceptHostileWrite && request.policy.filesystem.write.length > 0) {
        throw new Error("write outside filesystem scope")
      }
      if (
        operation === "network.connect" &&
        !behavior.acceptNetworkDeny &&
        !behavior.failNetworkDenyAtRun &&
        !behavior.wrongNetworkDenyAtRun &&
        !behavior.omitNetworkDenyAttempt
      ) {
        if (behavior.genericNetworkDeny) throw new Error("network denied")
        throw new CoreError(
          QUALIFICATION_NETWORK_DENIAL_CODE,
          "network operation denied by policy",
          { status: 403, retryable: false },
        )
      }
      if (
        operation === "mcp.invoke" &&
        !behavior.acceptMcpDeny &&
        !behavior.failMcpDenyAtRun &&
        !behavior.wrongMcpDenyAtRun &&
        !behavior.omitMcpDenyAttempt
      ) {
        if (behavior.genericMcpDeny) throw new Error("undeclared MCP denied")
        throw new CoreError(
          QUALIFICATION_MCP_DENIAL_CODE,
          "MCP operation denied by policy",
          { status: 403, retryable: false },
        )
      }
      return verifiedProbe()
    },
    async *run(request) {
      behavior.lifecycle?.push(`run:${request.runId}`)
      const operation = qualificationOperation(request)
      if (
        (operation === "network.connect" && behavior.omitNetworkDenyAttempt) ||
        (operation === "mcp.invoke" && behavior.omitMcpDenyAttempt)
      ) {
        return
      }
      const at = "2026-08-06T03:00:00.000Z"
      if (
        request.runId ===
          "qualification-output_schema_invalid_schema_preflight" &&
        !behavior.acceptAsyncOutputSchema
      ) {
        // A conformant adapter rejects an asynchronous Schema before any run
        // starts; no run.started may ever be emitted for this vector.
        yield {
          type: "run.failed",
          runId: request.runId,
          timestamp: at,
          error: {
            code: "fixture_output_schema_invalid",
            message: "asynchronous output schema rejected before run",
            retryable: false,
          },
        }
        return
      }
      const started: AgentHostEvent = {
        type: "run.started",
        runId: request.runId,
        timestamp: at,
      }
      yield started
      if (
        (operation === "network.connect" &&
          (behavior.failNetworkDenyAtRun ||
            behavior.wrongNetworkDenyAtRun)) ||
        (operation === "mcp.invoke" &&
          (behavior.failMcpDenyAtRun || behavior.wrongMcpDenyAtRun))
      ) {
        yield {
          type: "run.failed",
          runId: request.runId,
          timestamp: at,
          error: {
            code:
              behavior.wrongNetworkDenyAtRun || behavior.wrongMcpDenyAtRun
                ? "unrelated_failure"
                : operation === "network.connect"
                ? QUALIFICATION_NETWORK_DENIAL_CODE
                : QUALIFICATION_MCP_DENIAL_CODE,
            message: "direct qualification attempt denied",
            retryable: false,
          },
        }
        return
      }
      if (operation === "output_schema.buffer_until_cancel") {
        // Buffer partial output and never flush it; only the cancel produces
        // the terminal for this run.
        yield {
          type: "assistant.delta",
          runId: request.runId,
          timestamp: at,
          text: '{"answer":"partial',
        }
        await new Promise<void>((resolve) => {
          cancelWaiters.set(request.runId, resolve)
          if (cancelled.has(request.runId)) resolve()
        })
        if (behavior.flushBufferedOutput) {
          yield {
            type: "run.completed",
            runId: request.runId,
            timestamp: at,
            output: { answer: "flushed" },
          }
          return
        }
        yield {
          type: "run.failed",
          runId: request.runId,
          timestamp: at,
          error: {
            code: "agent_host_cancelled",
            message: "run cancelled",
            retryable: false,
          },
        }
        return
      }
      if (operation === "output_schema.emit") {
        if (behavior.forwardBadOutputSchemaTerminal) {
          const scenario = qualificationScenario(request)
          const output =
            scenario === "non_json"
              ? "this terminal output is prose, not json"
              : scenario === "schema_mismatch"
                ? { wrong_field: "mismatched" }
                : { answer: "ok", leaked: SENTINEL }
          yield {
            type: "run.completed",
            runId: request.runId,
            timestamp: at,
            output,
          }
          return
        }
        yield {
          type: "run.failed",
          runId: request.runId,
          timestamp: at,
          error: {
            code: "fixture_output_schema_rejected",
            message: "hostile terminal output rejected against schema",
            retryable: false,
          },
        }
        return
      }
      if (
        behavior.hangEventStream &&
        request.runId === "qualification-event_stream"
      ) {
        await new Promise<void>((resolve) => {
          cancelWaiters.set(request.runId, resolve)
          if (cancelled.has(request.runId)) resolve()
        })
        return
      }
      if (
        operation === "lifecycle.wait_for_cancel" ||
        (operation === "process_tree" &&
          request.runId !== "qualification-process_tree_normal")
      ) {
        if (behavior.cancelCompletes) {
          yield {
            type: "run.completed",
            runId: request.runId,
            timestamp: at,
            output: { status: "completed-before-cancel" },
          }
          return
        }
        await new Promise<void>((resolve) => {
          cancelWaiters.set(request.runId, resolve)
          if (cancelled.has(request.runId)) resolve()
        })
        yield {
          type: "run.failed",
          runId: request.runId,
          timestamp: at,
          error: {
            code: "agent_host_cancelled",
            message: "run cancelled",
            retryable: false,
          },
        }
        if (behavior.eventAfterCancel) {
          yield {
            type: "usage",
            runId: request.runId,
            timestamp: at,
            totalTokens: 1,
          }
        }
        return
      }
      if (behavior.echoMetadata) {
        yield {
          type: "assistant.delta",
          runId: request.runId,
          timestamp: at,
          text: JSON.stringify(request.metadata ?? {}),
        }
      }
      if (behavior.disallowedTool) {
        yield {
          type: "tool.started",
          runId: request.runId,
          timestamp: at,
          toolCallId: "call-1",
          toolName: "shell",
        }
      } else if (request.runId === "qualification-tool_enforcement") {
        yield {
          type: "tool.started",
          runId: request.runId,
          timestamp: at,
          toolCallId: "call-1",
          toolName: "noop",
        }
      }
      const schemaCase =
        request.runId === "qualification-output_schema" ||
        request.runId === "qualification-output_schema_valid_json"
      const output =
        schemaCase && !behavior.outputSchemaViolation
          ? { answer: "qualified" }
          : { status: "answered", answer: "fixture", citations: [] }
      yield {
        type: "run.completed",
        runId: request.runId,
        timestamp: at,
        output,
      }
      if (behavior.eventAfterTerminal) {
        yield {
          type: "usage",
          runId: request.runId,
          timestamp: at,
          totalTokens: 1,
        }
      }
    },
    async cancel(runId) {
      behavior.lifecycle?.push(`cancel:${runId}`)
      cancelled.add(runId)
      cancelWaiters.get(runId)?.()
    },
    async qualificationIdentity() {
      return {
        configurationDigest: createHash("sha256")
          .update("fixture-host/default-config")
          .digest("hex"),
        ownerPid: process.pid,
      }
    },
  }
}

async function workingDirectory(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "adapter-qualification-"))
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

async function waitForPidsGone(
  pids: readonly number[],
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (pids.some(pidAlive) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
}

async function terminateFixtureTree(
  child: ChildProcess,
  grandchildPid?: number,
): Promise<void> {
  const pids = [child.pid, grandchildPid].filter(
    (pid): pid is number => pid !== undefined,
  )
  const signal = (name: NodeJS.Signals): void => {
    if (process.platform !== "win32" && child.pid !== undefined) {
      try {
        process.kill(-child.pid, name)
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
      }
    }
    for (const pid of pids) {
      if (!pidAlive(pid)) continue
      try {
        process.kill(pid, name)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
      }
    }
  }
  signal("SIGTERM")
  await waitForPidsGone(pids)
  if (pids.some(pidAlive)) {
    signal("SIGKILL")
    await waitForPidsGone(pids)
  }
  child.stdout?.destroy()
  child.unref()
}

function realProcessTreeFixture(
  adapter: AgentHostAdapter,
  observed: Array<{ childPid: number; grandchildPid: number }> = [],
): QualificationProcessTreeFixture {
  return {
    async create() {
      // These helpers are intentionally terminated, so they must not leave a
      // half-written V8 coverage artifact in the parent test run.
      const {
        NODE_V8_COVERAGE: _testRunnerCoverageDirectory,
        ...fixtureEnvironment
      } = process.env
      const child = spawn(
        process.execPath,
        [
          "-e",
          [
            'const { spawn } = require("node:child_process")',
            'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })',
            'process.stdout.write(String(grandchild.pid) + "\\n")',
            "setInterval(() => {}, 1000)",
          ].join(";"),
        ],
        {
          detached: false,
          env: fixtureEnvironment,
          stdio: ["ignore", "pipe", "ignore"],
        },
      )
      assert.ok(child.pid)
      let handshakeTimer: ReturnType<typeof setTimeout> | undefined
      let grandchildPid: number
      try {
        grandchildPid = await new Promise<number>((resolve, reject) => {
          let carry = ""
          handshakeTimer = setTimeout(
            () => reject(new Error("grandchild pid fixture timed out")),
            5_000,
          )
          child.stdout?.on("data", (chunk: Buffer) => {
            carry += chunk.toString("utf8")
            const newline = carry.indexOf("\n")
            if (newline === -1) return
            resolve(Number(carry.slice(0, newline)))
          })
          child.once("error", reject)
        })
      } catch (error) {
        await terminateFixtureTree(child)
        throw error
      } finally {
        if (handshakeTimer !== undefined) clearTimeout(handshakeTimer)
      }
      child.stdout?.destroy()
      child.unref()
      const descendants = { childPid: child.pid, grandchildPid }
      observed.push(descendants)
      let disposePromise: Promise<void> | undefined
      return {
        adapter,
        async descendants() {
          return descendants
        },
        dispose() {
          disposePromise ??= terminateFixtureTree(child, grandchildPid)
          return disposePromise
        },
      }
    },
  }
}

function unrelatedProcessFixture(
  adapter: AgentHostAdapter,
  observed: Array<{ childPid: number; grandchildPid: number }> = [],
): QualificationProcessTreeFixture {
  return {
    async create() {
      const { NODE_V8_COVERAGE: _coverageDirectory, ...fixtureEnvironment } =
        process.env
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { detached: false, env: fixtureEnvironment, stdio: "ignore" },
      )
      const unrelated = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { detached: false, env: fixtureEnvironment, stdio: "ignore" },
      )
      assert.ok(child.pid)
      assert.ok(unrelated.pid)
      const descendants = {
        childPid: child.pid,
        grandchildPid: unrelated.pid,
      }
      observed.push(descendants)
      let disposePromise: Promise<void> | undefined
      return {
        adapter,
        async descendants() {
          return descendants
        },
        dispose() {
          disposePromise ??= terminateFixtureTree(child, unrelated.pid)
          return disposePromise
        },
      }
    },
  }
}

function rogueIntermediaryProcessFixture(
  adapter: AgentHostAdapter,
  observed: Array<{
    intermediaryPid: number
    childPid: number
    grandchildPid: number
  }> = [],
): QualificationProcessTreeFixture {
  return {
    async create() {
      const { NODE_V8_COVERAGE: _coverageDirectory, ...fixtureEnvironment } =
        process.env
      const grandchildProgram = "setInterval(() => {}, 1000)"
      const childProgram = [
        'const { spawn } = require("node:child_process")',
        `const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildProgram)}], { stdio: "ignore" })`,
        'process.stdout.write(String(grandchild.pid) + "\\n")',
        "setInterval(() => {}, 1000)",
      ].join(";")
      const intermediaryProgram = [
        'const { spawn } = require("node:child_process")',
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(childProgram)}], { stdio: ["ignore", "pipe", "ignore"] })`,
        'child.stdout.once("data", (chunk) => process.stdout.write(String(child.pid) + " " + chunk))',
        "setInterval(() => {}, 1000)",
      ].join(";")
      const intermediary = spawn(
        process.execPath,
        ["-e", intermediaryProgram],
        {
          detached: false,
          env: fixtureEnvironment,
          stdio: ["ignore", "pipe", "ignore"],
        },
      )
      assert.ok(intermediary.pid)
      let handshakeTimer: ReturnType<typeof setTimeout> | undefined
      let childPid: number
      let grandchildPid: number
      try {
        ;({ childPid, grandchildPid } = await new Promise<{
          childPid: number
          grandchildPid: number
        }>((resolve, reject) => {
          let carry = ""
          handshakeTimer = setTimeout(
            () => reject(new Error("rogue intermediary fixture timed out")),
            5_000,
          )
          intermediary.stdout?.on("data", (chunk: Buffer) => {
            carry += chunk.toString("utf8")
            const match = carry.match(/^(\d+)\s+(\d+)\n/)
            if (!match) return
            resolve({ childPid: Number(match[1]), grandchildPid: Number(match[2]) })
          })
          intermediary.once("error", reject)
        }))
      } catch (error) {
        await terminateFixtureTree(intermediary)
        throw error
      } finally {
        if (handshakeTimer !== undefined) clearTimeout(handshakeTimer)
      }
      intermediary.stdout?.destroy()
      intermediary.unref()
      const descendants = { childPid, grandchildPid }
      observed.push({
        intermediaryPid: intermediary.pid,
        ...descendants,
      })
      let disposePromise: Promise<void> | undefined
      return {
        adapter,
        async descendants() {
          return descendants
        },
        dispose() {
          disposePromise ??= (async () => {
            for (const pid of [grandchildPid, childPid]) {
              if (!pidAlive(pid)) continue
              try {
                process.kill(pid, "SIGTERM")
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
              }
            }
            await waitForPidsGone([childPid, grandchildPid])
            for (const pid of [grandchildPid, childPid]) {
              if (!pidAlive(pid)) continue
              try {
                process.kill(pid, "SIGKILL")
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
              }
            }
            await waitForPidsGone([childPid, grandchildPid])
            await terminateFixtureTree(intermediary)
          })()
          return disposePromise
        },
      }
    },
  }
}

test("a conforming built-in-class adapter earns the fixture axis without live evidence", async () => {
  const directory = await workingDirectory()
  const observed: Array<{ childPid: number; grandchildPid: number }> = []
  const adapter = qualificationAdapter()
  const record = await runQualificationSuite(adapter, {
    workingDirectory: directory,
    generatedAt: GENERATED_AT,
    caseTimeoutMs: 10_000,
    processTreeFixture: realProcessTreeFixture(
      adapter,
      observed,
    ),
  })

  assert.equal(record.schema, ADAPTER_QUALIFICATION_SCHEMA_ID)
  assert.equal(record.kitVersion, ADAPTER_QUALIFICATION_KIT_VERSION)
  assert.equal(record.hostId, "fixture-host")
  assert.equal(record.hostVersion, "9.9.9")
  assert.deepEqual(record.axes, {
    implemented: true,
    fixtureConformant: true,
    liveQualified: false,
  }, JSON.stringify(record.cases.filter((entry) => !entry.passed)))
  assert.equal(record.liveEvidence, undefined)
  assert.equal(record.cases.length, 18)
  assert.ok(record.cases.every((entry) => entry.passed))
  for (const vector of [
    "valid_json",
    "non_json",
    "schema_mismatch",
    "invalid_schema_preflight",
    "cancel_buffered",
    "secret_rejected",
  ]) {
    assert.deepEqual(
      record.cases.find((entry) => entry.id === vector),
      {
        domain: "output_schema",
        id: vector,
        passed: true,
        code: `${vector}_ok`,
      },
      vector,
    )
  }
  for (const domain of QUALIFICATION_DOMAINS) {
    assert.equal(record.domains[domain].failed, 0, domain)
  }
  assert.equal(observed.length, 3)
  assert.ok(
    observed.every(
      ({ childPid, grandchildPid }) =>
        !pidAlive(childPid) && !pidAlive(grandchildPid),
    ),
  )
  assert.equal(
    record.policyDigest,
    createHash("sha256")
      .update(
        '{"approval":{"mode":"never"},"filesystem":{"read":["."],"write":[]},"maxTurns":4,"network":{"mode":"deny"},"tools":{"allow":[{"mode":"read","name":"noop"}],"default":"deny"}}',
      )
      .digest("hex"),
  )
})

test("qualification cases use the frozen bounded timeout range", async () => {
  assert.equal(DEFAULT_QUALIFICATION_CASE_TIMEOUT_MS, 30_000)
  assert.equal(MIN_QUALIFICATION_CASE_TIMEOUT_MS, 1_000)
  assert.equal(MAX_QUALIFICATION_CASE_TIMEOUT_MS, 600_000)
  const directory = await workingDirectory()
  for (const caseTimeoutMs of [999, 600_001, 1_000.5, Number.NaN]) {
    await assert.rejects(
      () =>
        runQualificationSuite(qualificationAdapter(), {
          workingDirectory: directory,
          generatedAt: GENERATED_AT,
          caseTimeoutMs,
        }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "INVALID_QUALIFICATION_CASE_TIMEOUT",
    )
  }
})

test("a hung case times out with a stable result and the suite continues", async () => {
  const directory = await workingDirectory()
  const startedAt = Date.now()
  const record = await runQualificationSuite(
    qualificationAdapter({ hangEventStream: true }),
    {
      workingDirectory: directory,
      generatedAt: GENERATED_AT,
      caseTimeoutMs: 1_000,
    },
  )
  assert.ok(Date.now() - startedAt < 4_000)
  const eventCases = record.cases.filter(
    (entry) =>
      entry.id === "events_well_formed" ||
      entry.id === "exactly_one_terminal",
  )
  assert.equal(eventCases.length, 2)
  assert.ok(
    eventCases.every(
      (entry) => !entry.passed && entry.code === "qualification_case_timeout",
    ),
  )
  assert.ok(
    record.cases.some(
      (entry) => entry.id === "valid_json" && entry.passed,
    ),
  )
})

test("deadline cancellation starts the run before cancelling and requires one failed terminal", async () => {
  const directory = await workingDirectory()
  const lifecycle: string[] = []
  const record = await runQualificationSuite(
    qualificationAdapter({ lifecycle }),
    { workingDirectory: directory, generatedAt: GENERATED_AT },
  )
  assert.deepEqual(
    lifecycle.filter((entry) => entry.includes("qualification-cancel")),
    ["run:qualification-cancel", "cancel:qualification-cancel"],
  )
  const cancelCase = record.cases.find(
    (entry) => entry.id === "cancel_stops_active_run",
  )
  assert.deepEqual(cancelCase, {
    domain: "deadline_cancel",
    id: "cancel_stops_active_run",
    passed: true,
    code: "cancel_stops_active_run_ok",
  })

  const completed = await runQualificationSuite(
    qualificationAdapter({ cancelCompletes: true }),
    { workingDirectory: directory, generatedAt: GENERATED_AT },
  )
  assert.equal(
    completed.cases.find((entry) => entry.id === "cancel_stops_active_run")
      ?.code,
    "cancel_completed_terminal",
  )
  const lateEvent = await runQualificationSuite(
    qualificationAdapter({ eventAfterCancel: true }),
    { workingDirectory: directory, generatedAt: GENERATED_AT },
  )
  assert.equal(
    lateEvent.cases.find((entry) => entry.id === "cancel_stops_active_run")
      ?.code,
    "cancel_event_after_terminal",
  )
})

test("cleanup fails closed without real child and grandchild evidence", async () => {
  const directory = await workingDirectory()
  const record = await runQualificationSuite(qualificationAdapter(), {
    workingDirectory: directory,
    generatedAt: GENERATED_AT,
  })
  const cleanup = record.cases.filter(
    (entry) => entry.domain === "process_tree_cleanup",
  )
  assert.deepEqual(
    cleanup.map((entry) => entry.id),
    [
      "descendants_disposed_normal",
      "descendants_disposed_timeout",
      "descendants_disposed_cancel",
    ],
  )
  assert.ok(
    cleanup.every(
      (entry) =>
        !entry.passed && entry.code === "process_tree_fixture_unavailable",
    ),
  )
  assert.equal(record.axes.fixtureConformant, false)
})

test("process evidence rejects substitute adapters, drifted configuration and unrelated pids", async () => {
  const directory = await workingDirectory()

  const outer = qualificationAdapter()
  const substituteObserved: Array<{ childPid: number; grandchildPid: number }> = []
  const substitute = await runQualificationSuite(outer, {
    workingDirectory: directory,
    generatedAt: GENERATED_AT,
    caseTimeoutMs: 10_000,
    processTreeFixture: realProcessTreeFixture(
      qualificationAdapter(),
      substituteObserved,
    ),
  })
  assert.ok(
    substitute.cases
      .filter((entry) => entry.domain === "process_tree_cleanup")
      .every(
        (entry) =>
          !entry.passed && entry.code === "process_tree_adapter_mismatch",
      ),
  )
  assert.ok(
    substituteObserved.every(
      ({ childPid, grandchildPid }) =>
        !pidAlive(childPid) && !pidAlive(grandchildPid),
    ),
  )

  const drifted = qualificationAdapter()
  let identityCalls = 0
  drifted.qualificationIdentity = async () => {
    identityCalls += 1
    return {
      configurationDigest: createHash("sha256")
        .update(identityCalls === 1 ? "bound-config" : "drifted-config")
        .digest("hex"),
      ownerPid: process.pid,
    }
  }
  const driftedRecord = await runQualificationSuite(drifted, {
    workingDirectory: directory,
    generatedAt: GENERATED_AT,
    caseTimeoutMs: 10_000,
    processTreeFixture: realProcessTreeFixture(drifted),
  })
  assert.ok(
    driftedRecord.cases
      .filter((entry) => entry.domain === "process_tree_cleanup")
      .every(
        (entry) =>
          !entry.passed && entry.code === "process_tree_binding_mismatch",
      ),
  )

  const lineageAdapter = qualificationAdapter()
  const unrelatedRecord = await runQualificationSuite(lineageAdapter, {
    workingDirectory: directory,
    generatedAt: GENERATED_AT,
    caseTimeoutMs: 10_000,
    processTreeFixture: unrelatedProcessFixture(lineageAdapter),
  })
  assert.ok(
    unrelatedRecord.cases
      .filter((entry) => entry.domain === "process_tree_cleanup")
      .every(
        (entry) =>
          !entry.passed && entry.code === "process_tree_lineage_unverified",
      ),
  )
})

test("process evidence rejects a same-identity tree hidden behind a rogue intermediary", async () => {
  const directory = await workingDirectory()
  const adapter = qualificationAdapter()
  const observed: Array<{
    intermediaryPid: number
    childPid: number
    grandchildPid: number
  }> = []
  const record = await runQualificationSuite(adapter, {
    workingDirectory: directory,
    generatedAt: GENERATED_AT,
    caseTimeoutMs: 10_000,
    processTreeFixture: rogueIntermediaryProcessFixture(adapter, observed),
  })
  assert.ok(
    record.cases
      .filter((entry) => entry.domain === "process_tree_cleanup")
      .every(
        (entry) =>
          !entry.passed && entry.code === "process_tree_lineage_unverified",
      ),
    JSON.stringify(record.cases.filter((entry) => entry.domain === "process_tree_cleanup")),
  )
  assert.equal(observed.length, 3)
  assert.ok(
    observed.every(
      ({ intermediaryPid, childPid, grandchildPid }) =>
        !pidAlive(intermediaryPid) &&
        !pidAlive(childPid) &&
        !pidAlive(grandchildPid),
    ),
  )
})

test("network and undeclared MCP deny paths must be exercised directly", async () => {
  const directory = await workingDirectory()
  const acceptedNetwork = await runQualificationSuite(
    qualificationAdapter({ acceptNetworkDeny: true }),
    { workingDirectory: directory, generatedAt: GENERATED_AT },
  )
  assert.equal(
    acceptedNetwork.cases.find((entry) => entry.id === "network_deny_refused")
      ?.code,
    "network_deny_accepted",
  )
  const acceptedMcp = await runQualificationSuite(
    qualificationAdapter({ acceptMcpDeny: true }),
    { workingDirectory: directory, generatedAt: GENERATED_AT },
  )
  assert.equal(
    acceptedMcp.cases.find((entry) => entry.id === "mcp_deny_refused")?.code,
    "mcp_deny_accepted",
  )
  const failedAtRun = await runQualificationSuite(
    qualificationAdapter({
      failNetworkDenyAtRun: true,
      failMcpDenyAtRun: true,
    }),
    { workingDirectory: directory, generatedAt: GENERATED_AT },
  )
  for (const id of ["network_deny_refused", "mcp_deny_refused"]) {
    assert.equal(
      failedAtRun.cases.find((entry) => entry.id === id)?.passed,
      true,
      id,
    )
  }
})

test("generic preflight failures are not accepted as direct policy-denial evidence", async () => {
  const directory = await workingDirectory()
  const record = await runQualificationSuite(
    qualificationAdapter({
      genericNetworkDeny: true,
      genericMcpDeny: true,
    }), {
    workingDirectory: directory,
    generatedAt: GENERATED_AT,
  })
  for (const id of ["network_deny_refused", "mcp_deny_refused"]) {
    const result = record.cases.find((entry) => entry.id === id)
    assert.equal(result?.passed, false, id)
    assert.match(result?.code ?? "", /policy_evidence_invalid$/)
  }
})

test("a generic hostile-write preflight failure is not typed policy-denial evidence", async () => {
  const directory = await workingDirectory()
  const adapter = qualificationAdapter()
  const originalPreflight = adapter.preflight.bind(adapter)
  let observedOperation = ""
  adapter.preflight = async (request) => {
    const operation = qualificationOperation(request)
    if (
      operation === "filesystem.write" ||
      request.policy.filesystem.write.length > 0
    ) {
      observedOperation = operation
      throw new Error("database unavailable")
    }
    return await originalPreflight(request)
  }
  const record = await runQualificationSuite(adapter, {
    workingDirectory: directory,
    generatedAt: GENERATED_AT,
  })
  const result = record.cases.find(
    (entry) => entry.id === "hostile_write_refused",
  )
  assert.equal(observedOperation, "filesystem.write")
  assert.equal(result?.passed, false)
  assert.equal(result?.code, "filesystem_deny_policy_evidence_invalid")
})

test("unrelated failed terminals and no-attempt streams are not policy evidence", async () => {
  const directory = await workingDirectory()
  for (const behavior of [
    { wrongNetworkDenyAtRun: true, wrongMcpDenyAtRun: true },
    { omitNetworkDenyAttempt: true, omitMcpDenyAttempt: true },
  ]) {
    const record = await runQualificationSuite(qualificationAdapter(behavior), {
      workingDirectory: directory,
      generatedAt: GENERATED_AT,
    })
    for (const id of ["network_deny_refused", "mcp_deny_refused"]) {
      const result = record.cases.find((entry) => entry.id === id)
      assert.equal(result?.passed, false, `${id}: ${JSON.stringify(behavior)}`)
      assert.match(result?.code ?? "", /policy_evidence_invalid$/)
    }
  }
})

test("each case awaits cancel and iterator return before starting the next case", async () => {
  const directory = await workingDirectory()
  const lifecycle: string[] = []
  const adapter = qualificationAdapter({ lifecycle })
  const normalRun = adapter.run.bind(adapter)
  adapter.run = (request) => {
    if (request.runId !== "qualification-event_stream") {
      lifecycle.push(`next:${request.runId}`)
      return normalRun(request)
    }
    let index = 0
    const events: AgentHostEvent[] = [
      {
        type: "run.started",
        runId: request.runId,
        timestamp: GENERATED_AT,
      },
      {
        type: "run.completed",
        runId: request.runId,
        timestamp: GENERATED_AT,
        output: { status: "done" },
      },
    ]
    const iterator: AsyncIterator<AgentHostEvent> &
      AsyncIterable<AgentHostEvent> = {
      [Symbol.asyncIterator]() {
        return this
      },
      async next() {
        const value = events[index]
        index += 1
        return value === undefined
          ? { done: true, value: undefined }
          : { done: false, value }
      },
      async return() {
        await new Promise<void>((resolve) => setTimeout(resolve, 25))
        lifecycle.push("return:settled")
        throw new Error(`late cleanup ${SENTINEL}`)
      },
    }
    return iterator
  }

  const record = await runQualificationSuite(adapter, {
    workingDirectory: directory,
    generatedAt: GENERATED_AT,
  })
  const cancelIndex = lifecycle.indexOf("cancel:qualification-event_stream")
  const returnIndex = lifecycle.indexOf("return:settled")
  const nextIndex = lifecycle.findIndex((entry) =>
    entry.startsWith("next:qualification-cancel"),
  )
  assert.ok(cancelIndex !== -1 && cancelIndex < returnIndex)
  assert.ok(returnIndex !== -1 && returnIndex < nextIndex)
  assert.equal(
    record.cases.find((entry) => entry.id === "no_metadata_echo")?.code,
    "metadata_secret_echoed",
  )
})

test("process fixture disposal settles before the following qualification case", async () => {
  const directory = await workingDirectory()
  const lifecycle: string[] = []
  const adapter = qualificationAdapter({ lifecycle })
  const baseFixture = realProcessTreeFixture(adapter)
  const fixture: QualificationProcessTreeFixture = {
    async create(scenario) {
      const instance = await baseFixture.create(scenario)
      return {
        ...instance,
        async dispose() {
          await instance.dispose()
          await new Promise<void>((resolve) => setTimeout(resolve, 20))
          lifecycle.push(`dispose:settled:${scenario}`)
        },
      }
    },
  }
  await runQualificationSuite(adapter, {
    workingDirectory: directory,
    generatedAt: GENERATED_AT,
    caseTimeoutMs: 10_000,
    processTreeFixture: fixture,
  })
  for (const [scenario, followingRun] of [
    ["normal", "qualification-process_tree_timeout"],
    ["timeout", "qualification-process_tree_cancel"],
    ["cancel", "qualification-credential"],
  ] as const) {
    const disposed = lifecycle.indexOf(`dispose:settled:${scenario}`)
    const following = lifecycle.indexOf(`run:${followingRun}`)
    assert.ok(disposed !== -1 && disposed < following, scenario)
  }
})

test("an uncooperative teardown aborts the suite with a stable bounded error", async () => {
  const directory = await workingDirectory()
  const adapter = qualificationAdapter({ hangEventStream: true })
  adapter.cancel = async (runId) => {
    if (runId === "qualification-event_stream") {
      await new Promise<void>(() => {})
    }
  }
  const startedAt = Date.now()
  await assert.rejects(
    () =>
      runQualificationSuite(adapter, {
        workingDirectory: directory,
        generatedAt: GENERATED_AT,
        caseTimeoutMs: 1_000,
      }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "QUALIFICATION_CLEANUP_TIMEOUT",
  )
  assert.ok(Date.now() - startedAt < 3_500)
})

test("an outer process-case timeout cancels the exact fixture owner and disposes descendants", async () => {
  const directory = await workingDirectory()
  const lifecycle: string[] = []
  const adapter = qualificationAdapter({ lifecycle })
  const observed: Array<{ childPid: number; grandchildPid: number }> = []
  const baseFixture = realProcessTreeFixture(adapter, observed)
  const fixture: QualificationProcessTreeFixture = {
    async create(scenario) {
      const instance = await baseFixture.create(scenario)
      return scenario === "normal"
        ? {
            ...instance,
            async descendants() {
              await new Promise<void>(() => {})
              return await instance.descendants()
            },
          }
        : instance
    },
  }
  await assert.rejects(
    () =>
      runQualificationSuite(adapter, {
        workingDirectory: directory,
        generatedAt: GENERATED_AT,
        caseTimeoutMs: 1_000,
        processTreeFixture: fixture,
      }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "QUALIFICATION_CLEANUP_TIMEOUT",
  )
  assert.ok(lifecycle.includes("cancel:qualification-process_tree_normal"))
  assert.ok(
    observed.every(
      ({ childPid, grandchildPid }) =>
        !pidAlive(childPid) && !pidAlive(grandchildPid),
    ),
  )
})

test("emergency cleanup claims runs and cleanups registered after its initial drain", async () => {
  const directory = await workingDirectory()
  const lifecycle: string[] = []
  const adapter = qualificationAdapter({ lifecycle })
  const originalProbe = adapter.probe.bind(adapter)
  const originalRun = adapter.run.bind(adapter)
  let delayProcessProbe = false
  let primaryCleanupStarted = 0
  let lateIteratorCleanup = 0

  adapter.probe = async () => {
    if (delayProcessProbe) {
      delayProcessProbe = false
      await new Promise<void>((resolve) => setTimeout(resolve, 2_500))
    }
    return await originalProbe()
  }
  adapter.run = (request) => {
    const source = originalRun(request)
    if (request.runId !== "qualification-process_tree_normal") return source
    return {
      [Symbol.asyncIterator]() {
        const iterator = source[Symbol.asyncIterator]()
        return {
          next: () => iterator.next(),
          return: async () => {
            lateIteratorCleanup += 1
            return iterator.return
              ? await iterator.return()
              : { done: true as const, value: undefined }
          },
        }
      },
    }
  }

  const fixture: QualificationProcessTreeFixture = {
    async create() {
      delayProcessProbe = true
      return {
        adapter,
        async descendants() {
          return { childPid: process.pid + 1, grandchildPid: process.pid + 2 }
        },
        async dispose() {
          primaryCleanupStarted += 1
          await new Promise<void>(() => {})
        },
      }
    },
  }
  const startedAt = Date.now()
  await assert.rejects(
    () =>
      runQualificationSuite(adapter, {
        workingDirectory: directory,
        generatedAt: GENERATED_AT,
        caseTimeoutMs: 1_000,
        processTreeFixture: fixture,
      }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "QUALIFICATION_CLEANUP_TIMEOUT",
  )
  assert.equal(primaryCleanupStarted, 1)
  assert.equal(
    lifecycle.filter(
      (entry) => entry === "cancel:qualification-process_tree_normal",
    ).length,
    1,
  )
  assert.equal(lateIteratorCleanup, 1)
  assert.ok(Date.now() - startedAt < 3_500)
})

test("sentinel scanning covers conforming, malformed, rejected and thrown paths", async () => {
  const directory = await workingDirectory()
  const makeAdapter = (
    mode: "conforming" | "malformed" | "rejected" | "thrown",
  ): AgentHostAdapter => {
    const adapter = qualificationAdapter()
    if (mode === "conforming") return adapter
    const run = adapter.run.bind(adapter)
    adapter.run = (request) => {
      if (request.runId !== "qualification-credential") return run(request)
      if (mode === "thrown") throw new Error(`thrown ${SENTINEL}`)
      if (mode === "rejected") {
        return {
          [Symbol.asyncIterator]() {
            return {
              next: async () => {
                throw new Error(`rejected ${SENTINEL}`)
              },
            }
          },
        }
      }
      return (async function* () {
        yield {
          type: "malformed",
          secret: SENTINEL,
        } as unknown as AgentHostEvent
      })()
    }
    return adapter
  }

  for (const mode of [
    "conforming",
    "malformed",
    "rejected",
    "thrown",
  ] as const) {
    const record = await runQualificationSuite(makeAdapter(mode), {
      workingDirectory: directory,
      generatedAt: GENERATED_AT,
    })
    const credentialCase = record.cases.find(
      (entry) => entry.id === "no_metadata_echo",
    )
    assert.equal(
      credentialCase?.code,
      mode === "conforming" ? "no_metadata_echo_ok" : "metadata_secret_echoed",
      mode,
    )
    assert.equal(JSON.stringify(record).includes(SENTINEL), false, mode)
  }
})

test("qualification accepts exactly the two canonical capability sources", async () => {
  const directory = await workingDirectory()
  for (const capabilitySource of [
    "adapter_declaration",
    "conformance_test",
  ] as const) {
    const record = await runQualificationSuite(
      qualificationAdapter({ capabilitySource }),
      { workingDirectory: directory, generatedAt: GENERATED_AT },
    )
    assert.equal(record.axes.implemented, true, capabilitySource)
    assert.equal(
      record.cases.find((entry) => entry.id === "probe_contract")?.passed,
      true,
      capabilitySource,
    )
  }
  for (const capabilitySource of ["vendor_claim", "", undefined]) {
    const adapter = qualificationAdapter({ capabilitySource })
    if (capabilitySource === undefined) {
      const originalProbe = adapter.probe.bind(adapter)
      adapter.probe = async () => {
        const probe = (await originalProbe()) as unknown as Record<string, unknown>
        delete probe.capabilitySource
        return probe as unknown as AgentHostProbeResult
      }
    }
    const record = await runQualificationSuite(adapter, {
      workingDirectory: directory,
      generatedAt: GENERATED_AT,
    })
    assert.equal(record.axes.implemented, false, String(capabilitySource))
    assert.equal(
      record.cases.find((entry) => entry.id === "probe_contract")?.passed,
      false,
      String(capabilitySource),
    )
  }
})

test("responding qualification hosts require an exact bounded version", async () => {
  const directory = await workingDirectory()
  const boundary = await runQualificationSuite(
    qualificationAdapter({ hostVersion: "v".repeat(256) }),
    { workingDirectory: directory, generatedAt: GENERATED_AT },
  )
  assert.equal(boundary.hostVersion.length, 256)
  for (const hostVersion of ["", "v".repeat(257)]) {
    await assert.rejects(
      () =>
        runQualificationSuite(qualificationAdapter({ hostVersion }), {
          workingDirectory: directory,
          generatedAt: GENERATED_AT,
        }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "INVALID_QUALIFICATION_HOST_VERSION",
    )
  }
})

test("a stream violation can never be reported as fixture-conformant", async () => {
  const directory = await workingDirectory()
  const record = await runQualificationSuite(
    qualificationAdapter({ eventAfterTerminal: true }),
    { workingDirectory: directory, generatedAt: GENERATED_AT },
  )
  const terminalCase = record.cases.find(
    (entry) => entry.id === "exactly_one_terminal",
  )
  assert.equal(terminalCase?.passed, false)
  assert.equal(terminalCase?.code, "event_after_terminal")
  assert.deepEqual(record.axes, {
    implemented: true,
    fixtureConformant: false,
    liveQualified: false,
  })
})

test("a disallowed tool event fails the tool enforcement domain", async () => {
  const directory = await workingDirectory()
  const record = await runQualificationSuite(
    qualificationAdapter({ disallowedTool: true }),
    { workingDirectory: directory, generatedAt: GENERATED_AT },
  )
  const toolCase = record.cases.find(
    (entry) => entry.id === "tool_allowlist_respected",
  )
  assert.equal(toolCase?.passed, false)
  assert.equal(toolCase?.code, "disallowed_tool_event")
  assert.equal(record.axes.fixtureConformant, false)
})

test("a terminal output outside the schema fails the output schema domain", async () => {
  const directory = await workingDirectory()
  const record = await runQualificationSuite(
    qualificationAdapter({ outputSchemaViolation: true }),
    { workingDirectory: directory, generatedAt: GENERATED_AT },
  )
  const schemaCase = record.cases.find((entry) => entry.id === "valid_json")
  assert.equal(schemaCase?.passed, false)
  assert.equal(schemaCase?.code, "output_schema_violation")
  assert.equal(record.axes.fixtureConformant, false)
})

test("forwarding a hostile terminal output fails the rejection vectors", async () => {
  const directory = await workingDirectory()
  const record = await runQualificationSuite(
    qualificationAdapter({ forwardBadOutputSchemaTerminal: true }),
    { workingDirectory: directory, generatedAt: GENERATED_AT },
  )
  for (const vector of ["non_json", "schema_mismatch", "secret_rejected"]) {
    const vectorCase = record.cases.find((entry) => entry.id === vector)
    assert.equal(vectorCase?.passed, false, vector)
    assert.equal(vectorCase?.code, `${vector}_forwarded_bad_terminal`, vector)
  }
  assert.equal(record.axes.fixtureConformant, false)
})

test("accepting an asynchronous output schema fails the preflight vector", async () => {
  const directory = await workingDirectory()
  const record = await runQualificationSuite(
    qualificationAdapter({ acceptAsyncOutputSchema: true }),
    { workingDirectory: directory, generatedAt: GENERATED_AT },
  )
  const vectorCase = record.cases.find(
    (entry) => entry.id === "invalid_schema_preflight",
  )
  assert.equal(vectorCase?.passed, false)
  assert.equal(vectorCase?.code, "invalid_schema_preflight_ran_model_process")
  assert.equal(record.axes.fixtureConformant, false)
})

test("flushing buffered output after cancel fails the cancel vector", async () => {
  const directory = await workingDirectory()
  const record = await runQualificationSuite(
    qualificationAdapter({ flushBufferedOutput: true }),
    { workingDirectory: directory, generatedAt: GENERATED_AT },
  )
  const vectorCase = record.cases.find(
    (entry) => entry.id === "cancel_buffered",
  )
  assert.equal(vectorCase?.passed, false)
  assert.equal(vectorCase?.code, "cancel_buffered_buffer_flushed")
  assert.equal(record.axes.fixtureConformant, false)
})

test("an adapter that echoes request metadata fails the credential boundary domain", async () => {
  const directory = await workingDirectory()
  const record = await runQualificationSuite(
    qualificationAdapter({ echoMetadata: true }),
    { workingDirectory: directory, generatedAt: GENERATED_AT },
  )
  const credentialCase = record.cases.find(
    (entry) => entry.id === "no_metadata_echo",
  )
  assert.equal(credentialCase?.passed, false)
  assert.equal(credentialCase?.code, "metadata_secret_echoed")
  assert.equal(record.axes.fixtureConformant, false)
})

test("an adapter that accepts hostile writes fails the enforcement domain", async () => {
  const directory = await workingDirectory()
  const record = await runQualificationSuite(
    qualificationAdapter({ acceptHostileWrite: true }),
    { workingDirectory: directory, generatedAt: GENERATED_AT },
  )
  const fsCase = record.cases.find(
    (entry) => entry.id === "hostile_write_refused",
  )
  assert.equal(fsCase?.passed, false)
  assert.equal(fsCase?.code, "filesystem_deny_accepted")
  assert.equal(record.axes.fixtureConformant, false)
})

test("a missing capability or probe-only adapter cannot reach the implemented axis", async () => {
  const directory = await workingDirectory()
  const missing = await runQualificationSuite(
    qualificationAdapter({ missingCapability: true }),
    { workingDirectory: directory, generatedAt: GENERATED_AT },
  )
  assert.deepEqual(missing.axes, {
    implemented: false,
    fixtureConformant: false,
    liveQualified: false,
  })
  const probeCase = missing.cases.find((entry) => entry.id === "probe_contract")
  assert.equal(probeCase?.passed, false)
  assert.equal(probeCase?.code, "probe_contract_violation")

  const probeOnly = await runQualificationSuite(
    qualificationAdapter({ probeOnly: true }),
    { workingDirectory: directory, generatedAt: GENERATED_AT },
  )
  assert.equal(probeOnly.axes.implemented, false)
  assert.equal(probeOnly.axes.fixtureConformant, false)
})

test("the live axis is fail-closed and requires explicit validated evidence", async () => {
  const directory = await workingDirectory()
  const evidenceDigest = createHash("sha256")
    .update("live-run-evidence")
    .digest("hex")
  const qualified = await runQualificationSuite(qualificationAdapter(), {
    workingDirectory: directory,
    generatedAt: GENERATED_AT,
    liveEvidence: { environment: "live-local-e2e", evidenceDigest },
  })
  assert.equal(qualified.axes.liveQualified, true)
  assert.deepEqual(qualified.liveEvidence, {
    environment: "live-local-e2e",
    evidenceDigest,
  })

  await assert.rejects(
    () =>
      runQualificationSuite(qualificationAdapter(), {
        workingDirectory: directory,
        generatedAt: GENERATED_AT,
        liveEvidence: { environment: "live", evidenceDigest: "not-a-digest" },
      }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "INVALID_QUALIFICATION_LIVE_EVIDENCE",
  )
})

test("qualification input validation rejects bad host ids and timestamps", async () => {
  const directory = await workingDirectory()
  await assert.rejects(
    () =>
      runQualificationSuite(qualificationAdapter(), {
        workingDirectory: directory,
        generatedAt: "2026-08-06 03:00:00",
      }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "INVALID_QUALIFICATION_TIMESTAMP",
  )
  const badHost = qualificationAdapter()
  Object.defineProperty(badHost, "hostId", { value: "Fixture_Host" })
  await assert.rejects(
    () =>
      runQualificationSuite(badHost, {
        workingDirectory: directory,
        generatedAt: GENERATED_AT,
      }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "INVALID_QUALIFICATION_HOST_ID",
  )
})

test("the record validator enforces schema, axis consistency and full domain coverage", async () => {
  const directory = await workingDirectory()
  const record = await runQualificationSuite(qualificationAdapter(), {
    workingDirectory: directory,
    generatedAt: GENERATED_AT,
  })

  assert.doesNotThrow(() => validateAdapterQualificationRecord(record))
  assert.throws(
    () =>
      validateAdapterQualificationRecord({ ...record, schema: "wrong.v1" }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "INVALID_QUALIFICATION_RECORD",
  )
  assert.throws(
    () => validateAdapterQualificationRecord({ ...record, extra: 1 }),
    /unknown qualification record field/,
  )
  assert.throws(() =>
    validateAdapterQualificationRecord({
      ...record,
      axes: {
        implemented: false,
        fixtureConformant: true,
        liveQualified: false,
      },
    }),
  )
  assert.throws(() =>
    validateAdapterQualificationRecord({
      ...record,
      axes: { implemented: true, fixtureConformant: true, liveQualified: true },
    }),
  )
  assert.throws(() =>
    validateAdapterQualificationRecord({
      ...record,
      cases: record.cases.filter(
        (entry) => entry.domain !== "credential_boundaries",
      ),
    }),
  )
  assert.throws(() =>
    validateAdapterQualificationRecord({ ...record, hostId: "UPPER" }),
  )
  assert.throws(() => validateAdapterQualificationRecord(null))
})

test("record validation fails closed on accessors without invoking them", async () => {
  const directory = await workingDirectory()
  const record = await runQualificationSuite(qualificationAdapter(), {
    workingDirectory: directory,
    generatedAt: GENERATED_AT,
  })
  let invoked = 0
  Object.defineProperty(record, Symbol("opaque"), {
    enumerable: true,
    get() {
      invoked += 1
      return SENTINEL
    },
  })
  assert.throws(
    () => validateAdapterQualificationRecord(record),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "QUALIFICATION_EVIDENCE_SCAN_INCOMPLETE",
  )
  assert.equal(invoked, 0)
})

test("record scanning recognizes only native Error stack accessors without invoking custom getters", async () => {
  const directory = await workingDirectory()
  const makeRecord = async () =>
    await runQualificationSuite(qualificationAdapter(), {
      workingDirectory: directory,
      generatedAt: GENERATED_AT,
    })

  const nativeErrorRecord = await makeRecord()
  Object.defineProperty(nativeErrorRecord, Symbol("native-error"), {
    value: new Error("ordinary native error"),
  })
  assert.doesNotThrow(() => validateAdapterQualificationRecord(nativeErrorRecord))

  let customGetterCalls = 0
  const customStackRecord = await makeRecord()
  const customStack = new Error("custom stack descriptor")
  Object.defineProperty(customStack, "stack", {
    configurable: true,
    enumerable: false,
    get() {
      customGetterCalls += 1
      return "custom stack"
    },
  })
  Object.defineProperty(customStackRecord, Symbol("custom-stack"), {
    value: customStack,
  })
  assert.throws(
    () => validateAdapterQualificationRecord(customStackRecord),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "QUALIFICATION_EVIDENCE_SCAN_INCOMPLETE",
  )
  assert.equal(customGetterCalls, 0)

  const sentinelRecord = await makeRecord()
  const sentinelStack = new Error("custom stack with symbol evidence")
  Object.defineProperty(sentinelStack, "stack", {
    configurable: true,
    enumerable: false,
    get() {
      customGetterCalls += 1
      return SENTINEL
    },
  })
  Object.defineProperty(sentinelStack, Symbol("external-record"), {
    value: { leaked: SENTINEL },
  })
  Object.defineProperty(sentinelRecord, Symbol("custom-stack"), {
    value: sentinelStack,
  })
  assert.throws(
    () => validateAdapterQualificationRecord(sentinelRecord),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "QUALIFICATION_EVIDENCE_SECRET_DETECTED",
  )
  assert.equal(customGetterCalls, 0)
})

test("record scanning inspects symbol data and fails closed on proxies and budget exhaustion", async () => {
  const directory = await workingDirectory()
  const makeRecord = async () =>
    await runQualificationSuite(qualificationAdapter(), {
      workingDirectory: directory,
      generatedAt: GENERATED_AT,
    })

  const symbolEvidence = await makeRecord()
  Object.defineProperty(symbolEvidence, Symbol("qualification-evidence"), {
    value: { leaked: SENTINEL },
    enumerable: false,
  })
  assert.throws(
    () => validateAdapterQualificationRecord(symbolEvidence),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "QUALIFICATION_EVIDENCE_SECRET_DETECTED",
  )

  const proxied = new Proxy(await makeRecord(), {
    ownKeys() {
      throw new Error("proxy keys unavailable")
    },
  })
  assert.throws(
    () => validateAdapterQualificationRecord(proxied),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "QUALIFICATION_EVIDENCE_SCAN_INCOMPLETE",
  )

  const overBudget = await makeRecord()
  Object.defineProperty(overBudget, Symbol("wide-evidence"), {
    value: Array.from({ length: 4_097 }, () => ({ safe: true })),
  })
  assert.throws(
    () => validateAdapterQualificationRecord(overBudget),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "QUALIFICATION_EVIDENCE_SCAN_INCOMPLETE",
  )
})

test("record validation supports the legacy 1.0 contract and derives all summaries", async () => {
  const directory = await workingDirectory()
  const current = await runQualificationSuite(qualificationAdapter(), {
    workingDirectory: directory,
    generatedAt: GENERATED_AT,
  })
  const legacyCases = current.cases
    .filter(
      (entry) =>
        ![
          "descendants_disposed_timeout",
          "descendants_disposed_cancel",
          "network_deny_refused",
          "mcp_deny_refused",
          "valid_json",
          "non_json",
          "schema_mismatch",
          "invalid_schema_preflight",
          "cancel_buffered",
          "secret_rejected",
        ].includes(entry.id),
    )
    .map((entry) =>
      entry.id === "cancel_stops_active_run"
        ? { ...entry, id: "cancel_stops_run", code: "cancel_stops_run_ok" }
        : entry.id === "descendants_disposed_normal"
          ? { ...entry, id: "stream_terminates", code: "stream_terminates_ok" }
          : entry,
    )
  legacyCases.push({
    domain: "output_schema",
    id: "terminal_output_matches_schema",
    passed: true,
    code: "terminal_output_matches_schema_ok",
  })
  const legacyDomains = Object.fromEntries(
    QUALIFICATION_DOMAINS.map((domain) => {
      const entries = legacyCases.filter((entry) => entry.domain === domain)
      return [
        domain,
        {
          passed: entries.filter((entry) => entry.passed).length,
          failed: entries.filter((entry) => !entry.passed).length,
        },
      ]
    }),
  )
  const legacy = {
    ...current,
    kitVersion: "1.0.0",
    cases: legacyCases,
    domains: legacyDomains,
    axes: {
      implemented: true,
      fixtureConformant: legacyCases.every((entry) => entry.passed),
      liveQualified: false,
    },
  }
  assert.doesNotThrow(() => validateAdapterQualificationRecord(legacy))
  assert.throws(() =>
    validateAdapterQualificationRecord({
      ...legacy,
      domains: {
        ...legacyDomains,
        output_schema: { passed: 99, failed: 0 },
      },
    }),
  )
  assert.throws(() =>
    validateAdapterQualificationRecord({
      ...legacy,
      axes: { ...legacy.axes, fixtureConformant: !legacy.axes.fixtureConformant },
    }),
  )
})

test("record validation supports the superseded 1.1 contract", async () => {
  const directory = await workingDirectory()
  const current = await runQualificationSuite(qualificationAdapter(), {
    workingDirectory: directory,
    generatedAt: GENERATED_AT,
  })
  const supersededCases = current.cases
    .filter(
      (entry) =>
        ![
          "valid_json",
          "non_json",
          "schema_mismatch",
          "invalid_schema_preflight",
          "cancel_buffered",
          "secret_rejected",
        ].includes(entry.id),
    )
    .concat({
      domain: "output_schema",
      id: "terminal_output_matches_schema",
      passed: true,
      code: "terminal_output_matches_schema_ok",
    })
  const supersededDomains = Object.fromEntries(
    QUALIFICATION_DOMAINS.map((domain) => {
      const entries = supersededCases.filter(
        (entry) => entry.domain === domain,
      )
      return [
        domain,
        {
          passed: entries.filter((entry) => entry.passed).length,
          failed: entries.filter((entry) => !entry.passed).length,
        },
      ]
    }),
  )
  const superseded = {
    ...current,
    kitVersion: "1.1.0",
    cases: supersededCases,
    domains: supersededDomains,
    axes: {
      implemented: true,
      fixtureConformant: supersededCases.every((entry) => entry.passed),
      liveQualified: false,
    },
  }
  assert.doesNotThrow(() => validateAdapterQualificationRecord(superseded))
  assert.throws(() =>
    validateAdapterQualificationRecord({
      ...superseded,
      cases: supersededCases.slice(0, -1),
    }),
  )
})

test("record validation rejects unknown kit versions", async () => {
  const directory = await workingDirectory()
  const record = await runQualificationSuite(qualificationAdapter(), {
    workingDirectory: directory,
    generatedAt: GENERATED_AT,
  })
  assert.throws(
    () => validateAdapterQualificationRecord({ ...record, kitVersion: "2.0.0" }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes("1.0.0, 1.1.0 or 1.2.0"),
  )
})

test("qualification records stay machine readable and never embed the credential sentinel", async () => {
  const directory = await workingDirectory()
  const record: AdapterQualificationRecord = await runQualificationSuite(
    qualificationAdapter(),
    { workingDirectory: directory, generatedAt: GENERATED_AT },
  )
  const serialized = JSON.stringify(record)
  assert.ok(!serialized.includes(SENTINEL))
  assert.ok(record.cases.every((entry) => /^[a-z0-9_]+$/.test(entry.code)))
  assert.ok(
    record.cases.every((entry) => /^[a-z0-9_]+$/.test(entry.id)),
  )
  assert.ok(
    Object.values(record.domains).every(
      (entry) =>
        Number.isInteger(entry.passed) && Number.isInteger(entry.failed),
    ),
  )
})

test("the policy digest is deterministic across runs", async () => {
  const directory = await workingDirectory()
  const first = await runQualificationSuite(qualificationAdapter(), {
    workingDirectory: directory,
    generatedAt: GENERATED_AT,
  })
  const second = await runQualificationSuite(qualificationAdapter(), {
    workingDirectory: directory,
    generatedAt: GENERATED_AT,
  })
  assert.equal(first.policyDigest, second.policyDigest)
  assert.match(first.policyDigest, /^[0-9a-f]{64}$/)
  assert.equal(
    canonicalPolicyDigest({
      approval: { mode: "never" },
      filesystem: { read: ["."], write: [] },
      maxTurns: 4,
      network: { mode: "deny" },
      tools: { default: "deny", allow: [{ name: "noop", mode: "read" }] },
    }),
    first.policyDigest,
  )
})

const STDIO_HOST_ID = "builtin-stdio-host"
const STDIO_TIMESTAMP = "2026-08-06T03:00:00.000Z"

function builtinOutputConforms(output: unknown): boolean {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return false
  }
  const record = output as Record<string, unknown>
  const keys = Object.keys(record)
  return (
    keys.length === 1 && keys[0] === "answer" && typeof record.answer === "string"
  )
}

function stdioHostProbePayload(): Record<string, unknown> {
  const capabilities = createUnknownAgentHostCapabilities()
  for (const capability of AGENT_HOST_CAPABILITIES) {
    capabilities[capability] = "supported"
  }
  return {
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    hostId: STDIO_HOST_ID,
    displayName: "Built-in Stdio Host",
    status: "ready",
    available: true,
    adapterStatus: "runnable",
    version: "1.0.0",
    capabilities,
    capabilitySource: "adapter_declaration",
    issues: [],
  }
}

interface StdioHostOptions {
  tamperEvent?: boolean
}

/**
 * In-memory fake host speaking agent-host-stdio.v1. Every line it receives
 * and emits goes through the shipped fail-closed codec, so the built-in
 * conformance run exercises the real wire validators offline.
 */
function fakeStdioHost(options: StdioHostOptions = {}) {
  const cancelled = new Set<string>()
  const envelope = (message: Record<string, unknown>) =>
    encodeAgentHostStdioLine({
      protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
      ...message,
    })
  return {
    cancelled,
    handle(line: string): string[] {
      const request = parseAgentHostStdioRequest(line)
      if (request.kind === "probe") {
        return [
          envelope({
            id: request.id,
            kind: "response",
            ok: true,
            result: stdioHostProbePayload(),
          }),
        ]
      }
      if (request.kind === "cancel") {
        cancelled.add((request.payload as { runId: string }).runId)
        return [envelope({ id: request.id, kind: "response", ok: true })]
      }
      const payload = request.payload as AgentHostRunRequest
      const writesAllowed = payload.policy.filesystem.write.every(
        (entry) => entry === "." || entry.startsWith(payload.workingDirectory),
      )
      if (!writesAllowed) {
        return [
          envelope({
            id: request.id,
            kind: "response",
            ok: false,
            error: {
              code: "agent_host_stdio_host_error",
              message: "filesystem write outside allowed scope",
              retryable: false,
            },
          }),
        ]
      }
      if (request.kind === "preflight") {
        const operation = qualificationOperation(payload)
        if (
          operation === "filesystem.write" ||
          operation === "network.connect" ||
          operation === "mcp.invoke"
        ) {
          return [
            envelope({
              id: request.id,
              kind: "response",
              ok: false,
              error: {
                code:
                  operation === "filesystem.write"
                    ? QUALIFICATION_FILESYSTEM_DENIAL_CODE
                    : operation === "network.connect"
                      ? QUALIFICATION_NETWORK_DENIAL_CODE
                      : QUALIFICATION_MCP_DENIAL_CODE,
                message: "qualification deny fixture",
                retryable: false,
              },
            }),
          ]
        }
        return [
          envelope({
            id: request.id,
            kind: "response",
            ok: true,
            result: stdioHostProbePayload(),
          }),
        ]
      }
      const lines = [
        envelope({
          id: request.id,
          kind: "event",
          event: {
            type: "run.started",
            runId: payload.runId,
            timestamp: STDIO_TIMESTAMP,
          },
        }),
      ]
      if (cancelled.has(payload.runId)) {
        lines.push(
          envelope({
            id: request.id,
            kind: "event",
            event: {
              type: "run.failed",
              runId: payload.runId,
              timestamp: STDIO_TIMESTAMP,
              error: {
                code: "agent_host_cancelled",
                message: "run cancelled",
                retryable: false,
              },
            },
          }),
        )
        return lines
      }
      const emitScenario =
        qualificationOperation(payload) === "output_schema.emit"
          ? qualificationScenario(payload)
          : undefined
      if (emitScenario !== undefined) {
        // Hostile terminals the Adapter must reject against the run schema.
        const output =
          emitScenario === "non_json"
            ? "this terminal output is prose, not json"
            : emitScenario === "schema_mismatch"
              ? { wrong_field: "mismatched" }
              : { answer: "ok", leaked: SENTINEL }
        lines.push(
          envelope({
            id: request.id,
            kind: "event",
            event: {
              type: "run.completed",
              runId: payload.runId,
              timestamp: STDIO_TIMESTAMP,
              output,
            },
          }),
        )
        return lines
      }
      const completed: Record<string, unknown> = {
        type: "run.completed",
        runId: payload.runId,
        timestamp: STDIO_TIMESTAMP,
        output:
          payload.outputSchema !== undefined
            ? { answer: "qualified" }
            : { status: "answered" },
      }
      if (options.tamperEvent) {
        completed.vendorChannel = "smuggled"
      }
      lines.push(envelope({ id: request.id, kind: "event", event: completed }))
      return lines
    },
  }
}

function builtinStdioAdapter(
  options: StdioHostOptions = {},
): AgentHostAdapter {
  const host = fakeStdioHost(options)
  const cancelled = new Set<string>()
  const cancelWaiters = new Map<string, () => void>()
  const exchange = (message: Record<string, unknown>): string[] =>
    host.handle(
      encodeAgentHostStdioLine({
        protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
        ...message,
      }),
    )
  const expectOk = (lines: string[]) => {
    const message = parseAgentHostStdioHostLine(lines[0], STDIO_HOST_ID)
    if (message.kind !== "response" || message.ok !== true) {
      throw new Error("builtin stdio host refused the exchange")
    }
    return message
  }
  const wireRequest = (request: AgentHostRunRequest): AgentHostRunRequest => {
    const { signal: _signal, ...wire } = request
    return wire
  }
  return {
    hostId: STDIO_HOST_ID,
    async probe() {
      return probeResultFromStdioResponse(
        parseAgentHostStdioHostLine(
          exchange({ id: "probe-1", kind: "probe" })[0],
          STDIO_HOST_ID,
        ),
        STDIO_HOST_ID,
      )
    },
    async preflight(request) {
      const message = parseAgentHostStdioHostLine(
        exchange({
          id: `preflight-${request.runId}`,
          kind: "preflight",
          payload: wireRequest(request),
        })[0],
        STDIO_HOST_ID,
      )
      if (message.kind !== "response" || message.ok !== true) {
        const error =
          message.kind === "response" && message.ok === false
            ? message.error
            : {
                code: "agent_host_stdio_host_error",
                message: "builtin stdio host refused the exchange",
                retryable: false,
              }
        throw new CoreError(error.code, error.message, {
          status: 403,
          retryable: error.retryable,
        })
      }
      return probeResultFromStdioResponse(message, STDIO_HOST_ID)
    },
    async *run(request) {
      const operation = qualificationOperation(request)
      if (
        operation === "lifecycle.wait_for_cancel" ||
        (operation === "process_tree" &&
          request.runId !== "qualification-process_tree_normal")
      ) {
        const startedLine = encodeAgentHostStdioLine({
          protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
          id: `run-${request.runId}`,
          kind: "event",
          event: {
            type: "run.started",
            runId: request.runId,
            timestamp: STDIO_TIMESTAMP,
          },
        })
        const started = parseAgentHostStdioHostLine(
          startedLine,
          STDIO_HOST_ID,
        )
        assert.equal(started.kind, "event")
        yield started.event
        await new Promise<void>((resolve) => {
          cancelWaiters.set(request.runId, resolve)
          if (cancelled.has(request.runId)) resolve()
        })
        const failedLine = encodeAgentHostStdioLine({
          protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
          id: `run-${request.runId}`,
          kind: "event",
          event: {
            type: "run.failed",
            runId: request.runId,
            timestamp: STDIO_TIMESTAMP,
            error: {
              code: "agent_host_cancelled",
              message: "run cancelled",
              retryable: false,
            },
          },
        })
        const failed = parseAgentHostStdioHostLine(failedLine, STDIO_HOST_ID)
        assert.equal(failed.kind, "event")
        yield failed.event
        return
      }
      const wireEvent = (event: Record<string, unknown>): AgentHostEvent => {
        const line = encodeAgentHostStdioLine({
          protocol: AGENT_HOST_STDIO_PROTOCOL_VERSION,
          id: `run-${request.runId}`,
          kind: "event",
          event,
        })
        const message = parseAgentHostStdioHostLine(line, STDIO_HOST_ID)
        assert.equal(message.kind, "event")
        return message.event
      }
      if (operation === "output_schema.buffer_until_cancel") {
        yield wireEvent({
          type: "run.started",
          runId: request.runId,
          timestamp: STDIO_TIMESTAMP,
        })
        yield wireEvent({
          type: "assistant.delta",
          runId: request.runId,
          timestamp: STDIO_TIMESTAMP,
          text: '{"answer":"partial',
        })
        await new Promise<void>((resolve) => {
          cancelWaiters.set(request.runId, resolve)
          if (cancelled.has(request.runId)) resolve()
        })
        yield wireEvent({
          type: "run.failed",
          runId: request.runId,
          timestamp: STDIO_TIMESTAMP,
          error: {
            code: "agent_host_cancelled",
            message: "run cancelled",
            retryable: false,
          },
        })
        return
      }
      if (
        request.runId === "qualification-output_schema_invalid_schema_preflight"
      ) {
        // The asynchronous Schema is rejected before any host exchange.
        yield wireEvent({
          type: "run.failed",
          runId: request.runId,
          timestamp: STDIO_TIMESTAMP,
          error: {
            code: "agent_host_stdio_output_schema_invalid",
            message: "asynchronous output schema rejected before run",
            retryable: false,
          },
        })
        return
      }
      const lines = exchange({
        id: `run-${request.runId}`,
        kind: "run",
        payload: wireRequest(request),
      })
      for (const line of lines) {
        const message = parseAgentHostStdioHostLine(line, STDIO_HOST_ID)
        if (message.kind !== "event") continue
        const event = message.event
        if (
          event.type === "run.completed" &&
          request.outputSchema !== undefined &&
          !builtinOutputConforms(event.output)
        ) {
          // Adapter-enforced terminal validation: the hostile output is
          // replaced by a typed failure and never forwarded.
          yield wireEvent({
            type: "run.failed",
            runId: request.runId,
            timestamp: STDIO_TIMESTAMP,
            error: {
              code: "agent_host_stdio_output_schema_mismatch",
              message: "terminal output did not match the output schema",
              retryable: false,
            },
          })
          return
        }
        yield event
      }
    },
    async cancel(runId) {
      cancelled.add(runId)
      cancelWaiters.get(runId)?.()
      expectOk(
        exchange({ id: `cancel-${runId}`, kind: "cancel", payload: { runId } }),
      )
    },
    async qualificationIdentity() {
      return {
        configurationDigest: createHash("sha256")
          .update("builtin-stdio-host/default-config")
          .digest("hex"),
        ownerPid: process.pid,
      }
    },
  }
}

test("the built-in stdio adapter earns the fixture axis offline through the versioned wire", async () => {
  const directory = await workingDirectory()
  const adapter = builtinStdioAdapter()
  const record = await runQualificationSuite(adapter, {
    workingDirectory: directory,
    generatedAt: GENERATED_AT,
    caseTimeoutMs: 10_000,
    processTreeFixture: realProcessTreeFixture(adapter),
  })
  assert.equal(record.hostId, STDIO_HOST_ID)
  assert.deepEqual(record.axes, {
    implemented: true,
    fixtureConformant: true,
    liveQualified: false,
  }, JSON.stringify(record.cases.filter((entry) => !entry.passed)))
  assert.equal(record.cases.length, 18)
  assert.ok(record.cases.every((entry) => entry.passed))
  for (const domain of QUALIFICATION_DOMAINS) {
    assert.equal(record.domains[domain].failed, 0, domain)
  }
})

test("a built-in host that smuggles unknown event fields loses the fixture axis", async () => {
  const directory = await workingDirectory()
  const record = await runQualificationSuite(
    builtinStdioAdapter({ tamperEvent: true }),
    { workingDirectory: directory, generatedAt: GENERATED_AT },
  )
  assert.equal(record.axes.fixtureConformant, false)
  const terminalCase = record.cases.find(
    (entry) => entry.id === "exactly_one_terminal",
  )
  assert.equal(terminalCase?.passed, false)
})

test("live evidence can never smuggle extra keys into the record", async () => {
  const directory = await workingDirectory()
  const evidenceDigest = createHash("sha256")
    .update("live-run-evidence")
    .digest("hex")
  const record = await runQualificationSuite(qualificationAdapter(), {
    workingDirectory: directory,
    generatedAt: GENERATED_AT,
    liveEvidence: {
      environment: "live-local-e2e",
      evidenceDigest,
      apiKey: "sk-smuggled",
    } as never,
  })
  assert.deepEqual(record.liveEvidence, {
    environment: "live-local-e2e",
    evidenceDigest,
  })
  assert.ok(!JSON.stringify(record).includes("sk-smuggled"))
  assert.throws(
    () =>
      validateAdapterQualificationRecord({
        ...record,
        liveEvidence: {
          environment: "live-local-e2e",
          evidenceDigest,
          apiKey: "sk-smuggled",
        },
      }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "INVALID_QUALIFICATION_RECORD",
  )
})

test("the validator rejects unknown nested keys in axes, cases and domains", async () => {
  const directory = await workingDirectory()
  const record = await runQualificationSuite(qualificationAdapter(), {
    workingDirectory: directory,
    generatedAt: GENERATED_AT,
  })
  const invalidRecord = (mutate: (copy: Record<string, unknown>) => void) => {
    const copy = JSON.parse(JSON.stringify(record)) as Record<string, unknown>
    mutate(copy)
    assert.throws(
      () => validateAdapterQualificationRecord(copy),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "INVALID_QUALIFICATION_RECORD",
    )
  }
  invalidRecord((copy) => {
    ;(copy.axes as Record<string, unknown>).vendorCertified = true
  })
  invalidRecord((copy) => {
    ;(copy.cases as Array<Record<string, unknown>>)[0].note = "smuggled"
  })
  invalidRecord((copy) => {
    ;(copy.domains as Record<string, unknown>).rogue_domain = {
      passed: 1,
      failed: 0,
    }
  })
  invalidRecord((copy) => {
    const domains = copy.domains as Record<
      string,
      { passed: number; failed: number }
    >
    domains.capability_negotiation = { passed: 1, failed: -1 }
  })
})

test("the policy digest is content-addressed, order-free and collision-free", () => {
  const denyAll: AgentHostPolicy = {
    tools: { default: "deny", allow: [{ name: "noop", mode: "read" }] },
    filesystem: { read: ["."], write: [] },
    network: { mode: "deny" },
    approval: { mode: "never" },
    maxTurns: 4,
  }
  const shuffled: AgentHostPolicy = {
    maxTurns: 4,
    approval: { mode: "never" },
    tools: { default: "deny", allow: [{ name: "noop", mode: "read" }] },
    network: { mode: "deny" },
    filesystem: { read: ["."], write: [] },
  }
  assert.equal(canonicalPolicyDigest(denyAll), canonicalPolicyDigest(shuffled))
  const permissive: AgentHostPolicy = {
    tools: { default: "deny", allow: [{ name: "shell", mode: "write" }] },
    filesystem: { read: ["."], write: ["./out"] },
    network: { mode: "allowlist", hosts: ["example.com"] },
    approval: { mode: "required" },
    maxTurns: 4,
  }
  assert.notEqual(
    canonicalPolicyDigest(denyAll),
    canonicalPolicyDigest(permissive),
  )
})

test("the record validator rejects hostVersion exceeding 256 characters", async () => {
  const directory = await workingDirectory()
  const record = await runQualificationSuite(qualificationAdapter(), {
    workingDirectory: directory,
    generatedAt: GENERATED_AT,
  })
  assert.throws(
    () =>
      validateAdapterQualificationRecord({
        ...record,
        hostVersion: "x".repeat(257),
      }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "INVALID_QUALIFICATION_RECORD",
  )
  assert.doesNotThrow(() =>
    validateAdapterQualificationRecord({
      ...record,
      hostVersion: "v".repeat(256),
    }),
  )
  assert.throws(() =>
    validateAdapterQualificationRecord({ ...record, hostVersion: "" }),
  )
  assert.throws(() =>
    validateAdapterQualificationRecord({
      ...record,
      cases: record.cases.map((entry, index) =>
        index === 0 ? { ...entry, code: "UPPER CASE" } : entry,
      ),
    }),
  )
})
