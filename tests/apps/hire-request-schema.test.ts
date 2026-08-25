import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  HIRE_REQUEST_SCHEMA_ID,
  buildHireRequestSchema,
} from "../../packages/core/index.js"

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
)
const publishedSchemaPath = path.join(
  packageRoot,
  "configs",
  "hire-request.schema.json",
)

test("published hire-request.schema.json matches the code-side builder", async () => {
  const published = await readFile(publishedSchemaPath, "utf8")
  assert.equal(
    published,
    `${JSON.stringify(buildHireRequestSchema(), null, 2)}\n`,
  )
})

test("hire-request schema carries the frozen contract shape (#194)", () => {
  const schema = buildHireRequestSchema() as Record<string, any>
  assert.equal(schema.$id, HIRE_REQUEST_SCHEMA_ID)
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.required, [
    "schemaVersion",
    "workspaceRef",
    "packageRef",
    "targetParentId",
    "budget",
    "requestedBy",
    "envelopeDigest",
  ])
  assert.equal(schema.properties.schemaVersion.const, "hire-request.v1alpha1")
  assert.equal(schema.properties.packageRef.additionalProperties, false)
  assert.deepEqual(schema.properties.packageRef.required, [
    "name",
    "version",
    "digest",
  ])
  assert.deepEqual(schema.properties.budget.required, ["perTask", "perDay"])
  assert.equal(schema.properties.envelopeDigest.minLength, 16)
  assert.ok(schema.$defs.budgetScope)
})
