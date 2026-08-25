import assert from "node:assert/strict"
import test from "node:test"

import {
  EMPLOYEE_PACKAGE_SCHEMA_VERSION,
  deriveEffectiveAgentHostPolicy,
  deriveEmployeeHostRequirements,
  validateEmployeePackageManifest,
} from "../../packages/core/index.js"

function manifest() {
  return {
    schemaVersion: EMPLOYEE_PACKAGE_SCHEMA_VERSION,
    name: "team-answer",
    version: "0.1.0",
    description: "Answers team questions.",
    license: "Apache-2.0",
    authors: ["team"],
    host: {
      protocol: "agent-host.v1",
      requiredCapabilities: [],
    },
    entrypoints: {
      skill: "./SKILL.md",
      inputSchema: "./schemas/input.json",
      outputSchema: "./schemas/output.json",
    },
    policy: {
      mode: "read_only",
      network: "deny",
      filesystem: { read: ["./knowledge/**"], write: [] },
      mcpTools: [],
    },
    assets: ["./knowledge/README.md"],
  }
}

test("portable employee package manifest is normalized and frozen", () => {
  const result = validateEmployeePackageManifest(manifest())
  assert.equal(result.schemaVersion, "employee-package.v1alpha1")
  assert.equal(result.host.protocol, "agent-host.v1")
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.policy.filesystem), true)
})

test("effective host requirements are derived from security policy", () => {
  const result = validateEmployeePackageManifest(manifest())
  assert.deepEqual(deriveEmployeeHostRequirements(result), {
    requiredCapabilities: [
      "tool_allowlist",
      "filesystem_scope",
      "network_policy",
    ],
  })
})

test("approval-required packages still require a real tool allowlist", () => {
  const input = manifest()
  input.policy.mode = "approval_required"
  const writePaths = input.policy.filesystem.write as string[]
  writePaths.push("./output/**")
  const result = validateEmployeePackageManifest(input)

  assert.deepEqual(deriveEmployeeHostRequirements(result), {
    requiredCapabilities: [
      "tool_allowlist",
      "filesystem_scope",
      "network_policy",
      "approval_callback",
    ],
  })
})

test("effective host policy is deny-by-default and preserves path grants", () => {
  const result = validateEmployeePackageManifest(manifest())
  assert.deepEqual(deriveEffectiveAgentHostPolicy(result), {
    tools: {
      default: "deny",
      allow: [
        { name: "filesystem.read", mode: "read" },
        { name: "filesystem.search", mode: "read" },
      ],
    },
    filesystem: { read: ["./knowledge/**"], write: [] },
    network: { mode: "deny" },
    approval: { mode: "never" },
  })
})

test("employee package rejects capabilities outside the host protocol", () => {
  const input = manifest()
  const capabilities = input.host.requiredCapabilities as string[]
  capabilities.push("vendor_magic")
  assert.throws(
    () => validateEmployeePackageManifest(input),
    /employee_package_unknown_host_capability:vendor_magic/,
  )
})

test("read-only employee package cannot request a write path", () => {
  const input = manifest()
  const writePaths = input.policy.filesystem.write as string[]
  writePaths.push("./output/**")
  assert.throws(
    () => validateEmployeePackageManifest(input),
    /read_only_employee_cannot_request_write_paths/,
  )
})

test("employee package rejects absolute and parent-traversing paths", () => {
  const absolute = manifest()
  absolute.entrypoints.skill = "/tmp/SKILL.md"
  assert.throws(
    () => validateEmployeePackageManifest(absolute),
    /employee_package_invalid_field:entrypoints.skill/,
  )

  const traversal = manifest()
  traversal.entrypoints.skill = "./agent/../../SKILL.md"
  assert.throws(
    () => validateEmployeePackageManifest(traversal),
    /employee_package_invalid_field:entrypoints.skill/,
  )

  const leadingTraversal = manifest()
  leadingTraversal.entrypoints.skill = "./../SKILL.md"
  assert.throws(
    () => validateEmployeePackageManifest(leadingTraversal),
    /employee_package_invalid_field:entrypoints.skill/,
  )

  const assetTraversal = manifest()
  assetTraversal.assets = ["./../outside.md"]
  assert.throws(
    () => validateEmployeePackageManifest(assetTraversal),
    /employee_package_invalid_field:assets\[0\]/,
  )

  const policyTraversal = manifest()
  policyTraversal.policy.filesystem.read = ["./../outside/**"]
  assert.throws(
    () => validateEmployeePackageManifest(policyTraversal),
    /employee_package_invalid_field:policy.filesystem.read\[0\]/,
  )
})

test("MCP declarations derive an MCP host requirement", () => {
  const input = manifest()
  Object.assign(input.entrypoints, { mcp: "./mcp.json" })
  const result = validateEmployeePackageManifest(input)
  assert.equal(
    deriveEmployeeHostRequirements(result).requiredCapabilities.includes("mcp"),
    true,
  )
})

test("read-only employee package rejects write-capable MCP tools", () => {
  const input = manifest()
  Object.assign(input.entrypoints, { mcp: "./mcp.json" })
  const tools = input.policy.mcpTools as Array<{
    name: string
    requestedMode: "read" | "write"
  }>
  tools.push({ name: "drive.delete", requestedMode: "write" })
  assert.throws(
    () => validateEmployeePackageManifest(input),
    /read_only_employee_cannot_request_write_mcp_tools/,
  )
})

