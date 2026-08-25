/**
 * hire-request.v1alpha1 — the thin reference envelope for the hire channel
 * (#194, R4 freeze). A hire request only REFERENCES a sealed turn envelope
 * and names where the employee would hang in the org tree; it never spawns,
 * imports org-workbench, or touches the engine. Validation is static and
 * fail-closed: any violation exits before any effect, with a stable
 * machine-readable diagnostic code on stderr.
 *
 * Budget discipline: a hire without a budget fails closed (#194 AC-005).
 * The budget scope vocabulary is byte-aligned with the engine BudgetScope
 * and the turn-envelope.v1 `$defs/budgetScope` published vocabulary — the
 * cap constant mirrors `packages/engine/src/budget.ts` MAX_BUDGET_CAP
 * (mirrored locally because core must not import engine).
 */

export const HIRE_REQUEST_SCHEMA_VERSION = "hire-request.v1alpha1" as const
export const HIRE_REQUEST_SCHEMA_ID =
  "https://raw.githubusercontent.com/fullstack-ai-infra/digital-employee/main/configs/hire-request.schema.json" as const

/** Mirrors engine MAX_BUDGET_CAP (packages/engine/src/budget.ts). */
const MAX_BUDGET_CAP = 1_000_000_000
/** Same bounded-identifier discipline as turn-envelope.v1. */
const MAX_ID_LENGTH = 256
const MIN_DIGEST_LENGTH = 16
const PACKAGE_VERSION_PATTERN = /^v1alpha1(\.[0-9]+)?$/

const HIRE_REQUEST_KNOWN_FIELDS = [
  "schemaVersion",
  "workspaceRef",
  "packageRef",
  "targetParentId",
  "budget",
  "requestedBy",
  "deadline",
  "envelopeDigest",
] as const
const PACKAGE_REF_KNOWN_FIELDS = ["name", "version", "digest"] as const
const BUDGET_KNOWN_FIELDS = ["perTask", "perDay"] as const
const BUDGET_SCOPE_KNOWN_FIELDS = ["tokens", "iterations"] as const

export interface HireRequestBudgetScope {
  tokens?: number
  iterations?: number
}

export interface HireRequestBudget {
  perTask: HireRequestBudgetScope
  perDay: HireRequestBudgetScope
}

export interface HireRequestPackageRef {
  name: string
  version: string
  digest: string
}

export interface HireRequest {
  schemaVersion: typeof HIRE_REQUEST_SCHEMA_VERSION
  workspaceRef: string
  packageRef: HireRequestPackageRef
  /**
   * Opaque org-tree placement reference (#194 AC-003). Validated as bounded
   * text only; tree resolution belongs to the consumer (org-workbench #33).
   */
  targetParentId: string
  budget: HireRequestBudget
  requestedBy: string
  deadline?: string
  envelopeDigest: string
}

export class HireRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "HireRequestError"
  }
}

function hireRequestError(code: string, message: string): HireRequestError {
  return new HireRequestError(code, message)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

function assertKnownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw hireRequestError(
        `hire_request_unknown_field:${path ? `${path}.` : ""}${key}`,
        `unknown field: ${path ? `${path}.` : ""}${key}`,
      )
    }
  }
}

/** turn-envelope.v1 bounded-identifier constraints, verbatim shape. */
function assertBoundedId(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw hireRequestError(
      `hire_request_invalid_field:${path}`,
      `${path} must be a non-empty string`,
    )
  }
  if (value.length > MAX_ID_LENGTH) {
    throw hireRequestError(
      `hire_request_invalid_field:${path}`,
      `${path} exceeds the bounded identifier length`,
    )
  }
  return value
}

function assertDigest(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length < MIN_DIGEST_LENGTH) {
    throw hireRequestError(
      `hire_request_invalid_field:${path}`,
      `${path} must be a string of at least ${MIN_DIGEST_LENGTH} characters`,
    )
  }
  return value
}

function validateBudgetScope(
  value: unknown,
  path: string,
): HireRequestBudgetScope {
  if (!isPlainObject(value)) {
    throw hireRequestError(
      `hire_request_invalid_field:${path}`,
      `${path} must be an object`,
    )
  }
  assertKnownFields(value, BUDGET_SCOPE_KNOWN_FIELDS, path)
  const scope: HireRequestBudgetScope = {}
  let present = 0
  for (const key of BUDGET_SCOPE_KNOWN_FIELDS) {
    const entry = value[key]
    if (entry === undefined) continue
    if (
      typeof entry !== "number" ||
      !Number.isInteger(entry) ||
      entry < 1 ||
      entry > MAX_BUDGET_CAP
    ) {
      throw hireRequestError(
        `hire_request_invalid_field:${path}.${key}`,
        `${path}.${key} must be an integer between 1 and ${MAX_BUDGET_CAP}`,
      )
    }
    if (key === "tokens") scope.tokens = entry
    else scope.iterations = entry
    present += 1
  }
  if (present === 0) {
    throw hireRequestError(
      `hire_request_invalid_field:${path}`,
      `${path} must declare at least one of tokens or iterations`,
    )
  }
  return scope
}

function validateBudget(value: unknown): HireRequestBudget {
  if (!isPlainObject(value)) {
    throw hireRequestError(
      "hire_request_invalid_field:budget",
      "budget must be an object",
    )
  }
  assertKnownFields(value, BUDGET_KNOWN_FIELDS, "budget")
  const perTask =
    value.perTask === undefined
      ? undefined
      : validateBudgetScope(value.perTask, "budget.perTask")
  const perDay =
    value.perDay === undefined
      ? undefined
      : validateBudgetScope(value.perDay, "budget.perDay")
  if (!perTask || !perDay) {
    throw hireRequestError(
      `hire_request_invalid_field:budget.${!perTask ? "perTask" : "perDay"}`,
      `budget.${!perTask ? "perTask" : "perDay"} is required`,
    )
  }
  return { perTask, perDay }
}

