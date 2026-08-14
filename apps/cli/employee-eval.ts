import { Ajv2020 } from "ajv/dist/2020.js"
import type { ValidateFunction } from "ajv"
import { parseDocument } from "yaml"

import {
  inspectEmployeePackage,
  readDeclaredEmployeePackageAsset,
} from "./employee-package.js"
import type { EmployeePackageInspection } from "./employee-package.js"

const EVAL_ASSET = "./evals/cases.json"
const EVAL_CONTRACT_SCHEMA_VERSION = "employee-evals.v1alpha1"
const MAX_EVAL_CASES = 512
export const EMPLOYEE_EVAL_RESULT_SCHEMA_VERSION =
  "employee-eval-result.v1alpha1" as const

export type EmployeeEvalFailureCode =
  | "EVAL_PACKAGE_INVALID"
  | "EVAL_CONTRACT_INVALID"
  | "EVAL_CASE_INPUT_SCHEMA_INVALID"
  | "EVAL_CASE_EXPECTED_OUTPUT_SCHEMA_INVALID"

export type EmployeeEvalCode =
  | "EVAL_PASSED"
  | "EVAL_CASE_PASSED"
  | EmployeeEvalFailureCode

export interface EmployeeEvalCaseResult {
  id: string
  status: "passed" | "failed"
  code: EmployeeEvalCode
}

export interface EmployeeEvalResult {
  schemaVersion: typeof EMPLOYEE_EVAL_RESULT_SCHEMA_VERSION
  status: "passed" | "failed"
  code: EmployeeEvalCode
  employee?: {
    name: string
    version: string
    schemaVersion: string
  }
  summary: {
    total: number
    passed: number
    failed: number
  }
  cases: EmployeeEvalCaseResult[]
}

interface EmployeeEvalCase {
  id: string
  input: unknown
  expectedOutput: unknown
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
}

function parseEvalContract(content: string): EmployeeEvalCase[] {
  let value: unknown
  try {
    value = JSON.parse(content) as unknown
  } catch {
    throw new TypeError("employee_eval_contract_invalid_json")
  }

  const duplicateCheck = parseDocument(content, {
    strict: true,
    uniqueKeys: true,
  })
  if (duplicateCheck.errors.length > 0) {
    throw new TypeError("employee_eval_contract_duplicate_key")
  }
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, ["cases", "schemaVersion"]) ||
    value.schemaVersion !== EVAL_CONTRACT_SCHEMA_VERSION ||
    !Array.isArray(value.cases) ||
    value.cases.length === 0 ||
    value.cases.length > MAX_EVAL_CASES
  ) {
    throw new TypeError("employee_eval_contract_invalid_shape")
  }

  const ids = new Set<string>()
  return value.cases.map((rawCase) => {
    if (
      !isPlainObject(rawCase) ||
      !hasExactKeys(rawCase, ["expectedOutput", "id", "input"]) ||
      typeof rawCase.id !== "string" ||
      !/^[a-z0-9](?:[a-z0-9._-]{0,127})$/.test(rawCase.id) ||
      ids.has(rawCase.id)
    ) {
      throw new TypeError("employee_eval_case_invalid_shape")
    }
    ids.add(rawCase.id)
    return {
      id: rawCase.id,
      input: rawCase.input,
      expectedOutput: rawCase.expectedOutput,
    }
  })
}

function compileFixtureValidator(
  schema: Record<string, unknown>,
): ValidateFunction {
  const validate = new Ajv2020({
    allErrors: true,
    allowUnionTypes: true,
    strict: false,
    validateSchema: true,
  }).compile(schema)
  if ("$async" in validate && validate.$async === true) {
    throw new TypeError("employee_async_json_schema_unsupported")
  }
  return validate
}

function employeeIdentity(inspection: EmployeePackageInspection) {
  return {
    name: inspection.manifest.name,
    version: inspection.manifest.version,
    schemaVersion: inspection.manifest.schemaVersion,
  }
}

function failedResult(
  code: EmployeeEvalFailureCode,
  inspection?: EmployeePackageInspection,
): EmployeeEvalResult {
  return {
    schemaVersion: EMPLOYEE_EVAL_RESULT_SCHEMA_VERSION,
    status: "failed",
    code,
    ...(inspection ? { employee: employeeIdentity(inspection) } : {}),
    summary: { total: 0, passed: 0, failed: 0 },
    cases: [],
  }
}

/**
 * Performs offline fixture conformance only. It validates declared examples
 * against package Schemas and never invokes a model, Agent Host, MCP, or an
 * online service.
 */
export async function evaluateEmployeePackage(
  requestedDirectory: string,
): Promise<EmployeeEvalResult> {
  let inspection: EmployeePackageInspection
  try {
    inspection = await inspectEmployeePackage(requestedDirectory)
  } catch {
    return failedResult("EVAL_PACKAGE_INVALID")
  }

  if (!inspection.manifest.assets.includes(EVAL_ASSET)) {
    return failedResult("EVAL_CONTRACT_INVALID", inspection)
  }

  let content: string
  try {
    content = await readDeclaredEmployeePackageAsset(
      inspection,
      EVAL_ASSET,
    )
  } catch {
    return failedResult("EVAL_PACKAGE_INVALID", inspection)
  }

  let cases: EmployeeEvalCase[]
  try {
    cases = parseEvalContract(content)
  } catch {
    return failedResult("EVAL_CONTRACT_INVALID", inspection)
  }

  let validateInput: ValidateFunction
  let validateOutput: ValidateFunction
  try {
    validateInput = compileFixtureValidator(inspection.artifacts.inputSchema)
    validateOutput = compileFixtureValidator(inspection.artifacts.outputSchema)
  } catch {
    return failedResult("EVAL_PACKAGE_INVALID", inspection)
  }

  const caseResults = cases.map<EmployeeEvalCaseResult>((evalCase) => {
    if (validateInput(evalCase.input) !== true) {
      return {
        id: evalCase.id,
        status: "failed",
        code: "EVAL_CASE_INPUT_SCHEMA_INVALID",
      }
    }
    if (validateOutput(evalCase.expectedOutput) !== true) {
      return {
        id: evalCase.id,
        status: "failed",
        code: "EVAL_CASE_EXPECTED_OUTPUT_SCHEMA_INVALID",
      }
    }
    return {
      id: evalCase.id,
      status: "passed",
      code: "EVAL_CASE_PASSED",
    }
  })
  const passed = caseResults.filter((result) => result.status === "passed").length
  const failed = caseResults.length - passed
  const firstFailure = caseResults.find((result) => result.status === "failed")
  return {
    schemaVersion: EMPLOYEE_EVAL_RESULT_SCHEMA_VERSION,
    status: failed === 0 ? "passed" : "failed",
    code: firstFailure?.code ?? "EVAL_PASSED",
    employee: employeeIdentity(inspection),
    summary: { total: caseResults.length, passed, failed },
    cases: caseResults,
  }
}
