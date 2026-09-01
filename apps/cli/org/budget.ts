/**
 * Organization budget contract of the workspace-org.v1 model (#157
 * REQ-001/REQ-006, AC-001/AC-006).
 *
 * Every position carries exactly one budget declaration shaped
 * `{ perTask: { tokens?, iterations? }, perDay: { tokens?, iterations? } }`.
 * The only units are tokens and iteration counts; there is no currency
 * dimension (#155 non-goal: budget never introduces billing semantics).
 *
 * "Fully allocated" means both scopes (`perTask` and `perDay`) are present
 * and each scope declares at least one positive integer cap. Every cap is at
 * most BUDGET_LIMIT_MAX; anything else fails closed.
 *
 * Validation is fail-closed: violations throw TypeErrors whose message starts
 * with a stable `workspace_org_budget_*` code (`..._missing`,
 * `..._not_allocated`, `..._invalid`) followed by the position id, so CLI
 * surfaces can sanitize user input out of machine-readable codes while still
 * localizing recovery guidance.
 *
 * `buildWorkspaceOrgSchema()` is the single code-side source of truth for the
 * published JSON Schema at configs/workspace-org.schema.json (draft
 * 2020-12). The schema-consistency test asserts the published file is
 * byte-identical to this builder and that the published schema and the code
 * validators agree on the same sample set.
 */

export const WORKSPACE_ORG_SCHEMA_VERSION = "workspace-org.v1" as const

export const WORKSPACE_ORG_SCHEMA_ID =
  "https://raw.githubusercontent.com/fullstack-ai-infra/digital-employee/main/configs/workspace-org.schema.json" as const

/** Current public locator written into generated organization documents. */
export const WORKSPACE_ORG_SCHEMA_URL =
  "https://raw.githubusercontent.com/bytefolk/digital-employee/main/configs/workspace-org.schema.json" as const

/** Upper bound for every budget cap (guards against overflow and typos). */
export const BUDGET_LIMIT_MAX = 1_000_000_000 as const

export const BUDGET_SCOPE_KEYS = ["perTask", "perDay"] as const
export const BUDGET_LIMIT_KEYS = ["tokens", "iterations"] as const

export type BudgetScopeName = (typeof BUDGET_SCOPE_KEYS)[number]
export type BudgetLimitName = (typeof BUDGET_LIMIT_KEYS)[number]

/** One budget scope: at least one positive integer cap. */
export type BudgetScope = {
  tokens?: number
  iterations?: number
}

/** Position budget contract: per-task caps and per-day caps. */
export interface PositionBudget {
  perTask: BudgetScope
  perDay: BudgetScope
}

export type WorkspaceOrgBudgetCode =
  | "workspace_org_budget_missing"
  | "workspace_org_budget_not_allocated"
  | "workspace_org_budget_invalid"

/** Business and position names: lowercase kebab-case, max 64 chars. */
export const ORGANIZATION_NAME_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)*$"
export const ORGANIZATION_NAME_MAX_LENGTH = 64

const POSITION_PACKAGE_MODES = ["read_only", "approval_required"] as const

export type PositionMode = (typeof POSITION_PACKAGE_MODES)[number]

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function invalidBudget(positionId: string): TypeError {
  return new TypeError(`workspace_org_budget_invalid:${positionId}`)
}

/**
 * Validate one position budget declaration and return a normalized copy.
 * Fail-closed codes:
 *   workspace_org_budget_missing        no declaration (undefined/null)
 *   workspace_org_budget_not_allocated  declaration exists but a scope is
 *                                       absent or carries no cap
 *   workspace_org_budget_invalid        non-positive/non-integer caps, caps
 *                                       above BUDGET_LIMIT_MAX, unknown keys
 */
