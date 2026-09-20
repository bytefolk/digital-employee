/**
 * Optional position-connectors.v1 declaration (#310).
 *
 * Validated at org apply against the CLI connector registry vocabulary.
 * Absent file: no behaviour change. Nothing consumes bindings at runtime.
 */
import { lstat, readFile } from "node:fs/promises"
import path from "node:path"

import type { RuntimeComponentKind, RuntimeComponentRegistry } from "../../../packages/core/index.js"

export const POSITION_CONNECTORS_FILE = "connectors.json"
export const POSITION_CONNECTORS_SCHEMA_VERSION = "position-connectors.v1" as const

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/
const CREDENTIAL_KEYS = [
  "apiKey",
  "token",
  "secret",
  "password",
  "clientSecret",
  "accessToken",
  "privateKey",
]

const KINDS = ["channels", "sources", "models"] as const
type ConnectorGroup = (typeof KINDS)[number]

const GROUP_TO_KIND: Record<ConnectorGroup, RuntimeComponentKind> = {
  channels: "channel",
  sources: "source",
  models: "model",
}

export interface PositionConnectorBinding {
  id: string
  env?: string
}

export interface PositionConnectorsDeclaration {
  schemaVersion: typeof POSITION_CONNECTORS_SCHEMA_VERSION
  channels?: PositionConnectorBinding[]
  sources?: PositionConnectorBinding[]
  models?: PositionConnectorBinding[]
}

function fail(code: string): never {
  throw new TypeError(code)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function fileErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined
}

function validateBinding(
  value: unknown,
  label: string,
  kind: RuntimeComponentKind,
  registry: RuntimeComponentRegistry,
): PositionConnectorBinding {
  if (!isPlainObject(value)) fail(`workspace_org_connectors_invalid:${label}`)
  for (const key of Object.keys(value)) {
    if (key !== "id" && key !== "env") {
      if (CREDENTIAL_KEYS.includes(key) || /secret|token|password|credential/i.test(key)) {
        fail(`workspace_org_connectors_credential:${label}.${key}`)
      }
      fail(`workspace_org_connectors_unknown_field:${label}.${key}`)
    }
  }
  if (typeof value.id !== "string" || !value.id.trim()) {
    fail(`workspace_org_connectors_invalid:${label}.id`)
  }
  if (value.id.includes("..") || value.id.includes("/") || value.id.includes("\\")) {
    fail(`workspace_org_connectors_traversal:${label}.id`)
  }
  if (!registry.has(kind, value.id)) {
    fail(`workspace_org_connectors_unregistered:${kind}:${value.id}`)
  }
  const binding: PositionConnectorBinding = { id: value.id }
  if (value.env !== undefined) {
    if (typeof value.env !== "string" || !ENV_NAME_PATTERN.test(value.env)) {
      fail(`workspace_org_connectors_invalid:${label}.env`)
    }
    binding.env = value.env
  }
  return binding
}

export function validatePositionConnectorsDeclaration(
  input: unknown,
  registry: RuntimeComponentRegistry,
): PositionConnectorsDeclaration {
  if (!isPlainObject(input)) fail("workspace_org_connectors_invalid")
  for (const key of Object.keys(input)) {
    if (key !== "schemaVersion" && !(KINDS as readonly string[]).includes(key)) {
      fail(`workspace_org_connectors_unknown_field:${key}`)
    }
  }
  if (input.schemaVersion !== POSITION_CONNECTORS_SCHEMA_VERSION) {
    fail(`workspace_org_connectors_invalid:schemaVersion`)
  }
  const result: PositionConnectorsDeclaration = {
    schemaVersion: POSITION_CONNECTORS_SCHEMA_VERSION,
  }
  for (const group of KINDS) {
    const value = input[group]
    if (value === undefined) continue
    if (!Array.isArray(value)) fail(`workspace_org_connectors_invalid:${group}`)
    result[group] = value.map((entry, index) =>
      validateBinding(entry, `${group}[${index}]`, GROUP_TO_KIND[group], registry),
    )
  }
  return result
}

export async function readOptionalPositionConnectors(
  positionDirectory: string,
  positionId: string,
  registry: RuntimeComponentRegistry,
): Promise<PositionConnectorsDeclaration | undefined> {
  const file = path.join(positionDirectory, POSITION_CONNECTORS_FILE)
  let stat
  try {
    stat = await lstat(file)
  } catch (error) {
    if (fileErrorCode(error) === "ENOENT") return undefined
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`workspace_org_connectors_invalid:${positionId}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(file, "utf8")) as unknown
  } catch {
    fail(`workspace_org_connectors_invalid:${positionId}`)
  }
  return validatePositionConnectorsDeclaration(parsed, registry)
}
