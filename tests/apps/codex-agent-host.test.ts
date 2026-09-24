import assert from "node:assert/strict"
import test from "node:test"

import {
  CODEX_FIXTURE_ENV,
  createCodexAgentHostAdapter,
} from "../../apps/cli/codex-agent-host.js"
import type { AgentHostEvent, AgentHostRunRequest } from "../../packages/core/src/agent-host.js"
import {
  AGENT_HOST_PROTOCOL_VERSION,
} from "../../packages/core/src/agent-host.js"

function request(): AgentHostRunRequest {
  return {
    runId: "run-1",
    employeeId: "fixture",
    workingDirectory: "/tmp",
    prompt: "hello",
    policy: {
      tools: { default: "deny", allow: [] },
      filesystem: { read: ["."], write: [] },
      network: { mode: "deny" },
      approval: { mode: "never" },
    },
  }
}

async function collect(events: AsyncIterable<AgentHostEvent>): Promise<AgentHostEvent[]> {
  const result: AgentHostEvent[] = []
  for await (const event of events) result.push(event)
  return result
}

test("#329 AC-001: missing binary fails closed in doctor and run", async () => {
  const host = createCodexAgentHostAdapter({
    executeVersion: async () => ({ status: "not_found" }),
  })
  const probe = await host.probe()
  assert.equal(probe.adapterStatus, "runnable")
  assert.equal(probe.status, "not_found")
  assert.equal(probe.issues[0]?.code, "host_executable_not_found")
  const events = await collect(host.run(request()))
  assert.equal(events.at(-1)?.type, "run.failed")
  assert.equal(
    (events.at(-1) as { error: { code: string } }).error.code,
    "host_executable_not_found",
  )
})

test("#329 AC-001: ineligible version fails closed", async () => {
  const host = createCodexAgentHostAdapter({
    executeVersion: async () => ({ status: "installed", output: "not-codex 1.0" }),
  })
  const probe = await host.probe()
  assert.equal(probe.status, "not_ready")
  assert.equal(probe.issues[0]?.code, "codex_version_ineligible")
})

test("#329 AC-002: --version is not entitlement", async () => {
  const host = createCodexAgentHostAdapter({
    executeVersion: async () => ({ status: "installed", output: "codex-cli 0.153.4" }),
    environment: {},
  })
  const probe = await host.probe()
  assert.equal(probe.status, "not_ready")
  assert.equal(probe.issues[0]?.code, "codex_live_hold_no_receipt")
  const events = await collect(host.run(request()))
  assert.equal(events.at(-1)?.type, "run.failed")
})

test("#329 AC-002: fixture turn emits exactly one completed terminal", async () => {
  const host = createCodexAgentHostAdapter({
    executeVersion: async () => ({ status: "installed", output: "codex-cli 0.153.4" }),
    environment: { [CODEX_FIXTURE_ENV]: "1" },
  })
  const probe = await host.probe()
  assert.equal(probe.status, "ready")
  assert.equal(probe.protocolVersion, AGENT_HOST_PROTOCOL_VERSION)
  const events = await collect(host.run(request()))
  assert.deepEqual(
    events.map((event) => event.type),
    ["run.started", "run.completed"],
  )
})
