import assert from "node:assert/strict"
import test from "node:test"

import {
  AGENT_HOST_PROTOCOL_VERSION,
  createUnknownAgentHostCapabilities,
} from "../../packages/core/src/agent-host.js"
import type {
  AgentHostAdapter,
  AgentHostProbeResult,
} from "../../packages/core/src/agent-host.js"
import {
  AgentHostRegistry,
  validateAgentHostProbeResult,
} from "../../packages/core/src/agent-host-registry.js"
import { CoreError } from "../../packages/core/src/contracts.js"

function probe(
  hostId: string,
  displayName = `Fixture ${hostId}`,
): AgentHostProbeResult {
  return {
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    hostId,
    displayName,
    status: "ready",
    available: true,
    adapterStatus: "runnable",
    capabilities: createUnknownAgentHostCapabilities(),
    capabilitySource: "conformance_test",
    issues: [],
  }
}

function adapter(hostId: string): AgentHostAdapter {
  return {
    hostId,
    async probe() {
      return probe(hostId)
    },
    async preflight() {
      return probe(hostId)
    },
    async *run() {},
  }
}

function isCoreError(
  expected: {
    code: string
    status?: number
    details?: unknown
  },
): (error: unknown) => boolean {
  return (error: unknown) => {
    if (!(error instanceof CoreError)) return false
    assert.equal(error.code, expected.code)
    if (expected.status !== undefined) {
      assert.equal(error.status, expected.status)
    }
    if (expected.details !== undefined) {
      assert.deepEqual(error.details, expected.details)
    }
    assert.equal(error.retryable, false)
    return true
  }
}

test("registry resolves aliases and keeps listing deterministic and lazy", async () => {
  let probeCalls = 0
  let createCalls = 0
  const registry = new AgentHostRegistry()

  registry.register({
    id: "zeta-host",
    aliases: ["zeta", "z-host"],
    async probe() {
      probeCalls += 1
      return probe("zeta-host")
    },
    createAdapter() {
      createCalls += 1
      return adapter("zeta-host")
    },
  })
  registry.register({
    id: "alpha-host",
    async probe() {
      return probe("alpha-host")
    },
  })

  const listed = registry.list()
  assert.deepEqual(listed, ["alpha-host", "zeta-host"])
  assert.equal(Object.isFrozen(listed), true)
  assert.equal(registry.resolve("zeta"), "zeta-host")
  assert.equal(registry.resolve("z-host"), "zeta-host")
  assert.equal(registry.resolve("zeta-host"), "zeta-host")
  assert.equal(registry.hasAdapter("zeta"), true)
  assert.equal(registry.hasAdapter("z-host"), true)
  assert.equal(registry.hasAdapter("alpha-host"), false)
  assert.equal(registry.hasAdapter("unknown-host"), false)
  assert.equal(probeCalls, 0)
  assert.equal(createCalls, 0)

  assert.equal((await registry.probe("zeta")).hostId, "zeta-host")
  assert.equal((await registry.create("z-host")).hostId, "zeta-host")
  assert.equal(probeCalls, 1)
  assert.equal(createCalls, 1)
})

test("host IDs and aliases are validated without normalization", () => {
  const registry = new AgentHostRegistry()
  const maximumLengthId = `a${"b".repeat(126)}z`
  registry.register({
    id: maximumLengthId,
    aliases: ["a", "vendor.host-v1"],
    async probe() {
      return probe(maximumLengthId)
    },
  })

  assert.equal(registry.resolve("a"), maximumLengthId)
  for (const invalidId of [
    "",
    "Qoder",
    " qoder",
    "qoder ",
    "qoder/cli",
    "qoder:cli",
    "_qoder",
    "qoder-",
    "a".repeat(129),
  ]) {
    assert.throws(
      () =>
        new AgentHostRegistry().register({
          id: invalidId,
          async probe() {
            return probe("unreachable")
          },
        }),
      isCoreError({ code: "INVALID_AGENT_HOST_ID", status: 400 }),
    )
  }

  assert.throws(
    () => registry.resolve("A"),
    isCoreError({ code: "INVALID_AGENT_HOST_ID", status: 400 }),
  )
  assert.throws(
    () => registry.hasAdapter("A"),
    isCoreError({ code: "INVALID_AGENT_HOST_ID", status: 400 }),
  )
  assert.throws(
    () =>
      new AgentHostRegistry().register({
        id: "valid",
        aliases: ["invalid-alias-"],
        async probe() {
          return probe("valid")
        },
      }),
    isCoreError({ code: "INVALID_AGENT_HOST_ID", status: 400 }),
  )
})

