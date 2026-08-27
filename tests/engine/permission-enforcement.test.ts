import assert from "node:assert/strict"
import test from "node:test"

import {
  createPermissionGate,
  effectiveMode,
  ORG_PERMISSIONS_SCHEMA_VERSION,
  type OrganizationPermissions,
} from "../../packages/engine/src/index.js"

/**
 * #159 R3 runtime-enforcement fixtures (AC-004..AC-007). Deterministic,
 * model-free: the gate consumes a synthetic org-permissions.v1 artifact and
 * must fail closed with stable codes + redirectTo, recording denial attempts
 * that carry zero content from the denied resource.
 */

function artifact(): OrganizationPermissions {
  return {
    schemaVersion: ORG_PERMISSIONS_SCHEMA_VERSION,
    business: "oss",
    owner: "repo-owner",
    positions: {
      "repo-owner": {
        position: "repo-owner",
        tier: "owner",
        mode: "read_only",
        contextScope: { read: ["./"] },
        authorityScope: {
          writes: "deny",
          tools: { allow: ["Read", "Grep", "Glob"], deny: [] },
          delegation: { allow: true, targets: ["issue-researcher"], escalateTo: null },
        },
      },
      "issue-researcher": {
        position: "issue-researcher",
        tier: "worker",
        mode: "read_only",
        contextScope: {
          read: ["./positions/repo-owner/issue-researcher/", "./context/"],
        },
        authorityScope: {
          writes: "deny",
          tools: { allow: ["Read", "Grep"], deny: ["Glob"] },
          delegation: { allow: false, targets: [], escalateTo: "repo-owner" },
        },
      },
    },
  }
}

test("AC-004: out-of-scope context read denied before grant, with redirect", () => {
  const gate = createPermissionGate(artifact())
  // Worker reading its own subtree is allowed.
  const allowed = gate.evaluateContextRead(
    "issue-researcher",
    "./positions/repo-owner/issue-researcher/notes.md",
  )
  assert.equal(allowed.status, "allowed")
  // Worker reading an owner-only path is denied with redirect to owner.
  const denied = gate.evaluateContextRead(
    "issue-researcher",
    "./positions/repo-owner/secrets.md",
  )
  assert.equal(denied.status, "denied")
  if (denied.status === "denied") {
    assert.equal(denied.code, "workspace_org_context_denied")
    assert.equal(denied.redirectTo, "repo-owner")
  }
  // Owner sees the whole workspace.
  assert.equal(
    gate.evaluateContextRead("repo-owner", "./positions/repo-owner/secrets.md").status,
    "allowed",
  )
})

test("AC-004: traversal/absolute paths fail closed", () => {
  const gate = createPermissionGate(artifact())
  for (const bad of [
    "../positions/repo-owner/secrets.md",
    "/etc/passwd",
    "C:\\Windows\\System32",
    "./positions/repo-owner/../../secrets.md",
  ]) {
    const decision = gate.evaluateContextRead("issue-researcher", bad)
    assert.equal(decision.status, "denied", `expected deny for ${bad}`)
  }
})

test("AC-005: non-allowlisted tool denied at dispatch; writes default-deny", () => {
  const gate = createPermissionGate(artifact())
  // Worker may Read but not Glob (denied in its authority scope).
  assert.equal(gate.evaluateToolCall("issue-researcher", "Read").status, "allowed")
  const deniedGlob = gate.evaluateToolCall("issue-researcher", "Glob")
  assert.equal(deniedGlob.status, "denied")
  if (deniedGlob.status === "denied") {
    assert.equal(deniedGlob.code, "workspace_org_authority_denied")
    assert.equal(deniedGlob.redirectTo, "repo-owner")
  }
  // A write-capable tool is default-deny for every tier (first release).
  const writeDenied = gate.evaluateToolCall("repo-owner", "Write")
  assert.equal(writeDenied.status, "denied")
  if (writeDenied.status === "denied") {
    assert.equal(writeDenied.code, "workspace_org_authority_denied")
  }
})

test("AC-006: unknown position fails before spawn", () => {
  const gate = createPermissionGate(artifact())
  const result = gate.checkPosition("ghost-position")
  assert.equal(result.ok, false)
  assert.equal(result.unknown, "ghost-position")
  assert.equal(gate.checkPosition("repo-owner").ok, true)
})

test("AC-007: denial attempts carry zero resource content; repeats do not escalate", () => {
  const gate = createPermissionGate(artifact())
  const secretContent = "SUPER_SECRET_PAYLOAD_must_never_appear"
  // The requested argument is a path/tool name only; the denied resource's
  // content is never passed to the gate, so it can never leak into evidence.
  gate.evaluateContextRead("issue-researcher", "./positions/repo-owner/a.md")
  gate.evaluateContextRead("issue-researcher", "./positions/repo-owner/b.md")
  gate.evaluateToolCall("issue-researcher", "Glob")

  const attempts = gate.denialAttempts()
  assert.equal(attempts.length, 3)
  const serialized = JSON.stringify(attempts)
  assert.equal(serialized.includes(secretContent), false)
  for (const attempt of attempts) {
    assert.equal(typeof attempt.requested, "string")
    assert.equal(attempt.redirectTo, "repo-owner")
    assert.ok(
      attempt.code === "workspace_org_context_denied" ||
        attempt.code === "workspace_org_authority_denied",
    )
  }
  // Repeated denials do not escalate: no escalation field, no retry signal.
  const summary = gate.summary()
  assert.equal(summary.denyCount, 3)
  assert.equal(summary.allowCount, 0)
  assert.deepEqual(summary.redirectToTargets, ["repo-owner"])
})

test("AC-011: absent mode defaults to read_only; read_only stays scope-only", () => {
  const perms = artifact()
  delete perms.positions["issue-researcher"]!.mode
  const gate = createPermissionGate(perms)
  // Mode defaults to read_only: read actions remain scope-only and the gate
  // has no approval surface (no approval events are ever produced here).
  assert.equal(effectiveMode(perms.positions["issue-researcher"]!), "read_only")
  assert.equal(
    gate.evaluateContextRead("issue-researcher", "./context/shared.md").status,
    "allowed",
  )
})