export function validatePositionBudget(
  positionId: string,
  value: unknown,
): PositionBudget {
  if (value === undefined || value === null) {
    throw new TypeError(`workspace_org_budget_missing:${positionId}`)
  }
  if (!isPlainObject(value)) throw invalidBudget(positionId)
  for (const key of Object.keys(value)) {
    if (!(BUDGET_SCOPE_KEYS as readonly string[]).includes(key)) {
      throw invalidBudget(positionId)
    }
  }
  const budget: PositionBudget = { perTask: {}, perDay: {} }
  for (const scopeName of BUDGET_SCOPE_KEYS) {
    if (!(scopeName in value)) {
      throw new TypeError(`workspace_org_budget_not_allocated:${positionId}`)
    }
    const scopeValue = value[scopeName]
    if (!isPlainObject(scopeValue)) throw invalidBudget(positionId)
    for (const key of Object.keys(scopeValue)) {
      if (!(BUDGET_LIMIT_KEYS as readonly string[]).includes(key)) {
        throw invalidBudget(positionId)
      }
    }
    const scope: BudgetScope = {}
    for (const limitName of BUDGET_LIMIT_KEYS) {
      if (!(limitName in scopeValue)) continue
      const raw = scopeValue[limitName]
      if (
        typeof raw !== "number" ||
        !Number.isInteger(raw) ||
        raw <= 0 ||
        raw > BUDGET_LIMIT_MAX
      ) {
        throw invalidBudget(positionId)
      }
      scope[limitName] = raw
    }
    if (Object.keys(scope).length === 0) {
      throw new TypeError(`workspace_org_budget_not_allocated:${positionId}`)
    }
    budget[scopeName] = scope
  }
  return budget
}

/**
 * Validate every position budget in an organization role list. Each position
 * corresponds to exactly one budget (REQ-006: a hire without a budget fails
 * closed). Returns a normalized budget map keyed by position id.
 */
export function validateOrganizationBudgets(
  roles: ReadonlyArray<{ id: string; budget?: unknown }>,
): Record<string, PositionBudget> {
  const budgets: Record<string, PositionBudget> = {}
  for (const role of roles) {
    budgets[role.id] = validatePositionBudget(role.id, role.budget)
  }
  return budgets
}

/** Minimal normalized organization role produced by document validation. */
export interface ValidatedOrganizationRole {
  id: string
  name: string
  description: string
  reportTo: string | null
  package: {
    name: string
    version: string
    digest: string
    localReference: string
  }
  mode: (typeof POSITION_PACKAGE_MODES)[number]
  memoryScope: string
  toolAllow: string[]
  toolDeny: string[]
  metadata: Record<string, string>
  budget: PositionBudget
}

export interface ValidatedOrganizationDocument {
  schemaVersion: typeof WORKSPACE_ORG_SCHEMA_VERSION
  business: string
  description: string
  owner: string
  roles: ValidatedOrganizationRole[]
  updatedAt: string
}

function invalidDocument(detail: string): TypeError {
  return new TypeError(`workspace_org_document_invalid:${detail}`)
}

function requireString(
  container: Record<string, unknown>,
  key: string,
  detail: string,
): string {
  const value = container[key]
  if (typeof value !== "string") throw invalidDocument(detail)
  return value
}

function validateName(value: string, detail: string): void {
  if (
    value.length === 0 ||
    value.length > ORGANIZATION_NAME_MAX_LENGTH ||
    !new RegExp(ORGANIZATION_NAME_PATTERN).test(value)
  ) {
    throw invalidDocument(detail)
  }
}

/**
 * Code-side validation of a workspace-org.v1 organization document. Mirrors
 * the published JSON Schema keyword-for-keyword (required fields, types,
 * additionalProperties: false, budget contract) and is a fail-closed
 * superset of it: unique role ids, owner membership/root, resolved reporting
 * lines, and acyclic reporting chains are enforced here as well because JSON
 * Schema cannot express them. Fails closed with stable codes on any
 * violation.
 */
