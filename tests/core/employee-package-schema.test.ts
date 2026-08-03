import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { Ajv2020 } from "ajv/dist/2020.js"

import { validateEmployeePackageManifest } from "../../packages/core/index.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

function manifest(): Record<string, any> {
  return {
    schemaVersion: "employee-package.v1alpha1",
    name: "team-answer",
    version: "0.1.0",
    description: "Answers team questions.",
    license: "Apache-2.0",
    authors: ["team"],
    host: { protocol: "agent-host.v1", requiredCapabilities: [] },
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

async function schemaValidator() {
  const schema = JSON.parse(
    await readFile(path.join(root, "configs", "employee-package.schema.json"), "utf8"),
  )
  return new Ajv2020({ allErrors: true, strict: false }).compile(schema)
}

test("public package Schema and semantic validator accept the scaffold shape", async () => {
  const validateSchema = await schemaValidator()
  const input = manifest()
  assert.equal(validateSchema(input), true, JSON.stringify(validateSchema.errors))
  assert.doesNotThrow(() => validateEmployeePackageManifest(input))
})

test("public package Schema and semantic validator reject unsafe cross-field cases", async () => {
  const validateSchema = await schemaValidator()
  const fixtures = [
    (() => {
      const input = manifest()
      input.policy.filesystem.write = ["./output/**"]
      return input
    })(),
    (() => {
      const input = manifest()
      input.policy.mcpTools = [
        { name: "drive.delete", requestedMode: "write" },
      ]
      return input
    })(),
    (() => {
      const input = manifest()
      input.assets = ["./../outside.md"]
      return input
    })(),
    (() => {
      const input = manifest()
      input.name = "not_portable"
      return input
    })(),
    (() => {
      const input = manifest()
      input.entrypoints.inputSchema = "./schemas/*.json"
      return input
    })(),
  ]

  for (const input of fixtures) {
    assert.equal(validateSchema(input), false)
    assert.throws(() => validateEmployeePackageManifest(input))
  }
})
