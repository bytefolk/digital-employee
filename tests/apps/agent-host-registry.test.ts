import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { createBuiltInAgentHostRegistry } from "../../apps/cli/agent-host-registry.js"
import { createEmployeePackage } from "../../apps/cli/employee-package.js"
import {
  inspectEmployeeHostCompatibility,
  runEmployeePackage,
} from "../../apps/cli/agent-run.js"
import {
  AGENT_HOST_PROTOCOL_VERSION,
  createUnknownAgentHostCapabilities,
} from "../../packages/core/src/agent-host.js"
import type {
  AgentHostAdapter,
  AgentHostEvent,
  AgentHostProbeResult,
} from "../../packages/core/src/agent-host.js"
import type { SafeValue } from "../../packages/core/src/contracts.js"

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
    capabilities,
    capabilitySource: "conformance_test",
    issues: [],
  }
}

function fixtureAdapter(options: {
  preflightHostId?: string
  preflightError?: boolean
  malformedPreflight?: boolean
  malformedFailure?: boolean
  output?: SafeValue
  afterTerminal?: boolean
} = {}): AgentHostAdapter {
  return {
    hostId: "fixture-host",
    async probe() {
      return verifiedProbe()
    },
    async preflight() {
      if (options.preflightError) throw new Error("untrusted preflight detail")
      if (options.malformedPreflight) {
        return { hostId: "fixture-host" } as AgentHostProbeResult
      }
      return verifiedProbe(options.preflightHostId)
    },
    async *run(request) {
      const started: AgentHostEvent = {
        type: "run.started",
        runId: request.runId,
        timestamp: new Date().toISOString(),
      }
      yield started
      if (options.malformedFailure) {
        yield {
          type: "run.failed",
          runId: request.runId,
          timestamp: new Date().toISOString(),
        } as AgentHostEvent
        return
      }
      yield {
        type: "run.completed",
        runId: request.runId,
        timestamp: new Date().toISOString(),
        output: options.output ?? {
          status: "answered",
          answer: "registry fixture",
          citations: [],
        },
      }
      if (options.afterTerminal) {
        yield {
          type: "usage",
          runId: request.runId,
          timestamp: new Date().toISOString(),
          totalTokens: 1,
        }
      }
    },
  }
}

test("built-in registry exposes four runnable adapters and keeps Codex probe-only", async () => {
  const registry = createBuiltInAgentHostRegistry()
  for (const hostId of [
    "claude-code",
    "qoder",
    "qwen-code",
    "codebuddy",
  ]) {
    assert.equal(registry.hasAdapter(hostId), true, hostId)
    assert.equal((await registry.create(hostId)).hostId, hostId)
  }
  assert.equal(registry.hasAdapter("codex"), false)
  assert.equal(registry.resolve("claude"), "claude-code")
  assert.equal(registry.resolve("qwen"), "qwen-code")
  assert.equal(registry.resolve("codebuddy-code"), "codebuddy")
})

test("trusted embedders can register a host without changing the employee package", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "employee-registry-"))
  const directory = path.join(parent, "team-answer")
  await createEmployeePackage(directory)

  const registry = createBuiltInAgentHostRegistry().register({
    id: "fixture-host",
    aliases: ["fixture"],
    probe: async () => verifiedProbe(),
    createAdapter: () => fixtureAdapter(),
  })
  const registryPort = {
    resolve: registry.resolve.bind(registry),
    hasAdapter: registry.hasAdapter.bind(registry),
    probe: registry.probe.bind(registry),
    create: registry.create.bind(registry),
  }
  const events: AgentHostEvent[] = []
  const result = await runEmployeePackage({
    directory,
    engine: "fixture",
    hostRegistry: registryPort,
    input: { message: "hello" },
    onEvent: (event) => {
      events.push(event)
    },
  })

  assert.equal(result.status, "completed")
  assert.equal(result.engine, "fixture-host")
  assert.deepEqual(events.map((event) => event.type), [
    "run.started",
    "run.completed",
  ])
})

test("preflight identity is bound to the canonical registered host", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "employee-registry-"))
  const directory = path.join(parent, "team-answer")
  await createEmployeePackage(directory)

  const registry = createBuiltInAgentHostRegistry().register({
    id: "fixture-host",
    probe: async () => verifiedProbe(),
    createAdapter: () => fixtureAdapter({ preflightHostId: "other-host" }),
  })
  const events: AgentHostEvent[] = []
  const result = await runEmployeePackage({
    directory,
    engine: "fixture-host",
    hostRegistry: registry,
    input: { message: "hello" },
    onEvent: (event) => {
      events.push(event)
    },
  })

  assert.equal(result.status, "failed")
  assert.equal(
    result.status === "failed" && result.error.code,
    "agent_host_preflight_invalid",
  )
  assert.deepEqual(events, [])

  await assert.rejects(
    () =>
      inspectEmployeeHostCompatibility({
        directory,
        engine: "fixture-host",
        hostRegistry: registry,
      }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "AGENT_HOST_PREFLIGHT_INVALID",
  )
})

