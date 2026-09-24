import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  loadMcpAllowlist,
  MCP_MANIFEST_DRIFT_CODE,
  MCP_RESTART_EXHAUSTED_CODE,
  MCP_RESTART_BUDGET,
  McpSupervisorError,
} from "../../packages/engine/src/mcp-supervisor.js"

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "fake-mcp-server.mjs",
)

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`
}

const manifest = {
  schemaVersion: "employee-mcp.v1alpha1",
  servers: [{ name: "fake", transport: { type: "stdio", command: "node" } }],
}

test("#301 AC-002: digest mismatch fails closed before spawn", async () => {
  await assert.rejects(
    () =>
      loadMcpAllowlist({
        declaredManifest: manifest,
        expectedDigest: digest({ other: true }),
        servers: [{ name: "fake", command: process.execPath, args: [fixture] }],
        declaredTools: ["Read"],
        authorityAllow: ["Read"],
      }),
    (error: unknown) =>
      error instanceof McpSupervisorError && error.code === MCP_MANIFEST_DRIFT_CODE,
  )
})

test("#301 AC-001: projected allowlist is declared ∩ Authority Scope", async () => {
  const result = await loadMcpAllowlist({
    declaredManifest: manifest,
    expectedDigest: digest(manifest),
    servers: [{ name: "fake", command: process.execPath, args: [fixture] }],
    declaredTools: ["Read", "Write"],
    authorityAllow: ["Read", "Grep"],
    env: { ...process.env, FAKE_MCP_TOOLS: "Read,Write,Secret" },
  })
  assert.deepEqual(result.allow, ["Read"])
  assert.equal(result.evidence.digest, digest(manifest))
  assert.equal(result.evidence.restartBudget, MCP_RESTART_BUDGET)
})

test("#301 AC-004: discovery extras never widen the allowlist", async () => {
  const result = await loadMcpAllowlist({
    declaredManifest: manifest,
    expectedDigest: digest(manifest),
    servers: [{ name: "fake", command: process.execPath, args: [fixture] }],
    declaredTools: ["Read"],
    authorityAllow: ["Read", "Secret"],
    env: { ...process.env, FAKE_MCP_TOOLS: "Read,Secret" },
  })
  assert.deepEqual(result.allow, ["Read"])
  assert.ok(!result.allow.includes("Secret"))
})

test("#301 AC-003: restart budget exhaustion fails closed", async () => {
  await assert.rejects(
    () =>
      loadMcpAllowlist({
        declaredManifest: manifest,
        expectedDigest: digest(manifest),
        servers: [{ name: "missing", command: "/nonexistent-mcp-server" }],
        declaredTools: ["Read"],
        authorityAllow: ["Read"],
      }),
    (error: unknown) =>
      error instanceof McpSupervisorError && error.code === MCP_RESTART_EXHAUSTED_CODE,
  )
})
