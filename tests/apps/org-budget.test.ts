/**
 * Organization budget contract tests (#157 REQ-001/REQ-006, AC-001/AC-006).
 *
 * Requirement trace:
 *   https://github.com/bytefolk/digital-employee/issues/157 (R3)
 *   AC-001: organization schema validates; malformed org (budget surface)
 *           fails closed.
 *   AC-006: a position without a budget declaration fails validation;
 *           per-task and per-day caps parse and validate.
 *
 * The schema-consistency block asserts the published
 * configs/workspace-org.schema.json is byte-identical to the code-side
 * builder and that the published schema and the code validator agree on the
 * same sample set.
 */

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  BUDGET_LIMIT_MAX,
  buildWorkspaceOrgSchema,
  WORKSPACE_ORG_SCHEMA_URL,
  validateOrganizationBudgets,
  validateOrganizationDocument,
  validatePositionBudget,
} from "../../apps/cli/org/budget.js"
import { buildOrgTreeSchema } from "../../apps/cli/org/model.js"
import {
  OSS_MAINTAINER_TEMPLATE,
  renderOrganizationFile,
} from "../../apps/cli/workspace/templates.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const publishedSchemaPath = path.join(root, "configs", "workspace-org.schema.json")
const publishedOrgTreeSchemaPath = path.join(root, "configs", "org-tree.schema.json")
const orgTreeFixturePath = path.join(
  root,
  "tests",
  "apps",
  "fixtures",
  "org-tree-oss-maintainer.json",
)

function failureCode(error: unknown): string {
  assert.ok(error instanceof TypeError)
  return error.message.split(":")[0]!
}

function validBaseBudget(): Record<string, unknown> {
  return {
    perTask: { tokens: 20_000, iterations: 8 },
    perDay: { tokens: 200_000, iterations: 64 },
  }
}

test("validatePositionBudget accepts a fully allocated budget and normalizes it", () => {
  const budget = validatePositionBudget("demo", validBaseBudget())
  assert.deepEqual(budget, {
    perTask: { tokens: 20_000, iterations: 8 },
    perDay: { tokens: 200_000, iterations: 64 },
  })
})

test("validatePositionBudget accepts a minimal fully allocated budget (one cap per scope)", () => {
  const budget = validatePositionBudget("demo", {
    perTask: { tokens: 1 },
    perDay: { iterations: 1 },
  })
  assert.deepEqual(budget, {
    perTask: { tokens: 1 },
    perDay: { iterations: 1 },
  })
})

test("validatePositionBudget accepts the BUDGET_LIMIT_MAX boundary", () => {
  const budget = validatePositionBudget("demo", {
    perTask: { tokens: BUDGET_LIMIT_MAX },
    perDay: { iterations: BUDGET_LIMIT_MAX },
  })
  assert.equal(budget.perTask.tokens, 1_000_000_000)
  assert.equal(budget.perDay.iterations, 1_000_000_000)
})

test("AC-006: missing/null budget -> workspace_org_budget_missing", () => {
  for (const value of [undefined, null]) {
    try {
      validatePositionBudget("demo", value)
      assert.fail("expected failure")
    } catch (error) {
      assert.equal(failureCode(error), "workspace_org_budget_missing")
    }
  }
})

test("AC-006: unallocated budgets -> workspace_org_budget_not_allocated", () => {
  const samples: unknown[] = [
    {},
    { perTask: { tokens: 1 } },
    { perDay: { tokens: 1 } },
    { perTask: {}, perDay: { tokens: 1 } },
    { perTask: { tokens: 1 }, perDay: {} },
    { perTask: {}, perDay: {} },
  ]
  for (const sample of samples) {
    try {
      validatePositionBudget("demo", sample)
      assert.fail(`expected failure for ${JSON.stringify(sample)}`)
    } catch (error) {
      assert.equal(
        failureCode(error),
        "workspace_org_budget_not_allocated",
        `sample ${JSON.stringify(sample)}`,
      )
    }
  }
})

