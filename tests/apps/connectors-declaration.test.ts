import assert from "node:assert/strict"
import test from "node:test"

import { createBuiltInRegistry } from "../../apps/cli/registry.js"
import { validatePositionConnectorsDeclaration } from "../../apps/cli/org/connectors-declaration.js"

test("position-connectors.v1 accepts registry ids and env-name indirection (#310)", async () => {
  const registry = await createBuiltInRegistry()
  const declared = validatePositionConnectorsDeclaration(
    {
      schemaVersion: "position-connectors.v1",
      sources: [{ id: "filesystem", env: "FILESYSTEM_ROOT" }],
      channels: [{ id: "console" }],
    },
    registry,
  )
  assert.equal(declared.sources?.[0]?.id, "filesystem")
  assert.equal(declared.channels?.[0]?.id, "console")
})

test("position-connectors.v1 rejects unregistered ids, credentials, traversal, unknown fields (#310)", async () => {
  const registry = await createBuiltInRegistry()
  const hostile = [
    { schemaVersion: "position-connectors.v1", sources: [{ id: "mem" }] },
    { schemaVersion: "position-connectors.v1", sources: [{ id: "filesystem", apiKey: "sk-live" }] },
    { schemaVersion: "position-connectors.v1", sources: [{ id: "../escape" }] },
    { schemaVersion: "position-connectors.v1", extra: true },
  ]
  for (const input of hostile) {
    assert.throws(
      () => validatePositionConnectorsDeclaration(input, registry),
      TypeError,
    )
  }
})

test("registering a connector id makes it declarable without changing validator code (#310 AC-003)", async () => {
  const registry = await createBuiltInRegistry()
  assert.throws(
    () =>
      validatePositionConnectorsDeclaration(
        { schemaVersion: "position-connectors.v1", sources: [{ id: "custom-source" }] },
        registry,
      ),
    /workspace_org_connectors_unregistered:source:custom-source/,
  )
  registry.register("source", "custom-source", () => ({ id: "custom-source" }) as never)
  const declared = validatePositionConnectorsDeclaration(
    { schemaVersion: "position-connectors.v1", sources: [{ id: "custom-source" }] },
    registry,
  )
  assert.equal(declared.sources?.[0]?.id, "custom-source")
})