test("preflight exceptions become a safe structured failure", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "employee-registry-"))
  const directory = path.join(parent, "team-answer")
  await createEmployeePackage(directory)

  const registry = createBuiltInAgentHostRegistry().register({
    id: "fixture-host",
    probe: async () => verifiedProbe(),
    createAdapter: () => fixtureAdapter({ preflightError: true }),
  })
  const result = await runEmployeePackage({
    directory,
    engine: "fixture-host",
    hostRegistry: registry,
    input: { message: "hello" },
  })

  assert.equal(result.status, "failed")
  assert.equal(
    result.status === "failed" && result.error.code,
    "agent_host_preflight_failed",
  )

  await assert.rejects(
    () =>
      inspectEmployeeHostCompatibility({
        directory,
        engine: "fixture-host",
        hostRegistry: registry,
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "CoreError" &&
      "code" in error &&
      error.code === "AGENT_HOST_PREFLIGHT_FAILED" &&
      !error.message.includes("untrusted preflight detail"),
  )
})

test("preflight validates the complete probe shape, not only host identity", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "employee-registry-"))
  const directory = path.join(parent, "team-answer")
  await createEmployeePackage(directory)

  const registry = createBuiltInAgentHostRegistry().register({
    id: "fixture-host",
    probe: async () => verifiedProbe(),
    createAdapter: () => fixtureAdapter({ malformedPreflight: true }),
  })
  const result = await runEmployeePackage({
    directory,
    engine: "fixture-host",
    hostRegistry: registry,
    input: { message: "hello" },
  })

  assert.equal(result.status, "failed")
  assert.equal(
    result.status === "failed" && result.error.code,
    "agent_host_preflight_invalid",
  )
  await assert.rejects(
    () =>
      inspectEmployeeHostCompatibility({
        directory,
        engine: "fixture-host",
        hostRegistry: registry,
      }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "AGENT_HOST_PREFLIGHT_INVALID",
  )
})

test("a completed event is withheld until the stream contract is final", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "employee-registry-"))
  const directory = path.join(parent, "team-answer")
  await createEmployeePackage(directory)

  const registry = createBuiltInAgentHostRegistry().register({
    id: "fixture-host",
    probe: async () => verifiedProbe(),
    createAdapter: () => fixtureAdapter({ afterTerminal: true }),
  })
  const events: AgentHostEvent[] = []
  const result = await runEmployeePackage({
    directory,
    engine: "fixture-host",
    hostRegistry: registry,
    input: { message: "hello" },
    onEvent: (event) => {
      events.push(event)
    },
  })

  assert.equal(result.status, "failed")
  assert.equal(
    result.status === "failed" && result.error.code,
    "agent_host_terminal_contract_violated",
  )
  assert.deepEqual(events.map((event) => event.type), ["run.started"])
})

test("a completed event is withheld until output schema validation passes", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "employee-registry-"))
  const directory = path.join(parent, "team-answer")
  await createEmployeePackage(directory)

  const registry = createBuiltInAgentHostRegistry().register({
    id: "fixture-host",
    probe: async () => verifiedProbe(),
    createAdapter: () => fixtureAdapter({ output: {} }),
  })
  const events: AgentHostEvent[] = []
  const result = await runEmployeePackage({
    directory,
    engine: "fixture-host",
    hostRegistry: registry,
    input: { message: "hello" },
    onEvent: (event) => {
      events.push(event)
    },
  })

  assert.equal(result.status, "failed")
  assert.equal(
    result.status === "failed" && result.error.code,
    "employee_output_schema_mismatch",
  )
  assert.deepEqual(events.map((event) => event.type), ["run.started"])
})

test("a malformed failed terminal is rejected before event publication", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "employee-registry-"))
  const directory = path.join(parent, "team-answer")
  await createEmployeePackage(directory)

  const registry = createBuiltInAgentHostRegistry().register({
    id: "fixture-host",
    probe: async () => verifiedProbe(),
    createAdapter: () => fixtureAdapter({ malformedFailure: true }),
  })
  const events: AgentHostEvent[] = []
  const result = await runEmployeePackage({
    directory,
    engine: "fixture-host",
    hostRegistry: registry,
    input: { message: "hello" },
    onEvent: (event) => {
      events.push(event)
    },
  })

  assert.equal(result.status, "failed")
  assert.equal(
    result.status === "failed" && result.error.code,
    "agent_host_terminal_contract_violated",
  )
  assert.deepEqual(events.map((event) => event.type), ["run.started"])
})

test("an employee run cannot name an adapter outside the operator registry", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "employee-registry-"))
  const directory = path.join(parent, "team-answer")
  await createEmployeePackage(directory)

  const result = await runEmployeePackage({
    directory,
    engine: "package-supplied-module",
    hostRegistry: createBuiltInAgentHostRegistry(),
    input: { message: "hello" },
  })

  assert.equal(result.status, "failed")
  assert.equal(
    result.status === "failed" && result.error.code,
    "agent_host_not_registered",
  )
})