test("AC-006: invalid caps -> workspace_org_budget_invalid", () => {
  const samples: unknown[] = [
    "budget",
    [validBaseBudget()],
    { perTask: { tokens: 0 }, perDay: { tokens: 1 } },
    { perTask: { tokens: -5 }, perDay: { tokens: 1 } },
    { perTask: { tokens: 1.5 }, perDay: { tokens: 1 } },
    { perTask: { tokens: "20000" }, perDay: { tokens: 1 } },
    { perTask: { tokens: true }, perDay: { tokens: 1 } },
    { perTask: { tokens: BUDGET_LIMIT_MAX + 1 }, perDay: { tokens: 1 } },
    { perTask: { tokens: 1 }, perDay: { tokens: 1 }, extra: {} },
    { perTask: { tokens: 1, cpu: 2 }, perDay: { tokens: 1 } },
    { perTask: "tokens", perDay: { tokens: 1 } },
    { perTask: null, perDay: { tokens: 1 } },
  ]
  for (const sample of samples) {
    try {
      validatePositionBudget("demo", sample)
      assert.fail(`expected failure for ${JSON.stringify(sample)}`)
    } catch (error) {
      assert.equal(
        failureCode(error),
        "workspace_org_budget_invalid",
        `sample ${JSON.stringify(sample)}`,
      )
    }
  }
})

test("validateOrganizationBudgets validates every position and reports the offending id", () => {
  const roles = [
    { id: "repo-owner", budget: validBaseBudget() },
    { id: "issue-researcher" },
  ]
  try {
    validateOrganizationBudgets(roles)
    assert.fail("expected failure")
  } catch (error) {
    assert.ok(error instanceof TypeError)
    assert.equal(error.message, "workspace_org_budget_missing:issue-researcher")
    // The stable machine code never echoes the position id.
    assert.equal(failureCode(error), "workspace_org_budget_missing")
  }
})

test("oss-maintainer template declares the V1 design budgets for all four positions", () => {
  const expected = {
    "repo-owner": {
      perTask: { tokens: 40_000, iterations: 12 },
      perDay: { tokens: 400_000, iterations: 96 },
    },
    "issue-researcher": {
      perTask: { tokens: 20_000, iterations: 8 },
      perDay: { tokens: 200_000, iterations: 64 },
    },
    "release-engineer": {
      perTask: { tokens: 20_000, iterations: 8 },
      perDay: { tokens: 200_000, iterations: 64 },
    },
    "community-operator": {
      perTask: { tokens: 20_000, iterations: 8 },
      perDay: { tokens: 200_000, iterations: 64 },
    },
  } as const
  assert.equal(OSS_MAINTAINER_TEMPLATE.roles.length, 4)
  for (const role of OSS_MAINTAINER_TEMPLATE.roles) {
    assert.deepEqual(
      role.budget,
      expected[role.id as keyof typeof expected],
      `budget for ${role.id}`,
    )
  }
  // The declared budgets are fully allocated per the contract.
  validateOrganizationBudgets(OSS_MAINTAINER_TEMPLATE.roles)
})

function renderedOrganization(): Record<string, unknown> {
  const digests: Record<string, { name: string; version: string; digest: string }> = {}
  for (const role of OSS_MAINTAINER_TEMPLATE.roles) {
    digests[role.id] = {
      name: role.id,
      version: "0.1.0",
      digest: `sha256:${"a".repeat(64)}`,
    }
  }
  const file = renderOrganizationFile(
    OSS_MAINTAINER_TEMPLATE,
    "oss",
    "/tmp/oss",
    digests,
    "2026-08-23T00:00:00.000Z",
  )
  return JSON.parse(Buffer.from(file.content).toString("utf8")) as Record<string, unknown>
}

test("renderOrganizationFile emits a budget for every role", () => {
  const organization = renderedOrganization()
  assert.equal(organization.$schema, WORKSPACE_ORG_SCHEMA_URL)
  const roles = organization.roles as Array<Record<string, unknown>>
  assert.equal(roles.length, 4)
  for (const role of roles) {
    assert.deepEqual(
      role.budget,
      OSS_MAINTAINER_TEMPLATE.roles.find((entry) => entry.id === role.id)!.budget,
    )
  }
  // The rendered document passes the code-side organization validator.
  validateOrganizationDocument(organization)
})

test("published workspace-org.schema.json matches the code-side builder", async () => {
  const published = await readFile(publishedSchemaPath, "utf8")
  assert.equal(published, `${JSON.stringify(buildWorkspaceOrgSchema(), null, 2)}\n`)
})

