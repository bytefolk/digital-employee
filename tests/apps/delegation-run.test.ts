/**
 * Black-box-at-the-spawn-boundary E3 fixtures for #158 R3 / #165 R4 S3-P0.
 * No real Qoder or Claude process is invoked here.
 */

import assert from "node:assert/strict"
import { mkdtemp, readFile, rename, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { runDelegation } from "../../apps/cli/task/delegation-run.js"
import { applyOrganization } from "../../apps/cli/org/model.js"
import { workspace } from "../../apps/cli/workspace/index.js"
import {
  AGENT_HOST_PROTOCOL_VERSION,
  createUnknownAgentHostCapabilities,
  type AgentHostAdapter,
  type AgentHostProbeResult,
} from "../../packages/core/src/agent-host.js"
import { AgentHostRegistry } from "../../packages/core/src/agent-host-registry.js"
import {
  DELEGATION_ENVELOPE_VERSION,
  computeCanonicalDigest,
  computeDelegationEnvelopeDigest,
} from "../../packages/engine/src/delegation.js"

async function createAppliedWorkspace(t: test.TestContext): Promise<{
  workspace: string
  organization: Record<string, unknown>
  permissions: Record<string, unknown>
}> {
  const home = await mkdtemp(path.join(os.tmpdir(), "delegation-e3-"))
  t.after(() => rm(home, { recursive: true, force: true }))
  const target = path.join(home, "oss")
  const originalWrite = process.stdout.write
  process.stdout.write = (() => true) as typeof process.stdout.write
  try {
    await workspace({
      subcommand: "init",
      args: [target],
      template: "oss-maintainer",
      json: true,
      providedOptions: new Set(["template"]),
    })
  } finally {
    process.stdout.write = originalWrite
  }
  await applyOrganization(target)
  return {
    workspace: target,
    organization: JSON.parse(
      await readFile(path.join(target, ".digital-employee", "org.json"), "utf8"),
    ) as Record<string, unknown>,
    permissions: JSON.parse(
      await readFile(
        path.join(target, ".digital-employee", "permissions.json"),
        "utf8",
      ),
    ) as Record<string, unknown>,
  }
}

function sealed(
  state: {
    organization: Record<string, unknown>
    permissions: Record<string, unknown>
  },
  engine: "qoder" | "claude-code",
  overrides: Record<string, unknown> = {},
): string {
  const body = {
    schemaVersion: DELEGATION_ENVELOPE_VERSION,
    taskId: `task-${engine}`,
    parentTurnId: "turn-parent",
    childTurnId: `turn-child-${engine}`,
    delegatedBy: "repo-owner",
    routedTo: "issue-researcher",
    trigger: "user_explicit",
    delegationDepth: 1,
    attempt: 1,
    retryOfTaskId: null,
    engine,
    instruction: "Return approved issue evidence.",
    organizationDigest: computeCanonicalDigest(state.organization),
    permissionsDigest: computeCanonicalDigest(state.permissions),
    deadline: "2026-08-25T00:00:00.000Z",
    ...overrides,
  }
  return JSON.stringify({
    ...body,
    envelopeDigest: computeDelegationEnvelopeDigest(body),
  })
}

function fixtureRegistry(calls: string[]): AgentHostRegistry {
  let registry = new AgentHostRegistry()
  for (const hostId of ["qoder", "claude-code"] as const) {
    const readyProbe = (): AgentHostProbeResult => {
      const capabilities = createUnknownAgentHostCapabilities()
      capabilities.non_interactive_run = "supported"
      capabilities.event_stream = "supported"
      capabilities.tool_allowlist = "supported"
      capabilities.filesystem_scope = "supported"
      capabilities.network_policy = "supported"
      return {
        protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
        hostId,
        displayName: `Fixture ${hostId}`,
        status: "ready",
        available: true,
        adapterStatus: "runnable",
        capabilities,
        capabilitySource: "conformance_test",
        issues: [],
      }
    }
    const adapter = (): AgentHostAdapter => ({
      hostId,
      probe: async () => readyProbe(),
      preflight: async () => readyProbe(),
      async *run(request) {
        calls.push(hostId)
        yield {
          type: "run.completed",
          runId: request.runId,
          timestamp: "2026-08-24T10:00:00.000Z",
          output: {
            status: "answered",
            answer: "fixture",
            citations: [],
          },
        }
      },
    })
    registry = registry.register({
      id: hostId,
      probe: async () => readyProbe(),
      createAdapter: async () => adapter(),
    })
  }
  return registry
}

test("AC-009: Qoder and Claude Code pass the identical deterministic E3 path", async (t) => {
  const state = await createAppliedWorkspace(t)
  const calls: string[] = []
  const hostRegistry = fixtureRegistry(calls)
  for (const engine of ["qoder", "claude-code"] as const) {
    const events: Array<Record<string, unknown>> = []
    const result = await runDelegation({
      workspace: state.workspace,
      envelopeText: sealed(state, engine),
      hostRegistry,
      writeEvent: (line) => events.push(JSON.parse(line)),
      writeDiagnostic: () => undefined,
    })
    assert.equal(result.exitCode, 0)
    assert.equal(result.terminalEmitted, true)
    assert.deepEqual(events.map((event) => event.type), [
      "delegation.started",
      "delegation.completed",
    ])
  }
  assert.deepEqual(calls, ["qoder", "claude-code"])
})

test("AC-008: cancellation reaches the child port and yields one trusted cancelled terminal", async (t) => {
  const state = await createAppliedWorkspace(t)
  const controller = new AbortController()
  const events: Array<Record<string, unknown>> = []
  const result = await runDelegation({
    workspace: state.workspace,
    envelopeText: sealed(state, "qoder"),
    signal: controller.signal,
    childExecutor: {
      async run(request) {
        assert.equal(request.signal, controller.signal)
        controller.abort()
        assert.equal(request.signal?.aborted, true)
        return {
          status: "cancelled",
          error: {
            code: "agent_host_cancelled",
            message: "cancelled",
            retryable: true,
          },
        }
      },
    },
    writeEvent: (line) => events.push(JSON.parse(line)),
    writeDiagnostic: () => undefined,
  })
  assert.equal(result.exitCode, 0)
  assert.deepEqual(events.map((event) => event.type), [
    "delegation.started",
    "delegation.cancelled",
  ])
})

test("AC-007: stale applied-state digest rejects before child execution", async (t) => {
  const state = await createAppliedWorkspace(t)
  let calls = 0
  const result = await runDelegation({
    workspace: state.workspace,
    envelopeText: sealed(state, "qoder", { organizationDigest: `sha256:${"f".repeat(64)}` }),
    childExecutor: {
      async run() {
        calls += 1
        return { status: "completed", output: null }
      },
    },
    writeEvent: () => undefined,
    writeDiagnostic: () => undefined,
  })
  assert.equal(result.exitCode, 1)
  assert.equal(result.terminalEmitted, false)
  assert.equal(calls, 0)
})

test("AC-007: a symlinked applied-state directory is rejected before child execution", async (t) => {
  const state = await createAppliedWorkspace(t)
  const stateDirectory = path.join(state.workspace, ".digital-employee")
  const moved = path.join(state.workspace, ".digital-employee-real")
  await rename(stateDirectory, moved)
  await symlink(moved, stateDirectory, "dir")
  let calls = 0
  const result = await runDelegation({
    workspace: state.workspace,
    envelopeText: sealed(state, "qoder"),
    childExecutor: {
      async run() {
        calls += 1
        return { status: "completed", output: null }
      },
    },
    writeEvent: () => undefined,
    writeDiagnostic: () => undefined,
  })
  assert.equal(result.exitCode, 1)
  assert.equal(calls, 0)
})

test("AC-008: process uncertainty exits 1 after started and never fabricates terminal", async (t) => {
  const state = await createAppliedWorkspace(t)
  const events: Array<Record<string, unknown>> = []
  const result = await runDelegation({
    workspace: state.workspace,
    envelopeText: sealed(state, "qoder"),
    childExecutor: {
      async run() {
        throw new Error("fixture process exit")
      },
    },
    writeEvent: (line) => events.push(JSON.parse(line)),
    writeDiagnostic: () => undefined,
  })
  assert.equal(result.exitCode, 1)
  assert.equal(result.terminalEmitted, false)
  assert.deepEqual(events.map((event) => event.type), ["delegation.started"])
})
