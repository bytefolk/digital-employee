import assert from "node:assert/strict"
import test from "node:test"

import { MCP_CONFORMANCE_CODES } from "../../packages/core/src/mcp-conformance.js"
import {
  ENGINE_CAPABILITY_CODES,
  intersectEffectiveSurface,
  type DeclaredCapability,
} from "../../packages/engine/src/index.js"

function cap(
  kind: DeclaredCapability["kind"],
  id: string,
): DeclaredCapability {
  return { kind, id }
}

test("#300 AC-002: mcp_* public strings are unchanged", () => {
  for (const [key, value] of Object.entries(MCP_CONFORMANCE_CODES)) {
    assert.equal(
      ENGINE_CAPABILITY_CODES[key as keyof typeof MCP_CONFORMANCE_CODES],
      value,
      key,
    )
  }
  assert.equal(ENGINE_CAPABILITY_CODES.grantInvalid, "mcp_grant_invalid")
  assert.equal(
    ENGINE_CAPABILITY_CODES.wideningDenied,
    "capability_widening_denied",
  )
})

test("#300 AC-001: declared × Authority Scope is intersection-only", () => {
  const result = intersectEffectiveSurface({
    declared: [
      cap("mcp_tool", "Read"),
      cap("mcp_tool", "Grep"),
      cap("skill_tool", "lookup"),
      cap("network_mode", "deny"),
    ],
    authorityScope: {
      tools: { allow: ["Read", "Glob"], deny: ["Grep"] },
    },
  })
  assert.deepEqual(
    result.allow.map((item) => `${item.kind}:${item.id}`).sort(),
    ["mcp_tool:Read", "network_mode:deny"].sort(),
  )
  const deniedIds = result.deny.map((item) => item.capability.id).sort()
  assert.deepEqual(deniedIds, ["Grep", "lookup"].sort())
  assert.ok(!result.allow.some((item) => item.id === "Glob"))
  assert.equal(
    result.deny.find((item) => item.capability.id === "Grep")?.code,
    ENGINE_CAPABILITY_CODES.scopeDenied,
  )
  assert.equal(
    result.deny.find((item) => item.capability.id === "lookup")?.code,
    ENGINE_CAPABILITY_CODES.skillToolDenied,
  )
})

test("#300 AC-001: authority allowlist cannot widen undeclared tools", () => {
  const result = intersectEffectiveSurface({
    declared: [cap("mcp_tool", "Read")],
    authorityScope: {
      tools: { allow: ["Read", "Write", "Grep"] },
    },
  })
  assert.deepEqual(result.allow, [cap("mcp_tool", "Read")])
  assert.equal(result.deny.length, 0)
  assert.ok(!result.codes.includes(ENGINE_CAPABILITY_CODES.wideningDenied))
})

test("#300 AC-001: deny list wins over allow list", () => {
  const result = intersectEffectiveSurface({
    declared: [cap("mcp_tool", "Read")],
    authorityScope: {
      tools: { allow: ["Read"], deny: ["Read"] },
    },
  })
  assert.deepEqual(result.allow, [])
  assert.equal(result.deny[0]?.code, ENGINE_CAPABILITY_CODES.scopeDenied)
})

test("#300 same inputs yield the same allow/deny/codes", () => {
  const input = {
    declared: [
      cap("skill_tool", "b"),
      cap("mcp_tool", "Read"),
      cap("skill_tool", "a"),
    ],
    authorityScope: { tools: { allow: ["Read", "a"] } },
  }
  assert.deepEqual(
    intersectEffectiveSurface(input),
    intersectEffectiveSurface(input),
  )
})