/**
 * Minimal draft 2020-12 evaluator covering exactly the keywords used by
 * configs/workspace-org.schema.json. Clean-room, dependency-free; used only
 * to assert published-schema vs code-validator agreement on the sample set.
 */
function evaluateSchema(
  schema: Record<string, unknown>,
  instance: unknown,
  rootSchema: Record<string, unknown>,
): boolean {
  if (typeof schema["$ref"] === "string") {
    const ref = schema["$ref"]
    assert.ok(ref.startsWith("#/$defs/"), `unsupported $ref ${ref}`)
    const target = (rootSchema["$defs"] as Record<string, unknown>)[
      ref.slice("#/$defs/".length)
    ] as Record<string, unknown>
    return evaluateSchema(target, instance, rootSchema)
  }
  if ("anyOf" in schema) {
    return (schema["anyOf"] as Array<Record<string, unknown>>).some((branch) =>
      evaluateSchema(branch, instance, rootSchema),
    )
  }
  if ("const" in schema && instance !== schema["const"]) return false
  if ("enum" in schema) {
    if (!(schema["enum"] as unknown[]).includes(instance)) return false
  }
  if ("type" in schema) {
    const types = Array.isArray(schema["type"])
      ? (schema["type"] as string[])
      : [schema["type"] as string]
    const matches = types.some((type) => {
      switch (type) {
        case "object":
          return (
            typeof instance === "object" && instance !== null && !Array.isArray(instance)
          )
        case "array":
          return Array.isArray(instance)
        case "string":
          return typeof instance === "string"
        case "integer":
          return typeof instance === "number" && Number.isInteger(instance)
        case "number":
          return typeof instance === "number"
        case "null":
          return instance === null
        case "boolean":
          return typeof instance === "boolean"
        default:
          throw new Error(`unsupported type keyword ${type}`)
      }
    })
    if (!matches) return false
  }
  if (typeof instance === "string") {
    if (typeof schema["minLength"] === "number" && instance.length < schema["minLength"]) {
      return false
    }
    if (typeof schema["maxLength"] === "number" && instance.length > schema["maxLength"]) {
      return false
    }
    if (typeof schema["pattern"] === "string") {
      if (!new RegExp(schema["pattern"]).test(instance)) return false
    }
  }
  if (typeof instance === "number") {
    if (
      typeof schema["exclusiveMinimum"] === "number" &&
      instance <= schema["exclusiveMinimum"]
    ) {
      return false
    }
    if (typeof schema["maximum"] === "number" && instance > schema["maximum"]) {
      return false
    }
  }
  if (Array.isArray(instance)) {
    if (typeof schema["minItems"] === "number" && instance.length < schema["minItems"]) {
      return false
    }
    const items = schema["items"] as Record<string, unknown> | undefined
    if (items) {
      for (const entry of instance) {
        if (!evaluateSchema(items, entry, rootSchema)) return false
      }
    }
  }
  if (typeof instance === "object" && instance !== null && !Array.isArray(instance)) {
    const record = instance as Record<string, unknown>
    const keys = Object.keys(record)
    if (typeof schema["minProperties"] === "number" && keys.length < schema["minProperties"]) {
      return false
    }
    const required = (schema["required"] as string[] | undefined) ?? []
    for (const key of required) {
      if (!(key in record)) return false
    }
    const properties = (schema["properties"] as Record<string, unknown> | undefined) ?? {}
    const additional = schema["additionalProperties"]
    for (const [key, value] of Object.entries(record)) {
      if (key in properties) {
        if (!evaluateSchema(properties[key] as Record<string, unknown>, value, rootSchema)) {
          return false
        }
        continue
      }
      if (additional === false) return false
      if (
        typeof additional === "object" &&
        additional !== null &&
        !evaluateSchema(additional as Record<string, unknown>, value, rootSchema)
      ) {
        return false
      }
    }
  }
  return true
}

interface ConsistencySample {
  name: string
  mutate: (doc: Record<string, unknown>) => void
  expectedValid: boolean
  expectedCode?: string
}

