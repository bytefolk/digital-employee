import assert from "node:assert/strict"
import test from "node:test"

import {
  AGENT_HOST_CAPABILITIES,
  AGENT_HOST_PROTOCOL_VERSION,
  assessAgentHostCompatibility,
  createUnknownAgentHostCapabilities,
} from "../../packages/core/index.js"
import type { AgentHostProbeResult } from "../../packages/core/index.js"

function probe(): AgentHostProbeResult {
  const capabilities = createUnknownAgentHostCapabilities()
  capabilities.event_stream = "supported"
  capabilities.tool_allowlist = "unsupported"
  return {
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    hostId: "fixture",
    displayName: "Fixture Host",
    status: "ready",
    available: true,
    adapterStatus: "runnable",
    capabilities,
    capabilitySource: "conformance_test",
    issues: [],
  }
}

test("unknown host capabilities are explicit and complete", () => {
  const capabilities = createUnknownAgentHostCapabilities()
  assert.deepEqual(Object.keys(capabilities), [...AGENT_HOST_CAPABILITIES])
  assert.equal(
    Object.values(capabilities).every((support) => support === "unknown"),
    true,
  )
})

test("host compatibility accepts only verified required capabilities", () => {
  const result = assessAgentHostCompatibility(probe(), {
    requiredCapabilities: ["event_stream"],
  })
  assert.equal(result.compatible, true)
  assert.deepEqual(result.missing, [])
  assert.deepEqual(result.unknown, [])
})

test("host compatibility fails closed for unsupported and unknown controls", () => {
  const result = assessAgentHostCompatibility(probe(), {
    requiredCapabilities: ["tool_allowlist", "sandbox"],
  })
  assert.equal(result.compatible, false)
  assert.deepEqual(result.missing, ["tool_allowlist"])
  assert.deepEqual(result.unknown, ["sandbox"])
  assert.equal(
    result.issues.some(
      (issue) => issue.code === "required_capability_unverified",
    ),
    true,
  )
})

test("an unavailable executable is incompatible even without feature requirements", () => {
  const unavailable = probe()
  unavailable.available = false
  unavailable.status = "not_found"
  const result = assessAgentHostCompatibility(unavailable, {
    requiredCapabilities: [],
  })
  assert.equal(result.compatible, false)
  assert.equal(result.issues.at(-1)?.code, "host_not_ready")
})

test("missing capability keys and blocking preflight issues fail closed", () => {
  const incomplete = probe()
  delete (incomplete.capabilities as Partial<typeof incomplete.capabilities>)
    .filesystem_scope
  incomplete.issues.push({
    code: "policy_projection_failed",
    message: "fixture policy could not be enforced",
    blocking: true,
  })
  const result = assessAgentHostCompatibility(incomplete, {
    requiredCapabilities: ["filesystem_scope"],
  })
  assert.equal(result.compatible, false)
  assert.deepEqual(result.unknown, ["filesystem_scope"])
})
