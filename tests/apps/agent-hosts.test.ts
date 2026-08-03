import assert from "node:assert/strict"
import test from "node:test"

import {
  BUILT_IN_AGENT_HOST_IDS,
  getCliAgentHostDefinition,
  isBuiltInAgentHostId,
  probeCliAgentHost,
} from "../../apps/cli/agent-hosts.js"

test("built-in Agent hosts have stable CLI identities", () => {
  assert.deepEqual(BUILT_IN_AGENT_HOST_IDS, [
    "claude-code",
    "qoder",
    "codex",
    "qwen-code",
    "codebuddy",
  ])
  assert.equal(isBuiltInAgentHostId("qoder"), true)
  assert.equal(isBuiltInAgentHostId("qwen-code"), true)
  assert.equal(isBuiltInAgentHostId("codebuddy"), true)
  assert.equal(isBuiltInAgentHostId("workbuddy"), false)
  assert.equal(getCliAgentHostDefinition("codex").command, "codex")
  assert.equal(getCliAgentHostDefinition("qwen-code").command, "qwen")
  assert.equal(getCliAgentHostDefinition("codebuddy").command, "codebuddy")
})

test("host probe is side-effect free beyond a bounded version command", async () => {
  const calls: Array<{ command: string; args: string[] }> = []
  const result = await probeCliAgentHost("qoder", async (command, args) => {
    calls.push({ command, args })
    return { status: "installed", output: "qodercli 1.2.3" }
  })

  assert.deepEqual(calls, [{ command: "qodercli", args: ["--version"] }])
  assert.equal(result.available, true)
  assert.equal(result.status, "installed")
  assert.equal(result.version, "qodercli 1.2.3")
  assert.equal(result.capabilities.tool_allowlist, "documented")
  assert.equal(result.adapterStatus, "probe_only")
  assert.equal(result.issues[0]?.code, "authentication_not_checked")
})

test("missing hosts return a structured blocking issue", async () => {
  const result = await probeCliAgentHost("claude-code", async () => ({
    status: "not_found",
  }))
  assert.equal(result.available, false)
  assert.equal(result.status, "not_found")
  assert.equal(result.issues[0]?.code, "host_executable_not_found")
  assert.equal(result.issues[0]?.blocking, true)
})

test("Codex tool allowlisting stays unknown until an adapter can enforce it", () => {
  const definition = getCliAgentHostDefinition("codex")
  assert.equal(definition.capabilities.sandbox, "documented")
  assert.equal(definition.capabilities.tool_allowlist, "unknown")
})

test("Qwen Code and CodeBuddy claims remain documentation-only", () => {
  for (const hostId of ["qwen-code", "codebuddy"] as const) {
    const definition = getCliAgentHostDefinition(hostId)
    assert.equal(definition.capabilities.non_interactive_run, "documented")
    assert.equal(definition.capabilities.event_stream, "documented")
    assert.equal(definition.capabilities.tool_allowlist, "unknown")
  }
})
