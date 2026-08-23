/**
 * Permission boundary derivation tests (#159, R2).
 *
 * Requirement trace:
 *   https://github.com/fullstack-ai-infra/digital-employee/issues/159
 *   AC-001: allowlist derivation — owner vs worker tool sets differ as
 *           specified (context breadth + delegation).
 *   AC-002: worker asking owner-only/secret info is rejected with a
 *           redirect to the owner.
 *   AC-003: write operations are default-deny in the first release.
 *   REQ-002: the owner never inherits subordinate permissions.
 */

import assert from "node:assert/strict"
import test from "node:test"

import type { ValidatedOrganizationDocument } from "../../apps/cli/org/budget.js"
import {
  deriveOrganizationPermissions,
  evaluateContextAccess,
  evaluateToolAuthority,
  normalizeContextPath,
  positionDirectorySegments,
} from "../../apps/cli/org/permissions.js"

const DIGEST = `sha256:${"a".repeat(64)}`

function makeRole(overrides: {
  id: string
  reportTo: string | null
  toolAllow?: string[]
  toolDeny?: string[]
}): ValidatedOrganizationDocument["roles"][number] {
  return {
    id: overrides.id,
    name: overrides.id,
    description: `position ${overrides.id}`,
    reportTo: overrides.reportTo,
    package: {
      name: overrides.id,
      version: "0.1.0",
      digest: DIGEST,
      localReference: `/tmp/oss/positions/${overrides.id}`,
    },
    mode: "read_only",
    memoryScope: "/",
    toolAllow: overrides.toolAllow ?? ["Read", "Grep", "Glob"],
    toolDeny: overrides.toolDeny ?? [],
    metadata: {},
    budget: {
      perTask: { tokens: 1_000 },
      perDay: { tokens: 10_000 },
    },
  }
}

function makeDocument(
  roles: ValidatedOrganizationDocument["roles"],
  owner = "repo-owner",
): ValidatedOrganizationDocument {
  return {
    schemaVersion: "workspace-org.v1",
    business: "oss",
    description: "test organization",
    owner,
    roles,
    updatedAt: "2026-08-23T00:00:00.000Z",
  }
}

const BASE_MODEL = makeDocument([
  makeRole({ id: "repo-owner", reportTo: null }),
  makeRole({ id: "issue-researcher", reportTo: "repo-owner" }),
])

test("AC-001: owner and worker tiers differ in context breadth and delegation", () => {
  const permissions = deriveOrganizationPermissions(BASE_MODEL)
  const owner = permissions.positions["repo-owner"]!
  const worker = permissions.positions["issue-researcher"]!
  assert.equal(owner.tier, "owner")
  assert.equal(worker.tier, "worker")
  assert.deepEqual(owner.contextScope.read, ["./"])
  assert.deepEqual(worker.contextScope.read, [
    "./positions/repo-owner/issue-researcher/",
    "./context/",
  ])
  assert.equal(owner.authorityScope.delegation.allow, true)
  assert.deepEqual(owner.authorityScope.delegation.targets, ["issue-researcher"])
  assert.equal(worker.authorityScope.delegation.allow, false)
  assert.equal(worker.authorityScope.delegation.escalateTo, "repo-owner")
  assert.notDeepEqual(owner.contextScope, worker.contextScope)
})

test("AC-003: write-capable tools are default-deny for every tier", () => {
  const model = makeDocument([
    makeRole({ id: "repo-owner", reportTo: null, toolAllow: ["Read", "Write", "Bash"] }),
    makeRole({
      id: "issue-researcher",
      reportTo: "repo-owner",
      toolAllow: ["Read", "Write", "Edit"],
    }),
  ])
  const permissions = deriveOrganizationPermissions(model)
  for (const position of ["repo-owner", "issue-researcher"]) {
    const scope = permissions.positions[position]!.authorityScope
    assert.equal(scope.writes, "deny")
    assert.deepEqual(scope.tools.allow, ["Read"], `allowlist for ${position}`)
  }
})

test("REQ-002: the owner does not inherit subordinate tool declarations", () => {
  const model = makeDocument([
    makeRole({ id: "repo-owner", reportTo: null, toolAllow: ["Read"] }),
    makeRole({
      id: "issue-researcher",
      reportTo: "repo-owner",
      toolAllow: ["Read", "Grep", "Glob"],
    }),
  ])
  const permissions = deriveOrganizationPermissions(model)
  assert.deepEqual(
    permissions.positions["repo-owner"]!.authorityScope.tools.allow,
    ["Read"],
  )
  assert.deepEqual(
    permissions.positions["issue-researcher"]!.authorityScope.tools.allow,
    ["Read", "Grep", "Glob"],
  )
})