function consistencySamples(): ConsistencySample[] {
  const firstRole = (doc: Record<string, unknown>) =>
    (doc.roles as Array<Record<string, unknown>>)[0]!
  return [
    { name: "baseline rendered organization", mutate: () => {}, expectedValid: true },
    {
      name: "role without a budget field",
      mutate: (doc) => delete firstRole(doc).budget,
      expectedValid: false,
      expectedCode: "workspace_org_budget_missing",
    },
    {
      name: "role with a null budget",
      mutate: (doc) => {
        firstRole(doc).budget = null
      },
      expectedValid: false,
      expectedCode: "workspace_org_budget_missing",
    },
    {
      name: "budget missing the perDay scope",
      mutate: (doc) => {
        firstRole(doc).budget = { perTask: { tokens: 1 } }
      },
      expectedValid: false,
      expectedCode: "workspace_org_budget_not_allocated",
    },
    {
      name: "budget with an empty perTask scope",
      mutate: (doc) => {
        firstRole(doc).budget = { perTask: {}, perDay: { tokens: 1 } }
      },
      expectedValid: false,
      expectedCode: "workspace_org_budget_not_allocated",
    },
    {
      name: "budget cap of zero",
      mutate: (doc) => {
        firstRole(doc).budget = { perTask: { tokens: 0 }, perDay: { tokens: 1 } }
      },
      expectedValid: false,
      expectedCode: "workspace_org_budget_invalid",
    },
    {
      name: "budget cap above the maximum",
      mutate: (doc) => {
        firstRole(doc).budget = {
          perTask: { tokens: BUDGET_LIMIT_MAX + 1 },
          perDay: { tokens: 1 },
        }
      },
      expectedValid: false,
      expectedCode: "workspace_org_budget_invalid",
    },
    {
      name: "budget cap with a non-integer string",
      mutate: (doc) => {
        firstRole(doc).budget = { perTask: { tokens: "20000" }, perDay: { tokens: 1 } }
      },
      expectedValid: false,
      expectedCode: "workspace_org_budget_invalid",
    },
    {
      name: "budget with an unknown top-level key",
      mutate: (doc) => {
        firstRole(doc).budget = {
          perTask: { tokens: 1 },
          perDay: { tokens: 1 },
          perWeek: { tokens: 1 },
        }
      },
      expectedValid: false,
      expectedCode: "workspace_org_budget_invalid",
    },
    {
      name: "budget scope with an unknown cap key",
      mutate: (doc) => {
        firstRole(doc).budget = {
          perTask: { tokens: 1, cpuSeconds: 2 },
          perDay: { tokens: 1 },
        }
      },
      expectedValid: false,
      expectedCode: "workspace_org_budget_invalid",
    },
    {
      name: "budget at the BUDGET_LIMIT_MAX boundary",
      mutate: (doc) => {
        firstRole(doc).budget = {
          perTask: { tokens: BUDGET_LIMIT_MAX },
          perDay: { iterations: BUDGET_LIMIT_MAX },
        }
      },
      expectedValid: true,
    },
    {
      name: "budget with a single cap per scope",
      mutate: (doc) => {
        firstRole(doc).budget = { perTask: { iterations: 4 }, perDay: { tokens: 10 } }
      },
      expectedValid: true,
    },
  ]
}

test("schema consistency: published schema and code validator agree on the sample set", async () => {
  const schema = JSON.parse(
    await readFile(publishedSchemaPath, "utf8"),
  ) as Record<string, unknown>
  for (const sample of consistencySamples()) {
    const doc = renderedOrganization()
    sample.mutate(doc)
    const schemaVerdict = evaluateSchema(schema, doc, schema)
    assert.equal(
      schemaVerdict,
      sample.expectedValid,
      `published schema verdict for: ${sample.name}`,
    )
    let codeVerdict = true
    let code: string | undefined
    try {
      validateOrganizationDocument(doc)
    } catch (error) {
      codeVerdict = false
      code = failureCode(error)
    }
    assert.equal(
      codeVerdict,
      sample.expectedValid,
      `code validator verdict for: ${sample.name}`,
    )
    if (sample.expectedCode) {
      assert.equal(code, sample.expectedCode, `stable code for: ${sample.name}`)
    }
  }
})