function validatePackageRef(value: unknown): HireRequestPackageRef {
  if (!isPlainObject(value)) {
    throw hireRequestError(
      "hire_request_invalid_field:packageRef",
      "packageRef must be an object",
    )
  }
  assertKnownFields(value, PACKAGE_REF_KNOWN_FIELDS, "packageRef")
  const name = assertBoundedId(value.name, "packageRef.name")
  const version = value.version
  if (
    typeof version !== "string" ||
    !PACKAGE_VERSION_PATTERN.test(version)
  ) {
    throw hireRequestError(
      "hire_request_invalid_field:packageRef.version",
      "packageRef.version must match ^v1alpha1(\\.[0-9]+)?$",
    )
  }
  const digest = assertDigest(value.digest, "packageRef.digest")
  return { name, version, digest }
}

/**
 * Validate a hire-request.v1alpha1 document. Static and fail-closed: no
 * spawn, no engine, no network, no provider calls. Throws `HireRequestError`
 * whose `code` is the stable diagnostic (`hire_request_unknown_field:<path>`,
 * `hire_request_invalid_field:<path>`, `hire_request_missing_budget`).
 */
export function validateHireRequest(raw: unknown): HireRequest {
  if (!isPlainObject(raw)) {
    throw hireRequestError(
      "hire_request_invalid_field:hireRequest",
      "hire request must be a JSON object",
    )
  }
  assertKnownFields(raw, HIRE_REQUEST_KNOWN_FIELDS, "")

  if (raw.schemaVersion !== HIRE_REQUEST_SCHEMA_VERSION) {
    throw hireRequestError(
      "hire_request_invalid_field:schemaVersion",
      `schemaVersion must be "${HIRE_REQUEST_SCHEMA_VERSION}"`,
    )
  }

  const workspaceRef = assertBoundedId(raw.workspaceRef, "workspaceRef")
  const packageRef = validatePackageRef(raw.packageRef)
  const targetParentId = assertBoundedId(raw.targetParentId, "targetParentId")

  if (raw.budget === undefined) {
    throw hireRequestError(
      "hire_request_missing_budget",
      "budget is required: a hire without a budget fails closed",
    )
  }
  const budget = validateBudget(raw.budget)

  const requestedBy = assertBoundedId(raw.requestedBy, "requestedBy")

  let deadline: string | undefined
  if (raw.deadline !== undefined) {
    if (
      typeof raw.deadline !== "string" ||
      Number.isNaN(Date.parse(raw.deadline))
    ) {
      throw hireRequestError(
        "hire_request_invalid_field:deadline",
        "deadline must be a valid ISO 8601 timestamp",
      )
    }
    deadline = raw.deadline
  }

  const envelopeDigest = assertDigest(raw.envelopeDigest, "envelopeDigest")

  return {
    schemaVersion: HIRE_REQUEST_SCHEMA_VERSION,
    workspaceRef,
    packageRef,
    targetParentId,
    budget,
    requestedBy,
    ...(deadline !== undefined ? { deadline } : {}),
    envelopeDigest,
  }
}

function boundedIdSchema(): Record<string, unknown> {
  return { type: "string", minLength: 1, maxLength: 256 }
}

/**
 * Budget scope vocabulary byte-aligned with turn-envelope.v1
 * `$defs/budgetScope` (#194 AC-005): tokens/iterations are positive bounded
 * integers; a scope must declare at least one dimension.
 */
function budgetScopeSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: {
      tokens: { type: "integer", exclusiveMinimum: 0, maximum: 1_000_000_000 },
      iterations: {
        type: "integer",
        exclusiveMinimum: 0,
        maximum: 1_000_000_000,
      },
    },
  }
}

/**
 * Build the hire-request.v1alpha1 JSON Schema (draft 2020-12). Mirrors
 * `validateHireRequest` field-by-field; the published file
 * configs/hire-request.schema.json must be byte-identical to
 * `JSON.stringify(buildHireRequestSchema(), null, 2) + "\n"`.
 */
export function buildHireRequestSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: HIRE_REQUEST_SCHEMA_ID,
    title: "hire-request.v1alpha1 hire request reference envelope",
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "workspaceRef",
      "packageRef",
      "targetParentId",
      "budget",
      "requestedBy",
      "envelopeDigest",
    ],
    properties: {
      schemaVersion: { const: HIRE_REQUEST_SCHEMA_VERSION },
      workspaceRef: boundedIdSchema(),
      packageRef: {
        type: "object",
        additionalProperties: false,
        required: ["name", "version", "digest"],
        properties: {
          name: boundedIdSchema(),
          version: { type: "string", pattern: "^v1alpha1(\\.[0-9]+)?$" },
          digest: { type: "string", minLength: 16 },
        },
      },
      targetParentId: boundedIdSchema(),
      budget: {
        type: "object",
        additionalProperties: false,
        required: ["perTask", "perDay"],
        properties: {
          perTask: { $ref: "#/$defs/budgetScope" },
          perDay: { $ref: "#/$defs/budgetScope" },
        },
      },
      requestedBy: boundedIdSchema(),
      deadline: { type: "string" },
      envelopeDigest: { type: "string", minLength: 16 },
    },
    $defs: {
      budgetScope: budgetScopeSchema(),
    },
  }
}
