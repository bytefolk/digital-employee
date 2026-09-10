import assert from "node:assert/strict"
import test from "node:test"

import { probeCliAgentHost } from "../../apps/cli/agent-hosts.js"
import { createQoderAgentHostAdapter } from "../../apps/cli/qoder-agent-host.js"
import { validateAgentHostProbeResult } from "../../packages/core/src/agent-host-registry.js"
import { AGENT_HOST_PROBE_WIRE_KEYS, validateAgentHostProbeWire } from "../../packages/core/src/agent-host-wire.js"

// Frozen before #254, at 8a8a2a3a16c45e22c622b2d4ee8ff3698cc4ad4c.
// Keep independent of the producer's exported keys: old exact-key consumers
// cannot accept a new field just because the producer's validator accepts it.
const V1_PROBE_KEYS = [
  "protocolVersion", "hostId", "displayName", "status", "available",
  "adapterStatus", "version", "capabilities", "capabilitySource", "issues",
]

function consumeFrozenProbe(value: unknown, hostId: string): void {
  assert.deepEqual([...AGENT_HOST_PROBE_WIRE_KEYS], V1_PROBE_KEYS)
  const wire = JSON.parse(JSON.stringify(value))
  assert.deepEqual(
    Object.keys(wire).filter((key) => !V1_PROBE_KEYS.includes(key)),
    [],
    "old agent-host.v1 consumer rejects unknown probe keys",
  )
  for (const issue of wire.issues) {
    assert.deepEqual(Object.keys(issue).sort(), ["blocking", "code", "message"])
  }
  assert.equal(wire.protocolVersion, "agent-host.v1")
  // The original frozen validators reject this status. Preserve that
  // existing fail-closed boundary; this repair does not extend the enum.
  if (wire.status === "not_spawnable") {
    assert.throws(() => validateAgentHostProbeWire(wire, hostId))
    assert.throws(() => validateAgentHostProbeResult(wire, hostId))
    return
  }
  assert.deepEqual(validateAgentHostProbeWire(wire, hostId), wire)
  assert.deepEqual(validateAgentHostProbeResult(wire, hostId), wire)
}

test("old v1 consumer preserves acceptance of new Qoder command-resolution probes", async () => {
  for (const status of ["installed", "not_found", "not_spawnable", "probe_failed"] as const) {
    for (const token of [undefined, "fixture-service-token"]) {
      const host = createQoderAgentHostAdapter({
        command: "qoderclicn",
        environment: { QODER_PERSONAL_ACCESS_TOKEN: token },
        versionExecutor: async () => ({ status, output: status === "installed" ? "1.1.41" : undefined }),
      })
      consumeFrozenProbe(await host.probe(), "qoder")
    }
  }
})

test("old v1 consumer preserves acceptance of new probe-only Codex probes", async () => {
  for (const status of ["installed", "not_found", "not_spawnable", "probe_failed"] as const) {
    consumeFrozenProbe(await probeCliAgentHost("codex", async () => ({
      status, output: status === "installed" ? "fixture-version" : undefined,
    })), "codex")
  }
})