test("an empty tool declaration falls back to the tier read allowlist; toolDeny wins", () => {
  const model = makeDocument([
    makeRole({ id: "repo-owner", reportTo: null, toolAllow: [] }),
    makeRole({
      id: "issue-researcher",
      reportTo: "repo-owner",
      toolAllow: ["Read", "Grep"],
      toolDeny: ["Grep"],
    }),
  ])
  const permissions = deriveOrganizationPermissions(model)
  assert.deepEqual(
    permissions.positions["repo-owner"]!.authorityScope.tools.allow,
    ["Read", "Grep", "Glob"],
  )
  assert.deepEqual(
    permissions.positions["issue-researcher"]!.authorityScope.tools.allow,
    ["Read"],
  )
  assert.deepEqual(
    permissions.positions["issue-researcher"]!.authorityScope.tools.deny,
    ["Grep"],
  )
})

test("evaluateToolAuthority rejects out-of-scope tools with a redirect to the owner", () => {
  const permissions = deriveOrganizationPermissions(BASE_MODEL)
  assert.deepEqual(
    evaluateToolAuthority(permissions, "issue-researcher", "Read"),
    { status: "allowed" },
  )
  assert.deepEqual(
    evaluateToolAuthority(permissions, "issue-researcher", "Write"),
    {
      status: "denied",
      code: "workspace_org_authority_denied",
      redirectTo: "repo-owner",
    },
  )
  assert.deepEqual(
    evaluateToolAuthority(permissions, "repo-owner", "Write"),
    {
      status: "denied",
      code: "workspace_org_authority_denied",
      redirectTo: "repo-owner",
    },
  )
  assert.throws(
    () => evaluateToolAuthority(permissions, "ghost", "Read"),
    (error: unknown) =>
      error instanceof TypeError &&
      error.message.startsWith("workspace_org_position_unknown"),
  )
})

test("evaluateContextAccess enforces the worker slice and the owner view", () => {
  const permissions = deriveOrganizationPermissions(BASE_MODEL)
  const allowed = [
    "./positions/repo-owner/issue-researcher/SKILL.md",
    "./positions/repo-owner/issue-researcher",
    "./context/README.md",
  ]
  for (const requested of allowed) {
    assert.deepEqual(
      evaluateContextAccess(permissions, "issue-researcher", requested),
      { status: "allowed" },
      requested,
    )
  }
  const denied = [
    "./positions/repo-owner/release-notes.md",
    "./positions/repo-owner",
    ".digital-employee/org.json",
    "./workspace.json",
  ]
  for (const requested of denied) {
    assert.deepEqual(
      evaluateContextAccess(permissions, "issue-researcher", requested),
      {
        status: "denied",
        code: "workspace_org_context_denied",
        redirectTo: "repo-owner",
      },
      requested,
    )
  }
  assert.deepEqual(
    evaluateContextAccess(permissions, "repo-owner", ".digital-employee/org.json"),
    { status: "allowed" },
  )
})

test("normalizeContextPath fails closed on traversal, absolute, and backslash paths", () => {
  assert.equal(normalizeContextPath("./a/b"), "./a/b")
  assert.equal(normalizeContextPath("a/b"), "./a/b")
  assert.equal(normalizeContextPath("./a/./b/"), "./a/b")
  assert.equal(normalizeContextPath("."), "./")
  for (const bad of ["../escape", "./a/../b", "/abs", "C:/windows", "a\\b", ""]) {
    assert.throws(
      () => normalizeContextPath(bad),
      (error: unknown) =>
        error instanceof TypeError &&
        error.message === "workspace_org_context_path_invalid",
      `expected rejection for ${JSON.stringify(bad)}`,
    )
  }
})

test("positionDirectorySegments resolves nested reporting chains", () => {
  const model = makeDocument([
    makeRole({ id: "repo-owner", reportTo: null }),
    makeRole({ id: "release-engineer", reportTo: "repo-owner" }),
    makeRole({ id: "community-operator", reportTo: "release-engineer" }),
  ])
  assert.deepEqual(positionDirectorySegments(model, "repo-owner"), ["repo-owner"])
  assert.deepEqual(positionDirectorySegments(model, "community-operator"), [
    "repo-owner",
    "release-engineer",
    "community-operator",
  ])
})
