import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { Ajv2020 } from "ajv/dist/2020.js"

import { RuntimeComponentRegistry } from "../../packages/core/index.js"
import {
  PositionConnectorsError,
  validatePositionConnectors,
} from "../../packages/core/src/position-connectors.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

function vocabulary(ids: { channels?: string[]; sources?: string[] } = {}) {
  const registry = new RuntimeComponentRegistry()
  for (const id of ids.channels ?? ["console"]) {
    registry.register("channel", id, () => ({
      start() {},
      stop() {},
    }))
  }
  for (const id of ids.sources ?? ["filesystem"]) {
    registry.register("source", id, () => ({
      load() {
        return []
      },
    }))
  }
  return registry
}

function declaration(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: "position-connectors.v1",
    channels: [{ id: "console" }],
    sources: [{ id: "filesystem", env: { rootEnv: "FILESYSTEM_ROOT" } }],
    ...overrides,
  }
}

async function schemaValidator() {
  const schema = JSON.parse(
    await readFile(
      path.join(root, "configs", "position-connectors.schema.json"),
      "utf8",
    ),
  )
  return new Ajv2020({ allErrors: true, strict: false }).compile(schema)
}

test("#310 schema and validator accept a well-formed declaration", async () => {
  const validateSchema = await schemaValidator()
  const input = declaration()
  assert.equal(validateSchema(input), true, JSON.stringify(validateSchema.errors))
  assert.deepEqual(validatePositionConnectors(input, vocabulary()), {
    schemaVersion: "position-connectors.v1",
    channels: [{ id: "console" }],
    sources: [{ id: "filesystem", env: { rootEnv: "FILESYSTEM_ROOT" } }],
  })
})

test("#310 hostile declarations fail closed with stable codes", async () => {
  const validateSchema = await schemaValidator()
  const cases: Array<{ input: Record<string, unknown>; code: RegExp; schema?: boolean }> = [
    {
      input: declaration({ extra: true }),
      code: /position_connectors_unknown_field:manifest\.extra/,
    },
    {
      input: declaration({
        channels: [{ id: "../escape" }],
      }),
      code: /position_connectors_invalid_field:channels\[0\]\.id/,
    },
    {
      input: declaration({
        sources: [{ id: "filesystem", env: { token: "sk-live-secret" } }],
      }),
      code: /position_connectors_inline_credential:sources\[0\]\.env\.token/,
    },
    {
      input: declaration({
        sources: [{ id: "filesystem", env: { rootEnv: "../etc/passwd" } }],
      }),
      code: /position_connectors_inline_credential:sources\[0\]\.env\.rootEnv/,
    },
    {
      input: declaration({
        channels: [{ id: "console" }, { id: "console" }],
      }),
      code: /position_connectors_duplicate_id:channel:console/,
      schema: false,
    },
    {
      input: declaration({
        sources: [{ id: "mem" }],
      }),
      code: /position_connectors_unregistered:source:mem/,
      schema: false,
    },
  ]

  for (const fixture of cases) {
    if (fixture.schema !== false) {
      assert.equal(validateSchema(fixture.input), false, JSON.stringify(fixture.input))
    }
    assert.throws(
      () => validatePositionConnectors(fixture.input, vocabulary()),
      (error: unknown) =>
        error instanceof PositionConnectorsError && fixture.code.test(error.code),
    )
  }
})

test("#310 vocabulary is registry-driven, not a hard-coded list", () => {
  const input = declaration({
    sources: [{ id: "mem" }],
  })
  assert.throws(
    () => validatePositionConnectors(input, vocabulary()),
    (error: unknown) =>
      error instanceof PositionConnectorsError &&
      error.code === "position_connectors_unregistered:source:mem",
  )
  const accepted = validatePositionConnectors(
    input,
    vocabulary({ sources: ["filesystem", "mem"] }),
  )
  assert.deepEqual(accepted.sources, [{ id: "mem" }])
})
