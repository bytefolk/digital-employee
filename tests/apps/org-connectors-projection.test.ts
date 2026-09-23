import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { Ajv2020 } from "ajv/dist/2020.js"

import {
  buildAppliedOrganization,
  type PositionDeclaration,
} from "../../apps/cli/org/model.js"
import {
  buildWorkspaceOrgSchema,
  validateOrganizationDocument,
  type ValidatedOrganizationDocument,
} from "../../apps/cli/org/budget.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

function baseRole(): ValidatedOrganizationDocument["roles"][number] {
  return {
    id: "repo-owner",
    name: "owner",
    description: "owner",
    reportTo: null,
    package: {
      name: "owner",
      version: "1.0.0",
      digest: `sha256:${"ab".repeat(32)}`,
      localReference: "./positions/repo-owner",
    },
    mode: "read_only",
    memoryScope: "./",
    toolAllow: [],
    toolDeny: [],
    metadata: {},
    budget: { perTask: { tokens: 1 }, perDay: { tokens: 1 } },
  }
}

function document(
  roles: ValidatedOrganizationDocument["roles"],
): ValidatedOrganizationDocument {
  return {
    schemaVersion: "workspace-org.v1",
    business: "oss",
    description: "org",
    owner: "repo-owner",
    roles,
    updatedAt: "2026-09-23T00:00:00.000Z",
  }
}

test("#311 AC-002: unknown connectors keys fail closed", () => {
  const role = {
    ...baseRole(),
    connectors: {
      schemaVersion: "position-connectors.v1",
      digest: `sha256:${"cd".repeat(32)}`,
      channels: [],
      sources: [],
      extra: true,
    },
  }
  assert.throws(
    () => validateOrganizationDocument(document([role as never])),
    /workspace_org_document_invalid:role_0_connectors_unknown_key/,
  )
})

test("#311 AC-001: absent connectors are omitted from the derived role", () => {
  const current = document([baseRole()])
  const declaration = {
    position: {
      id: "repo-owner",
      directory: "./positions/repo-owner",
      reportTo: null,
    },
    manifest: { name: "owner", version: "1.0.0", description: "owner", policy: { mode: "read_only" } },
    budget: { perTask: { tokens: 1 }, perDay: { tokens: 1 } },
    digest: `sha256:${"ab".repeat(32)}`,
  } as unknown as PositionDeclaration
  const applied = buildAppliedOrganization(current, [declaration], current.updatedAt)
  assert.equal(Object.hasOwn(applied.roles[0]!, "connectors"), false)
  validateOrganizationDocument(applied)
})

test("#311 AC-001: present connectors are carried with a digest", () => {
  const current = document([baseRole()])
  const connectors = {
    schemaVersion: "position-connectors.v1" as const,
    channels: [{ id: "console" }],
    sources: [{ id: "filesystem", env: { rootEnv: "FILESYSTEM_ROOT" } }],
  }
  const declaration = {
    position: {
      id: "repo-owner",
      directory: "./positions/repo-owner",
      reportTo: null,
    },
    manifest: { name: "owner", version: "1.0.0", description: "owner", policy: { mode: "read_only" } },
    budget: { perTask: { tokens: 1 }, perDay: { tokens: 1 } },
    digest: `sha256:${"ab".repeat(32)}`,
    connectors,
  } as unknown as PositionDeclaration
  const applied = buildAppliedOrganization(current, [declaration], current.updatedAt)
  const projected = applied.roles[0]!.connectors
  assert.ok(projected)
  assert.equal(projected.schemaVersion, "position-connectors.v1")
  assert.match(projected.digest, /^sha256:[a-f0-9]{64}$/)
  assert.deepEqual(projected.channels, connectors.channels)
  assert.deepEqual(projected.sources, connectors.sources)
  validateOrganizationDocument(applied)
})

test("#311 AC-002: documents without connectors still match the revised schema", async () => {
  const schema = JSON.parse(
    await readFile(path.join(root, "configs", "workspace-org.schema.json"), "utf8"),
  )
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema)
  const instance = document([baseRole()])
  assert.equal(validate(instance), true, JSON.stringify(validate.errors))
  assert.equal(
    `${JSON.stringify(buildWorkspaceOrgSchema(), null, 2)}\n`,
    await readFile(path.join(root, "configs", "workspace-org.schema.json"), "utf8"),
  )
})