export function validateOrganizationDocument(
  value: unknown,
): ValidatedOrganizationDocument {
  if (!isPlainObject(value)) throw invalidDocument("root")
  for (const key of Object.keys(value)) {
    if (
      ![
        "$schema",
        "schemaVersion",
        "business",
        "description",
        "owner",
        "roles",
        "updatedAt",
      ].includes(key)
    ) {
      throw invalidDocument("unknown_key")
    }
  }
  if (value["$schema"] !== undefined && typeof value["$schema"] !== "string") {
    throw invalidDocument("schema_ref")
  }
  const schemaVersion = requireString(value, "schemaVersion", "schema_version")
  if (schemaVersion !== WORKSPACE_ORG_SCHEMA_VERSION) {
    throw invalidDocument("schema_version")
  }
  const business = requireString(value, "business", "business")
  validateName(business, "business")
  const description =
    value["description"] === undefined
      ? ""
      : requireString(value, "description", "description")
  const owner = requireString(value, "owner", "owner")
  validateName(owner, "owner")
  const updatedAt = requireString(value, "updatedAt", "updated_at")
  if (updatedAt.length === 0) throw invalidDocument("updated_at")
  const rolesValue = value["roles"]
  if (!Array.isArray(rolesValue) || rolesValue.length === 0) {
    throw invalidDocument("roles")
  }
  const roles: ValidatedOrganizationRole[] = []
  const seen = new Set<string>()
  for (const [index, entry] of rolesValue.entries()) {
    if (!isPlainObject(entry)) throw invalidDocument(`role_${index}`)
    for (const key of Object.keys(entry)) {
      if (
        ![
          "id",
          "name",
          "description",
          "reportTo",
          "package",
          "mode",
          "memoryScope",
          "toolAllow",
          "toolDeny",
          "metadata",
          "budget",
        ].includes(key)
      ) {
        throw invalidDocument(`role_${index}_unknown_key`)
      }
    }
    const id = requireString(entry, "id", `role_${index}_id`)
    validateName(id, `role_${index}_id`)
    if (seen.has(id)) throw invalidDocument(`role_${index}_duplicate_id`)
    seen.add(id)
    const name = requireString(entry, "name", `role_${index}_name`)
    if (name.length === 0 || name.length > 128) {
      throw invalidDocument(`role_${index}_name`)
    }
    const roleDescription = requireString(
      entry,
      "description",
      `role_${index}_description`,
    )
    if (roleDescription.length > 2000) {
      throw invalidDocument(`role_${index}_description`)
    }
    let reportTo: string | null
    if (entry["reportTo"] === null) {
      reportTo = null
    } else if (typeof entry["reportTo"] === "string") {
      validateName(entry["reportTo"], `role_${index}_report_to`)
      reportTo = entry["reportTo"]
    } else {
      throw invalidDocument(`role_${index}_report_to`)
    }
    const packageValue = entry["package"]
    if (!isPlainObject(packageValue)) {
      throw invalidDocument(`role_${index}_package`)
    }
    for (const key of Object.keys(packageValue)) {
      if (!["name", "version", "digest", "localReference"].includes(key)) {
        throw invalidDocument(`role_${index}_package_unknown_key`)
      }
    }
    const packageName = requireString(
      packageValue,
      "name",
      `role_${index}_package_name`,
    )
    const packageVersion = requireString(
      packageValue,
      "version",
      `role_${index}_package_version`,
    )
    const digest = requireString(
      packageValue,
      "digest",
      `role_${index}_package_digest`,
    )
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
      throw invalidDocument(`role_${index}_package_digest`)
    }
    const localReference = requireString(
      packageValue,
      "localReference",
      `role_${index}_package_local_reference`,
    )
    if (localReference.length === 0) {
      throw invalidDocument(`role_${index}_package_local_reference`)
    }
    const rawMode = entry.mode
    let mode: (typeof POSITION_PACKAGE_MODES)[number]
    if (rawMode === undefined) {
      // Absent mode defaults to read_only (#159 REQ-006).
      mode = "read_only"
    } else {
      if (
        typeof rawMode !== "string" ||
        !(POSITION_PACKAGE_MODES as readonly string[]).includes(rawMode)
      ) {
        throw invalidDocument(`role_${index}_mode`)
      }
      mode = rawMode as (typeof POSITION_PACKAGE_MODES)[number]
    }
    const memoryScope = requireString(
      entry,
      "memoryScope",
      `role_${index}_memory_scope`,
    )
    if (memoryScope.length === 0) {
      throw invalidDocument(`role_${index}_memory_scope`)
    }
    const readToolList = (
      key: "toolAllow" | "toolDeny",
    ): string[] => {
      const list = entry[key]
      if (!Array.isArray(list)) throw invalidDocument(`role_${index}_${key}`)
      return list.map((tool, toolIndex) => {
        if (typeof tool !== "string" || tool.length === 0 || tool.length > 64) {
          throw invalidDocument(`role_${index}_${key}_${toolIndex}`)
        }
        return tool
      })
    }
    const toolAllow = readToolList("toolAllow")
    const toolDeny = readToolList("toolDeny")
    const metadataValue = entry["metadata"]
    if (!isPlainObject(metadataValue)) {
      throw invalidDocument(`role_${index}_metadata`)
    }
    const metadata: Record<string, string> = {}
    for (const [metadataKey, metadataEntry] of Object.entries(metadataValue)) {
      if (typeof metadataEntry !== "string") {
        throw invalidDocument(`role_${index}_metadata`)
      }
      metadata[metadataKey] = metadataEntry
    }
    const budget = validatePositionBudget(id, entry["budget"])
    roles.push({
      id,
      name,
      description: roleDescription,
      reportTo,
      package: {
        name: packageName,
        version: packageVersion,
        digest,
        localReference,
      },
      mode: mode as ValidatedOrganizationRole["mode"],
      memoryScope,
      toolAllow,
      toolDeny,
      metadata,
      budget,
    })
  }
  if (!seen.has(owner)) throw invalidDocument("owner_not_a_role")
  const ownerRole = roles.find((role) => role.id === owner)
  if (ownerRole && ownerRole.reportTo !== null) {
    throw invalidDocument("owner_must_be_root")
  }
  for (const role of roles) {
    if (role.reportTo !== null && !seen.has(role.reportTo)) {
      throw invalidDocument(`role_${role.id}_dangling_report_to`)
    }
  }
  for (const role of roles) {
    const visited = new Set<string>()
    let current: ValidatedOrganizationRole | undefined = role
    while (current) {
      if (visited.has(current.id)) throw invalidDocument("reporting_cycle")
      visited.add(current.id)
      const superior: string | null = current.reportTo
      current =
        superior === null
          ? undefined
          : roles.find((entry) => entry.id === superior)
    }
  }
  return {
    schemaVersion: WORKSPACE_ORG_SCHEMA_VERSION,
    business,
    description,
    owner,
    roles,
    updatedAt,
  }
}

