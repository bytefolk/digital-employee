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

function identityManifest(): Record<string, any> {
  const input = manifest()
  input.identity = {
    displayName: "Answer Bot",
    avatar: { asset: "./knowledge/README.md" },
    persona: "Helpful teammate for answer triage.",
    roleId: "team-answer",
  }
  return input
}

test("public package Schema and validator accept the identity segment (#194)", async () => {
  const validateSchema = await schemaValidator()

  const full = identityManifest()
  assert.equal(validateSchema(full), true, JSON.stringify(validateSchema.errors))
  assert.doesNotThrow(() => validateEmployeePackageManifest(full))

  // Additive extension point: unknown identity keys are accepted by both
  // surfaces; only the semantic validator collects the warning.
  const additive = identityManifest()
  additive.identity.pronouns = "they/them"
  assert.equal(
    validateSchema(additive),
    true,
    JSON.stringify(validateSchema.errors),
  )
  const warnings: string[] = []
  assert.doesNotThrow(() =>
    validateEmployeePackageManifest(additive, warnings),
  )
  assert.deepEqual(warnings, [
    "employee_package_identity_unknown_field:pronouns",
  ])
})

test("public package Schema and validator reject identity violations (#194)", async () => {
  const validateSchema = await schemaValidator()
  const fixtures = [
    (() => {
      const input = identityManifest()
      delete input.identity.displayName
      return input
    })(),
    (() => {
      const input = identityManifest()
      input.identity.displayName = ""
      return input
    })(),
    (() => {
      const input = identityManifest()
      input.identity.displayName = "x".repeat(65)
      return input
    })(),
    (() => {
      const input = identityManifest()
      input.identity.persona = "x".repeat(2_049)
      return input
    })(),
    (() => {
      const input = identityManifest()
      input.identity.roleId = "Team-Answer"
      return input
    })(),
    (() => {
      const input = identityManifest()
      input.identity.avatar = {
        asset: "./knowledge/README.md",
        url: "https://cdn.example/avatar.png",
      }
      return input
    })(),
    (() => {
      const input = identityManifest()
      input.identity.reportTo = "manager-1"
      return input
    })(),
  ]

  for (const input of fixtures) {
    assert.equal(validateSchema(input), false, JSON.stringify(input.identity))
    assert.throws(() => validateEmployeePackageManifest(input))
  }
})