test("employee and Skill identity follows the cross-host name subset", () => {
  for (const name of ["foo_bar", "foo--bar", "foo-", "a".repeat(65)]) {
    const input = manifest()
    input.name = name
    assert.throws(
      () => validateEmployeePackageManifest(input),
      /employee_package_invalid_field:name/,
    )
  }
})

test("entrypoint artifacts cannot use glob syntax", () => {
  const input = manifest()
  input.entrypoints.inputSchema = "./schemas/*.json"
  assert.throws(
    () => validateEmployeePackageManifest(input),
    /employee_package_invalid_field:entrypoints.inputSchema/,
  )
})

function identityManifest() {
  return {
    ...manifest(),
    identity: {
      displayName: "Answer Bot",
      avatar: { asset: "./knowledge/README.md" },
      persona: "Helpful teammate for answer triage.",
      roleId: "team-answer",
    },
  }
}

test("identity: packages without the segment validate exactly as before (#194)", () => {
  const result = validateEmployeePackageManifest(manifest())
  assert.equal(result.identity, undefined)
})

test("identity: full segment is accepted and frozen (AC-002, #194)", () => {
  const result = validateEmployeePackageManifest(identityManifest())
  assert.deepEqual(result.identity, {
    displayName: "Answer Bot",
    avatar: { asset: "./knowledge/README.md" },
    persona: "Helpful teammate for answer triage.",
    roleId: "team-answer",
  })
  assert.equal(Object.isFrozen(result.identity), true)
})

test("identity: displayName coexists with the machine name (#194)", () => {
  const result = validateEmployeePackageManifest(identityManifest())
  assert.equal(result.name, "team-answer")
  assert.equal(result.identity?.displayName, "Answer Bot")
})

test("identity: unknown extra fields are accepted with warnings (AC-002, #194)", () => {
  const input = identityManifest()
  ;(input.identity as Record<string, unknown>).pronouns = "they/them"
  const warnings: string[] = []
  const result = validateEmployeePackageManifest(input, warnings)
  assert.deepEqual(warnings, [
    "employee_package_identity_unknown_field:pronouns",
  ])
  assert.equal(
    (result.identity as Record<string, unknown>).pronouns,
    "they/them",
  )
})

test("identity: invalid displayName fails closed (#194)", () => {
  for (const displayName of ["", "   ", "x".repeat(65), 42]) {
    const input = identityManifest()
    input.identity.displayName = displayName as string
    assert.throws(
      () => validateEmployeePackageManifest(input),
      /employee_package_invalid_field:identity\.displayName/,
    )
  }
  const missing = identityManifest()
  delete (missing.identity as Record<string, unknown>).displayName
  assert.throws(
    () => validateEmployeePackageManifest(missing),
    /employee_package_invalid_field:identity\.displayName/,
  )
})

test("identity: invalid persona fails closed (#194)", () => {
  for (const persona of ["", "x".repeat(2_049)]) {
    const input = identityManifest()
    input.identity.persona = persona
    assert.throws(
      () => validateEmployeePackageManifest(input),
      /employee_package_invalid_field:identity\.persona/,
    )
  }
})

test("identity: invalid roleId fails closed (#194)", () => {
  for (const roleId of ["Team-Answer", "9lead", "role_id", "a".repeat(65)]) {
    const input = identityManifest()
    input.identity.roleId = roleId
    assert.throws(
      () => validateEmployeePackageManifest(input),
      /employee_package_invalid_field:identity\.roleId/,
    )
  }
})

test("identity: avatar is exactly { asset } with no URL channel (#194)", () => {
  const urlAvatar = identityManifest()
  ;(urlAvatar.identity.avatar as Record<string, unknown>).url =
    "https://cdn.example/avatar.png"
  assert.throws(
    () => validateEmployeePackageManifest(urlAvatar),
    /employee_package_unknown_field:identity\.avatar\.url/,
  )

  const emptyAvatar = identityManifest()
  ;(emptyAvatar.identity as Record<string, unknown>).avatar = {}
  assert.throws(
    () => validateEmployeePackageManifest(emptyAvatar),
    /employee_package_invalid_field:identity\.avatar\.asset/,
  )

  const absoluteAvatar = identityManifest()
  absoluteAvatar.identity.avatar = { asset: "/tmp/avatar.png" }
  assert.throws(
    () => validateEmployeePackageManifest(absoluteAvatar),
    /employee_package_invalid_field:identity\.avatar\.asset/,
  )
})

test("identity: avatar asset must be an entry in assets (#194)", () => {
  const input = identityManifest()
  input.identity.avatar = { asset: "./assets/missing.png" }
  assert.throws(
    () => validateEmployeePackageManifest(input),
    /employee_package_identity_avatar_asset_unknown/,
  )
})

test("identity: reportTo is rejected outright (#194)", () => {
  const input = identityManifest()
  ;(input.identity as Record<string, unknown>).reportTo = "manager-1"
  assert.throws(
    () => validateEmployeePackageManifest(input),
    /employee_package_unknown_field:identity\.reportTo/,
  )
})
