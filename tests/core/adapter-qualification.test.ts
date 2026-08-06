import assert from "node:assert/strict"
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
  QUALIFICATION_DOMAINS,
  canonicalPolicyDigest,
  runQualificationSuite,
  validateAdapterQualificationRecord,
} from "../../packages/core/src/adapter-qualification.js"
import type { AdapterQualificationRecord } from "../../packages/core/src/adapter-qualification.js"

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
  echoMetadata?: boolean
  missingCapability?: boolean
  probeOnly?: boolean
  acceptHostileWrite?: boolean
}

function qualificationAdapter(
  behavior: FixtureBehavior = {},
): AgentHostAdapter {
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
      return probe
    },
    async preflight(request: AgentHostRunRequest) {
      if (!behavior.acceptHostileWrite && request.policy.filesystem.write.length > 0) {
        throw new Error("write outside filesystem scope")
      }
      return verifiedProbe()
    },
    async *run(request) {
      const at = "2026-08-06T03:00:00.000Z"
      const started: AgentHostEvent = {
        type: "run.started",
        runId: request.runId,
        timestamp: at,
      }
      yield started
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
      const schemaCase = request.runId === "qualification-output_schema"
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
    async cancel() {},
  }
}

async function workingDirectory(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "adapter-qualification-"))
}

test("a conforming built-in-class adapter earns the fixture axis without live evidence", async () => {
  const directory = await workingDirectory()
  const record = await runQualificationSuite(qualificationAdapter(), {
    workingDirectory: directory,
    generatedAt: GENERATED_AT,
  })

  assert.equal(record.schema, ADAPTER_QUALIFICATION_SCHEMA_ID)
  assert.equal(record.kitVersion, ADAPTER_QUALIFICATION_KIT_VERSION)
  assert.equal(record.hostId, "fixture-host")
  assert.equal(record.hostVersion, "9.9.9")
  assert.deepEqual(record.axes, {
    implemented: true,
    fixtureConformant: true,
    liveQualified: false,
  })
  assert.equal(record.liveEvidence, undefined)
  assert.equal(record.cases.length, 9)
  assert.ok(record.cases.every((entry) => entry.passed))
  for (const domain of QUALIFICATION_DOMAINS) {
    assert.equal(record.domains[domain].failed, 0, domain)
  }
  assert.equal(
    record.policyDigest,
    createHash("sha256")
      .update(
        '{"approval":{"mode":"never"},"filesystem":{"read":["."],"write":[]},"maxTurns":4,"network":{"mode":"deny"},"tools":{"allow":[{"mode":"read","name":"noop"}],"default":"deny"}}',
      )
      .digest("hex"),
  )
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
  const schemaCase = record.cases.find(
    (entry) => entry.id === "terminal_output_matches_schema",
  )
  assert.equal(schemaCase?.passed, false)
  assert.equal(schemaCase?.code, "output_schema_violation")
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
  assert.equal(fsCase?.code, "hostile_write_accepted")
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
      return probeResultFromStdioResponse(
        expectOk(
          exchange({
            id: `preflight-${request.runId}`,
            kind: "preflight",
            payload: request,
          }),
        ),
        STDIO_HOST_ID,
      )
    },
    async *run(request) {
      const lines = exchange({
        id: `run-${request.runId}`,
        kind: "run",
        payload: request,
      })
      for (const line of lines) {
        const message = parseAgentHostStdioHostLine(line, STDIO_HOST_ID)
        if (message.kind === "event") {
          yield message.event
        }
      }
    },
    async cancel(runId) {
      expectOk(
        exchange({ id: `cancel-${runId}`, kind: "cancel", payload: { runId } }),
      )
    },
  }
}

test("the built-in stdio adapter earns the fixture axis offline through the versioned wire", async () => {
  const directory = await workingDirectory()
  const record = await runQualificationSuite(builtinStdioAdapter(), {
    workingDirectory: directory,
    generatedAt: GENERATED_AT,
  })
  assert.equal(record.hostId, STDIO_HOST_ID)
  assert.deepEqual(record.axes, {
    implemented: true,
    fixtureConformant: true,
    liveQualified: false,
  })
  assert.equal(record.cases.length, 9)
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
