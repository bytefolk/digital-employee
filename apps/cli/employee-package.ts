import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import path from "node:path"
import { Ajv2020 } from "ajv/dist/2020.js"
import { parseDocument } from "yaml"

import {
  EMPLOYEE_PACKAGE_MANIFEST_NAME,
  validateEmployeePackageManifest,
} from "../../packages/core/src/employee-package.js"
import type { EmployeePackageManifest } from "../../packages/core/src/employee-package.js"
import { assertPlainObject } from "../../packages/core/src/contracts.js"
import { validateEmployeeMcpManifest } from "../../packages/core/src/employee-mcp.js"
import type { EmployeeMcpManifest } from "../../packages/core/src/employee-mcp.js"

const MAX_MANIFEST_BYTES = 256 * 1024
const MAX_SKILL_BYTES = 128 * 1024
const MAX_SCHEMA_BYTES = 256 * 1024
const MAX_ASSET_BYTES = 5 * 1024 * 1024
const MAX_DECLARED_FILES = 512
const MAX_TOTAL_BYTES = 20 * 1024 * 1024
const EMPLOYEE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export interface EmployeePackageSummary {
  directory: string
  manifest: EmployeePackageManifest
  files: string[]
}

export interface EmployeePackageInspection extends EmployeePackageSummary {
  artifacts: {
    skill: string
    inputSchema: Record<string, unknown>
    outputSchema: Record<string, unknown>
    mcp?: EmployeeMcpManifest
  }
}

export interface CreateEmployeePackageOptions {
  name?: string
  author?: string
}

function fileErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined
}

function packageNameFromDirectory(directory: string): string {
  return path.basename(directory)
}

function requirePackageName(value: string): string {
  if (value.length > 64 || !EMPLOYEE_NAME_PATTERN.test(value)) {
    throw new TypeError(`invalid_employee_name:${value}`)
  }
  return value
}

async function assertNewDirectoryTarget(directory: string): Promise<void> {
  try {
    await lstat(directory)
    throw new TypeError(`init_target_already_exists:${directory}`)
  } catch (error) {
    if (fileErrorCode(error) !== "ENOENT") throw error
  }
  const parent = await lstat(path.dirname(directory))
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new TypeError("init_parent_must_be_a_real_directory")
  }
}

function employeeManifest(
  name: string,
  author: string,
): EmployeePackageManifest {
  return validateEmployeePackageManifest({
    $schema:
      "https://raw.githubusercontent.com/fullstack-ai-infra/digital-employee/main/configs/employee-package.schema.json",
    schemaVersion: "employee-package.v1alpha1",
    name,
    version: "0.1.0",
    description: "A portable digital employee built with Digital Employee.",
    license: "Apache-2.0",
    authors: [author],
    host: {
      protocol: "agent-host.v1",
      requiredCapabilities: [],
    },
    entrypoints: {
      skill: "./SKILL.md",
      inputSchema: "./schemas/input.schema.json",
      outputSchema: "./schemas/output.schema.json",
    },
    policy: {
      mode: "read_only",
      network: "deny",
      filesystem: {
        read: ["./knowledge/**"],
        write: [],
      },
      mcpTools: [],
    },
    assets: ["./knowledge/README.md", "./evals/cases.json"],
  })
}

function skillTemplate(name: string): string {
  return `---
name: ${name}
description: A read-only digital employee that answers from approved knowledge and escalates uncertainty.
---

# ${name}

## Role

Answer the user's task using only approved knowledge and capabilities declared by this employee package.

## Operating rules

1. Read before answering and cite the approved source used.
2. State uncertainty instead of inventing missing facts.
3. Do not write files, execute business actions, or use undeclared tools.
4. Escalate when evidence is insufficient or the request requires an action.

## Knowledge

Start with files under \`knowledge/\`. MCP capabilities may be added explicitly in \`employee.json\` later.
`
}

const INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: {
    message: { type: "string", minLength: 1, maxLength: 20_000 },
    context: { type: "object" },
  },
}

const OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["status", "answer", "citations"],
  properties: {
    status: { enum: ["answered", "escalated"] },
    answer: { type: ["string", "null"] },
    citations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "uri"],
        properties: {
          label: { type: "string" },
          uri: { type: "string" },
        },
      },
    },
    escalation: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["reason", "message"],
      properties: {
        reason: { type: "string" },
        message: { type: "string" },
        target: { type: "string" },
      },
    },
  },
  allOf: [
    {
      if: { properties: { status: { const: "escalated" } } },
      then: {
        required: ["escalation"],
        properties: { escalation: { type: "object" } },
      },
    },
  ],
}

