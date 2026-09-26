import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { Ajv2020 } from "ajv/dist/2020.js"

import { validateCapabilityMarketManifest } from "../../packages/core/index.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

async function loadMarket(): Promise<unknown> {
  return JSON.parse(
    await readFile(path.join(root, "capabilities", "market.json"), "utf8"),
  )
}

test("public capability market Schema compiles and accepts a minimal MCP entry", async () => {
  const schema = JSON.parse(
    await readFile(path.join(root, "configs", "capability-market.schema.json"), "utf8"),
  )
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema)
  const input = {
    schemaVersion: "capability-market.v1alpha1",
    capabilities: [
      {
        id: "playwright",
        kind: "mcp",
        title: "Playwright",
        description: "Browser automation",
        risk: "high",
        auth: { required: [], optional: [] },
        network: { required: true, hosts: [] },
        transport: { type: "stdio", command: "npx", args: ["@playwright/mcp@latest"] },
      },
    ],
  }
  assert.equal(validate(input), true, JSON.stringify(validate.errors))
  assert.doesNotThrow(() => validateCapabilityMarketManifest(input))
})

test("shipped market.json is valid and non-empty", async () => {
  const manifest = validateCapabilityMarketManifest(await loadMarket())
  assert.ok(manifest.capabilities.length > 0)
  const ids = manifest.capabilities.map((capability) => capability.id)
  assert.equal(new Set(ids).size, ids.length, "capability ids must be unique")
  assert.deepEqual(
    new Set(manifest.capabilities.map((capability) => capability.kind)),
    new Set(["mcp", "cli"]),
  )
})

test("every mcp capability carries a transport and egress metadata", async () => {
  const manifest = validateCapabilityMarketManifest(await loadMarket())
  for (const capability of manifest.capabilities) {
    if (capability.kind === "mcp") {
      assert.ok(capability.transport, `mcp ${capability.id} needs a transport`)
    }
    assert.equal(typeof capability.network.required, "boolean")
    assert.equal(typeof capability.risk, "string")
  }
})

test("rejects unknown fields", () => {
  assert.throws(
    () =>
      validateCapabilityMarketManifest({
        schemaVersion: "capability-market.v1alpha1",
        capabilities: [
          {
            id: "x",
            kind: "mcp",
            title: "X",
            description: "y",
            risk: "low",
            auth: { required: [], optional: [] },
            network: { required: false, hosts: [] },
            transport: { type: "stdio", command: "npx" },
            surprise: true,
          },
        ],
      }),
    /capability_market_unknown_field/,
  )
})

test("rejects duplicate capability ids", () => {
  const entry = {
    id: "dup",
    kind: "mcp",
    title: "D",
    description: "d",
    risk: "low",
    auth: { required: [], optional: [] },
    network: { required: false, hosts: [] },
    transport: { type: "stdio", command: "npx" },
  }
  assert.throws(
    () =>
      validateCapabilityMarketManifest({
        schemaVersion: "capability-market.v1alpha1",
        capabilities: [entry, entry],
      }),
    /capability_market_duplicate_id/,
  )
})

test("rejects conflicting shapes and missing kind-specific fields", () => {
  assert.throws(
    () =>
      validateCapabilityMarketManifest({
        schemaVersion: "capability-market.v1alpha1",
        capabilities: [
          {
            id: "mcp-without-transport",
            kind: "mcp",
            title: "T",
            description: "d",
            risk: "low",
            auth: { required: [], optional: [] },
            network: { required: false, hosts: [] },
          },
        ],
      }),
    /capability_market_missing_field/,
  )
  assert.throws(
    () =>
      validateCapabilityMarketManifest({
        schemaVersion: "capability-market.v1alpha1",
        capabilities: [
          {
            id: "both",
            kind: "mcp",
            title: "T",
            description: "d",
            risk: "low",
            auth: { required: [], optional: [] },
            network: { required: false, hosts: [] },
            transport: { type: "stdio", command: "npx" },
            command: { command: "npx" },
          },
        ],
      }),
    /capability_market_conflicting_shape/,
  )
})

test("rejects non-HTTPS transport URLs and lowercase env names", () => {
  assert.throws(
    () =>
      validateCapabilityMarketManifest({
        schemaVersion: "capability-market.v1alpha1",
        capabilities: [
          {
            id: "http-mcp",
            kind: "mcp",
            title: "T",
            description: "d",
            risk: "low",
            auth: { required: [], optional: [] },
            network: { required: true, hosts: [] },
            transport: { type: "http", url: "http://insecure.example.test" },
          },
        ],
      }),
    /capability_market_invalid_field/,
  )
  assert.throws(
    () =>
      validateCapabilityMarketManifest({
        schemaVersion: "capability-market.v1alpha1",
        capabilities: [
          {
            id: "bad-env",
            kind: "mcp",
            title: "T",
            description: "d",
            risk: "low",
            auth: { required: ["lowercase"], optional: [] },
            network: { required: false, hosts: [] },
            transport: { type: "stdio", command: "npx" },
          },
        ],
      }),
    /capability_market_invalid_field/,
  )
})