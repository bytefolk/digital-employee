/**
 * Employee-package compatibility semantics.
 *
 * This module codifies the frozen compatibility rules for the employee-package
 * format, covering schema version negotiation, unknown-field handling,
 * downgrade prevention, and migration from v1alpha1 to the stable line.
 */

import { ValidationError } from "./contracts.js"
import { EMPLOYEE_PACKAGE_SCHEMA_VERSION } from "./employee-package.js"

// --- Schema version registry ---

/**
 * Ordered schema versions from oldest to newest.
 * A consumer MUST reject any version it does not recognise.
 */
export const EMPLOYEE_PACKAGE_SCHEMA_VERSIONS = Object.freeze([
  "employee-package.v1alpha1",
] as const)

export type EmployeePackageSchemaVersion =
  (typeof EMPLOYEE_PACKAGE_SCHEMA_VERSIONS)[number]

// --- Compatibility classification ---

export type CompatAction = "accept" | "migrate" | "reject"

export interface CompatDecision {
  action: CompatAction
  reason: string
  /** If action is "migrate", the source version. */
  sourceVersion?: string
  /** If action is "migrate", the target version. */
  targetVersion?: string
}

/**
 * Compatibility rules (frozen at design freeze):
 *
 * 1. EXACT MATCH: If the document schemaVersion matches the consumer's
 *    supported version, accept.
 * 2. FORWARD COMPAT (unknown fields): A consumer MUST reject unknown
 *    top-level and nested fields. This is fail-closed by design — employee
 *    packages are security boundaries and silent field drops could weaken
 *    policy enforcement.
 * 3. DOWNGRADE PREVENTION: A consumer MUST NOT process a document whose
 *    schemaVersion is newer than the consumer's newest supported version.
 * 4. MIGRATION: A consumer MAY migrate from an older recognised version to
 *    its current version using deterministic transforms. The consumer MUST
 *    NOT alter the original artifact; migration produces a new in-memory
 *    representation only.
 * 5. UNKNOWN VERSION: A consumer MUST reject any schemaVersion it does not
 *    recognise (not in its EMPLOYEE_PACKAGE_SCHEMA_VERSIONS list).
 */
export function classifySchemaCompatibility(
  documentVersion: unknown,
  consumerVersions: readonly string[] = EMPLOYEE_PACKAGE_SCHEMA_VERSIONS,
): CompatDecision {
  if (typeof documentVersion !== "string" || !documentVersion) {
    return { action: "reject", reason: "schema_version_missing" }
  }

  const consumerCurrent = consumerVersions[consumerVersions.length - 1]

  // Exact match — accept
  if (documentVersion === consumerCurrent) {
    return { action: "accept", reason: "exact_match" }
  }

  // Known older version — migrate
  const docIndex = consumerVersions.indexOf(documentVersion)
  if (docIndex >= 0 && docIndex < consumerVersions.length - 1) {
    return {
      action: "migrate",
      reason: "known_older_version",
      sourceVersion: documentVersion,
      targetVersion: consumerCurrent,
    }
  }

  // Unknown version — reject (covers both newer and unrecognised)
  if (docIndex === -1) {
    // Check if it looks like a newer version in the same family
    if (documentVersion.startsWith("employee-package.")) {
      return { action: "reject", reason: "unknown_version_no_downgrade" }
    }
    return { action: "reject", reason: "unknown_version_unrecognised" }
  }

  return { action: "reject", reason: "unknown_version_unrecognised" }
}

// --- Unknown field rejection ---

export interface UnknownFieldResult {
  valid: boolean
  unknownFields: string[]
}

/** Known fields at each object level of the employee-package manifest. */
export const EMPLOYEE_PACKAGE_KNOWN_FIELDS = Object.freeze({
  manifest: [
    "$schema",
    "schemaVersion",
    "name",
    "version",
    "description",
    "license",
    "authors",
    "host",
    "entrypoints",
    "policy",
    "assets",
  ],
  host: ["protocol", "requiredCapabilities"],
  entrypoints: ["skill", "inputSchema", "outputSchema", "mcp"],
  policy: ["mode", "network", "filesystem", "mcpTools"],
  "policy.filesystem": ["read", "write"],
  "policy.mcpTools[]": ["name", "requestedMode"],
} as const)

/**
 * Detects unknown fields at the manifest top level.
 * Full recursive detection is handled by validateEmployeePackageManifest
 * (which throws on any unknown field). This function is the language-neutral
 * specification of which fields are allowed.
 */
export function detectUnknownManifestFields(
  input: unknown,
): UnknownFieldResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, unknownFields: [] }
  }
  const unknownFields: string[] = []
  const allowed: readonly string[] = EMPLOYEE_PACKAGE_KNOWN_FIELDS.manifest
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      unknownFields.push(key)
    }
  }
  return { valid: unknownFields.length === 0, unknownFields }
}

// --- Downgrade guard ---

/**
 * Returns true if `documentVersion` is strictly newer than any version in
 * `consumerVersions` (meaning the consumer would need to downgrade to
 * process it, which is forbidden).
 */
export function isDowngradeRequired(
  documentVersion: string,
  consumerVersions: readonly string[] = EMPLOYEE_PACKAGE_SCHEMA_VERSIONS,
): boolean {
  const decision = classifySchemaCompatibility(
    documentVersion,
    consumerVersions,
  )
  return decision.reason === "unknown_version_no_downgrade"
}

// --- Digest canonical input stability ---

/**
 * The digest domain is frozen. Changing it would break all existing digests.
 * This constant is re-exported here for vector completeness.
 */
export { EMPLOYEE_PACKAGE_DIGEST_DOMAIN } from "./employee-package-digest.js"

/**
 * Digest canonical input rules (frozen):
 *
 * 1. Only portable file paths (./relative, no backslash, no control chars)
 *    and their exact byte contents are hashed.
 * 2. Entries are sorted lexicographically by UTF-8 path bytes before hashing.
 * 3. Domain separation: hash is prefixed with the frozen domain string.
 * 4. Max 513 entries, max 20 MiB + 256 KiB total.
 * 5. Duplicate paths, unsafe paths, proxy objects, and accessor properties
 *    are rejected.
 * 6. Output format: "sha256:<hex>"
 */
export const EMPLOYEE_PACKAGE_DIGEST_RULES = Object.freeze({
  domain: "digital-employee.employee-package.v1",
  algorithm: "sha256",
  maxEntries: 513,
  maxTotalBytes: 20 * 1024 * 1024 + 256 * 1024,
  maxPathLength: 1024,
  outputFormat: "sha256:<hex>",
  sortOrder: "utf8_lexicographic",
} as const)