test("AC-001: malformed organization documents fail closed at the document level", () => {
  const malformed: Array<{ name: string; doc: unknown }> = [
    { name: "not an object", doc: "workspace-org.v1" },
    { name: "wrong schema version", doc: { ...renderedOrganization(), schemaVersion: "workspace-org.v2" } },
    { name: "missing roles", doc: (() => {
      const doc = renderedOrganization()
      delete doc.roles
      return doc
    })() },
    { name: "empty roles", doc: { ...renderedOrganization(), roles: [] } },
    { name: "unknown top-level key", doc: { ...renderedOrganization(), extra: 1 } },
    { name: "owner not a role", doc: { ...renderedOrganization(), owner: "ghost-owner" } },
    { name: "dangling reportTo", doc: (() => {
      const doc = renderedOrganization()
      ;(doc.roles as Array<Record<string, unknown>>)[1]!.reportTo = "ghost-role"
      return doc
    })() },
    { name: "owner reports to a subordinate", doc: (() => {
      const doc = renderedOrganization()
      ;(doc.roles as Array<Record<string, unknown>>)[0]!.reportTo = "issue-researcher"
      return doc
    })() },
  ]
  for (const sample of malformed) {
    assert.throws(
      () => validateOrganizationDocument(sample.doc),
      (error: unknown) => failureCode(error).startsWith("workspace_org_"),
      `expected fail-closed for: ${sample.name}`,
    )
  }
})

test("published org-tree.schema.json matches the code-side builder", async () => {
  const published = await readFile(publishedOrgTreeSchemaPath, "utf8")
  assert.equal(published, `${JSON.stringify(buildOrgTreeSchema(), null, 2)}\n`)
})

test("org-tree.v1 frozen shape: fixture validates; budget and updatedAt are mandatory", async () => {
  const schema = JSON.parse(
    await readFile(publishedOrgTreeSchemaPath, "utf8"),
  ) as Record<string, unknown>
  const fixture = JSON.parse(
    await readFile(orgTreeFixturePath, "utf8"),
  ) as Record<string, unknown>
  assert.equal(
    evaluateSchema(schema, fixture, schema),
    true,
    "oss-maintainer org-tree fixture must validate against the frozen schema",
  )
  // The budget declaration subset is mandatory on every node.
  const withoutBudget = JSON.parse(JSON.stringify(fixture)) as Record<string, unknown>
  delete (withoutBudget.tree as Array<Record<string, unknown>>)[0]!.budget
  assert.equal(
    evaluateSchema(schema, withoutBudget, schema),
    false,
    "node without a budget subset must fail against the frozen schema",
  )
  // The applied-state updatedAt stamp is mandatory (org.updated alignment).
  const withoutStamp = JSON.parse(JSON.stringify(fixture)) as Record<string, unknown>
  delete withoutStamp.updatedAt
  assert.equal(
    evaluateSchema(schema, withoutStamp, schema),
    false,
    "tree without updatedAt must fail against the frozen schema",
  )
})

test("org-tree.v1 v0 increment: name and mode are optional; an invalid mode is rejected", async () => {
  const schema = JSON.parse(
    await readFile(publishedOrgTreeSchemaPath, "utf8"),
  ) as Record<string, unknown>
  const fixture = JSON.parse(
    await readFile(orgTreeFixturePath, "utf8"),
  ) as Record<string, unknown>
  // Optional display fields: removing name and mode from the root node still
  // validates (additive, non-breaking increment over the frozen required set).
  const withoutDisplay = JSON.parse(JSON.stringify(fixture)) as Record<string, unknown>
  const rootNode = (withoutDisplay.tree as Array<Record<string, unknown>>)[0]!
  delete rootNode.name
  delete rootNode.mode
  assert.equal(
    evaluateSchema(schema, withoutDisplay, schema),
    true,
    "node without optional name/mode must still validate (v0 increment)",
  )
  // An invalid mode value is rejected.
  const badMode = JSON.parse(JSON.stringify(fixture)) as Record<string, unknown>
  ;(badMode.tree as Array<Record<string, unknown>>)[0]!.mode = "full_access"
  assert.equal(
    evaluateSchema(schema, badMode, schema),
    false,
    "node with an invalid mode must fail against the frozen schema",
  )
})