test("duplicate IDs, aliases, and shadowing attempts fail atomically", async () => {
  const registry = new AgentHostRegistry()
  registry.register({
    id: "qoder",
    aliases: ["qoder-cli"],
    async probe() {
      return probe("qoder", "Original Qoder")
    },
    createAdapter() {
      return adapter("qoder")
    },
  })

  const conflicts = [
    { id: "qoder", aliases: [] },
    { id: "qoder-cli", aliases: [] },
    { id: "new-host", aliases: ["qoder"] },
    { id: "another-host", aliases: ["qoder-cli"] },
    { id: "self-shadow", aliases: ["self-shadow"] },
    { id: "duplicate-alias", aliases: ["shared", "shared"] },
  ]
  for (const conflict of conflicts) {
    assert.throws(
      () =>
        registry.register({
          ...conflict,
          async probe() {
            return probe(conflict.id, "Replacement")
          },
        }),
      isCoreError({ code: "AGENT_HOST_IDENTIFIER_CONFLICT", status: 409 }),
    )
  }

  assert.deepEqual(registry.list(), ["qoder"])
  assert.equal(registry.resolve("qoder-cli"), "qoder")
  assert.equal((await registry.probe("qoder")).displayName, "Original Qoder")
  assert.equal((await registry.create("qoder")).hostId, "qoder")
  assert.throws(
    () => registry.resolve("new-host"),
    isCoreError({ code: "AGENT_HOST_NOT_REGISTERED", status: 404 }),
  )
})

test("unknown IDs fail consistently with structured details", async () => {
  const registry = new AgentHostRegistry()
  const expected = {
    code: "AGENT_HOST_NOT_REGISTERED",
    status: 404,
    details: { hostId: "missing-host" },
  }

  assert.throws(() => registry.resolve("missing-host"), isCoreError(expected))
  await assert.rejects(registry.probe("missing-host"), isCoreError(expected))
  await assert.rejects(registry.create("missing-host"), isCoreError(expected))
})

test("probe-only registrations reject adapter creation explicitly", async () => {
  const registry = new AgentHostRegistry().register({
    id: "probe-only",
    async probe() {
      const result = probe("probe-only")
      result.adapterStatus = "probe_only"
      return result
    },
  })

  assert.equal((await registry.probe("probe-only")).adapterStatus, "probe_only")
  await assert.rejects(
    registry.create("probe-only"),
    isCoreError({
      code: "AGENT_HOST_ADAPTER_NOT_RUNNABLE",
      status: 409,
      details: { hostId: "probe-only" },
    }),
  )
})

test("probe and adapter identity mismatches fail closed", async () => {
  const registry = new AgentHostRegistry()
    .register({
      id: "bad-probe",
      async probe() {
        return probe("different-host")
      },
    })
    .register({
      id: "bad-adapter",
      async probe() {
        return probe("bad-adapter")
      },
      createAdapter() {
        return adapter("different-host")
      },
    })
    .register({
      id: "bad-probe-shape",
      async probe() {
        return { hostId: "bad-probe-shape" } as AgentHostProbeResult
      },
    })

  await assert.rejects(
    registry.probe("bad-probe"),
    isCoreError({ code: "AGENT_HOST_PROBE_INVALID", status: 500 }),
  )
  await assert.rejects(
    registry.create("bad-adapter"),
    isCoreError({ code: "AGENT_HOST_ADAPTER_INVALID", status: 500 }),
  )
  await assert.rejects(
    registry.probe("bad-probe-shape"),
    isCoreError({ code: "AGENT_HOST_PROBE_INVALID", status: 500 }),
  )
})

test("registration validates callbacks before changing registry state", () => {
  const registry = new AgentHostRegistry()

  assert.throws(
    () =>
      registry.register({
        id: "missing-probe",
        probe: undefined as never,
      }),
    isCoreError({ code: "INVALID_AGENT_HOST_REGISTRATION", status: 400 }),
  )
  assert.throws(
    () =>
      registry.register({
        id: "bad-factory",
        async probe() {
          return probe("bad-factory")
        },
        createAdapter: "not-a-function" as never,
      }),
    isCoreError({ code: "INVALID_AGENT_HOST_REGISTRATION", status: 400 }),
  )
  assert.throws(
    () =>
      registry.register({
        id: "bad-aliases",
        aliases: "alias" as never,
        async probe() {
          return probe("bad-aliases")
        },
      }),
    isCoreError({ code: "INVALID_AGENT_HOST_REGISTRATION", status: 400 }),
  )
  assert.deepEqual(registry.list(), [])
})

test("validateAgentHostProbeResult rejects unknown top-level fields", () => {
  const valid = probe("test-host")
  const withExtra = { ...valid, vendorExtension: "smuggled" }
  assert.throws(
    () => validateAgentHostProbeResult(withExtra, "test-host"),
    isCoreError({ code: "AGENT_HOST_PROBE_INVALID", status: 500 }),
  )
})

test("validateAgentHostProbeResult rejects unknown issue fields", () => {
  const valid = probe("test-host")
  const withBadIssue = {
    ...valid,
    issues: [{ code: "x", message: "m", blocking: false, severity: "high" }],
  }
  assert.throws(
    () => validateAgentHostProbeResult(withBadIssue, "test-host"),
    isCoreError({ code: "AGENT_HOST_PROBE_INVALID", status: 500 }),
  )
})

test("validateAgentHostProbeResult rejects unknown capability keys", () => {
  const valid = probe("test-host")
  const withExtraCap = {
    ...valid,
    capabilities: {
      ...valid.capabilities,
      vendor_extension: "supported",
    },
  }
  assert.throws(
    () => validateAgentHostProbeResult(withExtraCap, "test-host"),
    isCoreError({ code: "AGENT_HOST_PROBE_INVALID", status: 500 }),
  )
})