export async function createEmployeePackage(
  requestedDirectory: string,
  options: CreateEmployeePackageOptions = {},
): Promise<EmployeePackageSummary> {
  const directory = path.resolve(requestedDirectory)
  const name = requirePackageName(
    options.name?.trim() || packageNameFromDirectory(directory),
  )
  if (name !== path.basename(directory)) {
    throw new TypeError("employee_name_must_match_directory")
  }
  const author = options.author?.trim() || "your-team"
  if (!author || /[\u0000-\u001f\u007f]/.test(author) || author.length > 256) {
    throw new TypeError("invalid_employee_author")
  }

  await assertNewDirectoryTarget(directory)
  const manifest = employeeManifest(name, author)
  const files: Array<[string, string]> = [
    [EMPLOYEE_PACKAGE_MANIFEST_NAME, `${JSON.stringify(manifest, null, 2)}\n`],
    ["SKILL.md", skillTemplate(name)],
    ["schemas/input.schema.json", `${JSON.stringify(INPUT_SCHEMA, null, 2)}\n`],
    ["schemas/output.schema.json", `${JSON.stringify(OUTPUT_SCHEMA, null, 2)}\n`],
    [
      "knowledge/README.md",
      "# Approved knowledge\n\nReplace this file with reviewed, source-attributed knowledge for the employee.\n",
    ],
    [
      "evals/cases.json",
      `${JSON.stringify({ schemaVersion: "employee-evals.v1alpha1", cases: [] }, null, 2)}\n`,
    ],
  ]
  const temporaryDirectory = await mkdtemp(
    path.join(path.dirname(directory), `.digital-employee-${name}-`),
  )
  try {
    await Promise.all([
      mkdir(path.join(temporaryDirectory, "schemas")),
      mkdir(path.join(temporaryDirectory, "knowledge")),
      mkdir(path.join(temporaryDirectory, "evals")),
    ])
    await Promise.all(
      files.map(([relativePath, content]) =>
        writeFile(path.join(temporaryDirectory, relativePath), content, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        }),
      ),
    )
    await rename(temporaryDirectory, directory)
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true })
    throw error
  }

  return { directory, manifest, files: files.map(([file]) => `./${file}`) }
}

async function readBoundedFile(
  filePath: string,
  maxBytes: number,
  label: string,
): Promise<string> {
  const stat = await lstat(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new TypeError(`employee_package_file_must_be_regular:${label}`)
  }
  if (stat.size > maxBytes) {
    throw new TypeError(`employee_package_file_too_large:${label}`)
  }
  return readFile(filePath, "utf8")
}

async function resolvePackageFile(
  directory: string,
  portablePath: string,
): Promise<string> {
  const resolved = path.resolve(directory, portablePath.slice(2))
  const relative = path.relative(directory, resolved)
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new TypeError(`employee_package_path_escape_not_allowed:${portablePath}`)
  }
  const segments = relative.split(path.sep)
  let current = directory
  for (const segment of segments) {
    current = path.join(current, segment)
    const stat = await lstat(current)
    if (stat.isSymbolicLink()) {
      throw new TypeError(`employee_package_symlink_not_allowed:${portablePath}`)
    }
  }
  return resolved
}

function validateSkillFrontmatter(content: string, expectedName: string): void {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) throw new TypeError("employee_skill_frontmatter_required")
  const document = parseDocument(match[1], {
    strict: true,
    uniqueKeys: true,
  })
  if (document.errors.length > 0) {
    throw new TypeError("employee_skill_frontmatter_invalid_yaml")
  }
  const fields = document.toJS({ maxAliasCount: 10 }) as unknown
  assertPlainObject(fields, "SKILL.md frontmatter")
  if (fields.name !== expectedName) {
    throw new TypeError("employee_skill_name_mismatch")
  }
  if (
    typeof fields.description !== "string" ||
    !fields.description.trim() ||
    fields.description.length > 1_024
  ) {
    throw new TypeError("employee_skill_description_required")
  }
}

