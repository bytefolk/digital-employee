/**
 * Black-box-at-the-spawn-boundary E3 fixtures for #158 R3 / #165 R4 S3-P0.
 * No real Qoder or Claude process is invoked here.
 */

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

async function createAppliedWorkspace(
  t: test.TestContext,
  options: { toolAllow?: string[] } = {},
): Promise<{
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
  if (options.toolAllow) {
    const organizationFile = path.join(target, "organization.v1alpha1.json")
    const source = JSON.parse(await readFile(organizationFile, "utf8")) as {
      roles: Array<{ toolAllow: string[] }>
    }
    for (const role of source.roles) role.toolAllow = [...options.toolAllow]
    await writeFile(organizationFile, `${JSON.stringify(source, null, 2)}\n`)
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
    // Wall-clock margin: the built-CLI path exercises the real adapter, which
    // rejects elapsed deadlines and takes no injected clock.
    deadline: new Date(Date.now() + 24 * 3_600_000).toISOString(),
    ...overrides,
  }
  return JSON.stringify({
    ...body,
    envelopeDigest: computeDelegationEnvelopeDigest(body),
  })
}

function fixtureRegistry(
  calls: string[],
  requests: Array<Parameters<AgentHostAdapter["run"]>[0]> = [],
): AgentHostRegistry {
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
        requests.push(request)
        yield {
          type: "run.started",
          runId: request.runId,
          timestamp: "2026-08-24T09:59:59.000Z",
        }
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
  const state = await createAppliedWorkspace(t, { toolAllow: ["Read"] })
  const calls: string[] = []
  const requests: Array<Parameters<AgentHostAdapter["run"]>[0]> = []
  const hostRegistry = fixtureRegistry(calls, requests)
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
  const workspaceReal = await realpath(state.workspace)
  for (const request of requests) {
    assert.equal(request.workingDirectory, workspaceReal)
    assert.deepEqual(request.policy, {
      tools: {
        default: "deny",
        allow: [{ name: "filesystem.read", mode: "read" }],
      },
      filesystem: {
        read: [
          "./context/**",
          "./positions/repo-owner/issue-researcher/**",
        ],
        write: [],
      },
      network: { mode: "deny" },
      approval: { mode: "never" },
    })
    assert.equal(request.mcpServers, undefined)
    assert.deepEqual(request.workspaceFiles, [
      "./positions/repo-owner/issue-researcher/knowledge/README.md",
      "./positions/repo-owner/issue-researcher/evals/cases.json",
    ])
  }
})

test("AC-008: production boundary admits exactly one linear explicit retry", async (t) => {
  const state = await createAppliedWorkspace(t)
  const calls: string[] = []
  const envelopeText = sealed(state, "qoder", {
    taskId: "task-qoder-retry",
    childTurnId: "turn-child-qoder-retry",
    attempt: 2,
    retryOfTaskId: "task-qoder",
  })
  const result = await runDelegation({
    workspace: state.workspace,
    envelopeText,
    historyText: JSON.stringify([
      {
        taskId: "task-qoder",
        parentTurnId: "turn-parent",
        childTurnId: "turn-child-qoder",
        attempt: 1,
        retryOfTaskId: null,
      },
    ]),
    hostRegistry: fixtureRegistry(calls),
    writeEvent: () => undefined,
    writeDiagnostic: () => undefined,
  })
  assert.equal(result.exitCode, 0)
  assert.deepEqual(calls, ["qoder"])
})

test("AC-008: built CLI consumes workspace-local history and executes valid attempt 2", async (t) => {
  const state = await createAppliedWorkspace(t)
  const historyFile = path.join(
    state.workspace,
    ".digital-employee",
    "delegations.json",
  )
  await writeFile(
    historyFile,
    `${JSON.stringify([
      {
        taskId: "task-qoder",
        parentTurnId: "turn-parent",
        childTurnId: "turn-child-qoder",
        attempt: 1,
        retryOfTaskId: null,
      },
    ])}\n`,
  )
  const binDirectory = path.join(path.dirname(state.workspace), "fixture-bin")
  await mkdir(binDirectory)
  const qoder = path.join(binDirectory, "qodercli")
  const fixture = path.join(root, "tests", "apps", "fixtures", "fake-qoder.mjs")
  await writeFile(
    qoder,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"\n`,
  )
  await chmod(qoder, 0o700)
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "dist", "apps", "cli", "bin.js"),
      "task",
      "delegate",
      state.workspace,
      "--stdin",
      "--history-file",
      historyFile,
    ],
    {
      encoding: "utf8",
      input: sealed(state, "qoder", {
        taskId: "task-qoder-retry",
        childTurnId: "turn-child-qoder-retry",
        attempt: 2,
        retryOfTaskId: "task-qoder",
      }),
      env: {
        ...process.env,
        PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
        QODER_PERSONAL_ACCESS_TOKEN: "fixture-service-token",
      },
      timeout: 30_000,
    },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(
    result.stdout
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { type: string }).type),
    ["delegation.started", "delegation.completed"],
  )
})

test("AC-007: malformed, branched, gapped, and duplicate history reject before Host", async (t) => {
  const state = await createAppliedWorkspace(t)
  const retry = sealed(state, "qoder", {
    taskId: "task-qoder-retry-3",
    childTurnId: "turn-child-qoder-retry-3",
    attempt: 3,
    retryOfTaskId: "task-qoder-retry-2",
  })
  const first = {
    taskId: "task-qoder",
    parentTurnId: "turn-parent",
    childTurnId: "turn-child-qoder",
    attempt: 1,
    retryOfTaskId: null,
  }
  const second = {
    taskId: "task-qoder-retry-2",
    parentTurnId: "turn-parent",
    childTurnId: "turn-child-qoder-retry-2",
    attempt: 2,
    retryOfTaskId: "task-qoder",
  }
  for (const history of [
    "not-json",
    JSON.stringify([first, second, { ...second, taskId: "task-qoder-branch", childTurnId: "turn-child-qoder-branch" }]),
    JSON.stringify([first, { ...second, attempt: 3 }]),
    JSON.stringify([first, { ...second, taskId: first.taskId }]),
  ]) {
    const calls: string[] = []
    const result = await runDelegation({
      workspace: state.workspace,
      envelopeText: retry,
      historyText: history,
      hostRegistry: fixtureRegistry(calls),
      writeEvent: () => undefined,
      writeDiagnostic: () => undefined,
    })
    assert.equal(result.exitCode, 1)
    assert.deepEqual(calls, [])
  }
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
        request.onStarted()
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

test("AC-008: process uncertainty before run.started emits no lifecycle event", async (t) => {
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
  assert.deepEqual(events, [])
})

test("R3 transition: Host preflight failure emits neither false started nor terminal", async (t) => {
  const state = await createAppliedWorkspace(t)
  let spawnCalls = 0
  const registry = new AgentHostRegistry().register({
    id: "qoder",
    probe: async () => { throw new Error("unused") },
    createAdapter: async () => ({
      hostId: "qoder",
      probe: async () => { throw new Error("unused") },
      preflight: async () => { throw new Error("preflight failed") },
      async *run() {
        spawnCalls += 1
      },
    }),
  })
  const events: Array<Record<string, unknown>> = []
  const result = await runDelegation({
    workspace: state.workspace,
    envelopeText: sealed(state, "qoder"),
    hostRegistry: registry,
    writeEvent: (line) => events.push(JSON.parse(line)),
    writeDiagnostic: () => undefined,
  })
  assert.equal(result.exitCode, 1)
  assert.deepEqual(events, [])
  assert.equal(spawnCalls, 0)
})