/**
 * Shared JSON Schema fragments for the organization contracts. Both
 * workspace-org.v1 and org-tree.v1 are built from these builders so the name
 * and budget declarations stay byte-stable across the published schemas.
 */
export function organizationNameSchema(): Record<string, unknown> {
  return {
    type: "string",
    pattern: ORGANIZATION_NAME_PATTERN,
    maxLength: ORGANIZATION_NAME_MAX_LENGTH,
  }
}

export function positionModeSchema(): Record<string, unknown> {
  return { enum: [...POSITION_PACKAGE_MODES] }
}

export function budgetScopeSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: {
      tokens: {
        type: "integer",
        exclusiveMinimum: 0,
        maximum: BUDGET_LIMIT_MAX,
      },
      iterations: {
        type: "integer",
        exclusiveMinimum: 0,
        maximum: BUDGET_LIMIT_MAX,
      },
    },
  }
}

export function positionBudgetDefs(): Record<string, unknown> {
  return {
    positionBudget: {
      type: "object",
      additionalProperties: false,
      required: [...BUDGET_SCOPE_KEYS],
      properties: {
        perTask: { $ref: "#/$defs/budgetScope" },
        perDay: { $ref: "#/$defs/budgetScope" },
      },
    },
    budgetScope: budgetScopeSchema(),
  }
}

/**
 * Build the workspace-org.v1 JSON Schema (draft 2020-12). The published file
 * configs/workspace-org.schema.json must be byte-identical to
 * `JSON.stringify(buildWorkspaceOrgSchema(), null, 2) + "\n"`; the
 * schema-consistency test enforces this and the sample-agreement property.
 */
export function buildWorkspaceOrgSchema(): Record<string, unknown> {
  const nameSchema = organizationNameSchema()
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: WORKSPACE_ORG_SCHEMA_ID,
    title: "workspace-org.v1 organization model",
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "business", "owner", "roles", "updatedAt"],
    properties: {
      $schema: { type: "string" },
      schemaVersion: { const: WORKSPACE_ORG_SCHEMA_VERSION },
      business: nameSchema,
      description: { type: "string" },
      owner: nameSchema,
      roles: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "name",
            "description",
            "reportTo",
            "package",
            "memoryScope",
            "toolAllow",
            "toolDeny",
            "metadata",
            "budget",
          ],
          properties: {
            id: nameSchema,
            name: { type: "string", minLength: 1, maxLength: 128 },
            description: { type: "string", maxLength: 2000 },
            reportTo: {
              anyOf: [{ type: "null" }, organizationNameSchema()],
            },
            package: {
              type: "object",
              additionalProperties: false,
              required: ["name", "version", "digest", "localReference"],
              properties: {
                name: { type: "string", minLength: 1 },
                version: { type: "string", minLength: 1 },
                digest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
                localReference: { type: "string", minLength: 1 },
              },
            },
            mode: { enum: [...POSITION_PACKAGE_MODES] },
            memoryScope: { type: "string", minLength: 1 },
            toolAllow: {
              type: "array",
              items: { type: "string", minLength: 1, maxLength: 64 },
            },
            toolDeny: {
              type: "array",
              items: { type: "string", minLength: 1, maxLength: 64 },
            },
            metadata: {
              type: "object",
              additionalProperties: { type: "string" },
            },
            budget: { $ref: "#/$defs/positionBudget" },
          },
        },
      },
      updatedAt: { type: "string", minLength: 1 },
    },
    $defs: positionBudgetDefs(),
  }
}