function parseJsonObject(content: string, label: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(content) as unknown
  } catch {
    throw new TypeError(`employee_package_invalid_json:${label}`)
  }
  assertPlainObject(value, label)
  return value
}

function validateJsonSchema(
  content: string,
  label: string,
): Record<string, unknown> {
  const schema = parseJsonObject(content, label)
  try {
    const ajv = new Ajv2020({
      allErrors: true,
      allowUnionTypes: true,
      strict: false,
      validateSchema: true,
    })
    ajv.compile(schema)
  } catch {
    throw new TypeError(`employee_package_invalid_json_schema:${label}`)
  }
  return schema
}

export async function inspectEmployeePackage(
  requestedDirectory: string,
): Promise<EmployeePackageInspection> {
  const directory = path.resolve(requestedDirectory)
  const root = await lstat(directory)
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new TypeError("employee_package_root_must_be_a_real_directory")
  }

  const manifestPath = path.join(directory, EMPLOYEE_PACKAGE_MANIFEST_NAME)
  const manifestContent = await readBoundedFile(
    manifestPath,
    MAX_MANIFEST_BYTES,
    EMPLOYEE_PACKAGE_MANIFEST_NAME,
  )
  let manifestValue: unknown
  try {
    manifestValue = JSON.parse(manifestContent) as unknown
  } catch {
    throw new TypeError("employee_package_manifest_invalid_json")
  }
  const manifest = validateEmployeePackageManifest(manifestValue)

  const entrypointFiles = [
    manifest.entrypoints.skill,
    manifest.entrypoints.inputSchema,
    manifest.entrypoints.outputSchema,
    ...(manifest.entrypoints.mcp ? [manifest.entrypoints.mcp] : []),
  ]
  const files = [...new Set([...entrypointFiles, ...manifest.assets])]
  if (files.length > MAX_DECLARED_FILES) {
    throw new TypeError("employee_package_too_many_declared_files")
  }
  const resolved = new Map<string, string>()
  for (const file of files) resolved.set(file, await resolvePackageFile(directory, file))
  let totalBytes = 0
  for (const [file, filePath] of resolved) {
    const stat = await lstat(filePath)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new TypeError(`employee_package_file_must_be_regular:${file}`)
    }
    totalBytes += stat.size
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new TypeError("employee_package_declared_files_too_large")
    }
  }

  const skill = await readBoundedFile(
    resolved.get(manifest.entrypoints.skill)!,
    MAX_SKILL_BYTES,
    manifest.entrypoints.skill,
  )
  const skillPath = resolved.get(manifest.entrypoints.skill)!
  if (
    path.basename(skillPath) !== "SKILL.md" ||
    path.basename(path.dirname(skillPath)) !== manifest.name
  ) {
    throw new TypeError("employee_skill_directory_mismatch")
  }
  validateSkillFrontmatter(skill, manifest.name)

  const inputSchemaContent = await readBoundedFile(
    resolved.get(manifest.entrypoints.inputSchema)!,
    MAX_SCHEMA_BYTES,
    manifest.entrypoints.inputSchema,
  )
  const inputSchema = validateJsonSchema(
    inputSchemaContent,
    manifest.entrypoints.inputSchema,
  )
  const outputSchemaContent = await readBoundedFile(
    resolved.get(manifest.entrypoints.outputSchema)!,
    MAX_SCHEMA_BYTES,
    manifest.entrypoints.outputSchema,
  )
  const outputSchema = validateJsonSchema(
    outputSchemaContent,
    manifest.entrypoints.outputSchema,
  )

  let mcpManifest: EmployeeMcpManifest | undefined
  if (manifest.entrypoints.mcp) {
    const mcp = await readBoundedFile(
      resolved.get(manifest.entrypoints.mcp)!,
      MAX_SCHEMA_BYTES,
      manifest.entrypoints.mcp,
    )
    mcpManifest = validateEmployeeMcpManifest(
      parseJsonObject(mcp, manifest.entrypoints.mcp),
    )
  }

  for (const asset of manifest.assets) {
    await readBoundedFile(resolved.get(asset)!, MAX_ASSET_BYTES, asset)
  }

  return {
    directory,
    manifest,
    files,
    artifacts: {
      skill,
      inputSchema,
      outputSchema,
      ...(mcpManifest ? { mcp: mcpManifest } : {}),
    },
  }
}
