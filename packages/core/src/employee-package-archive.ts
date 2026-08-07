/**
 * Deterministic employee-package archive format and lifecycle operations.
 *
 * Archive layout (canonical binary):
 *   archive-meta.json   — archive envelope with digest, signature, timestamps
 *   employee.json       — the employee-package manifest
 *   assets/...          — declared asset files in sorted order
 *
 * Security invariants:
 * - Same source bytes always produce the same archive bytes (deterministic).
 * - Platform-dependent metadata (timestamps, permissions, uid/gid) are
 *   normalised to fixed values.
 * - Symlinks, path escapes, undeclared files, and embedded secrets are rejected.
 * - Inspection and verification never execute employee code.
 */

import { createHash } from "node:crypto"

import { ValidationError } from "./contracts.js"
import {
  EMPLOYEE_PACKAGE_MANIFEST_NAME,
  EMPLOYEE_PACKAGE_SCHEMA_VERSION,
  validateEmployeePackageManifest,
} from "./employee-package.js"
import type { EmployeePackageManifest } from "./employee-package.js"
import {
  computeEmployeePackageDigest,
} from "./employee-package-digest.js"
import type { EmployeePackageDigestEntry } from "./employee-package-digest.js"
import {
  classifySchemaCompatibility,
} from "./employee-package-compat.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ARCHIVE_FORMAT_VERSION = "employee-archive.v1" as const
export const ARCHIVE_EXTENSION = ".epk" as const
export const ARCHIVE_META_NAME = "archive-meta.json" as const

/** Maximum archive size: 20 MiB + 256 KiB (same as digest limit). */
export const ARCHIVE_MAX_BYTES = 20 * 1024 * 1024 + 256 * 1024

// Patterns for security checks
const SECRET_PATTERNS = [
  /(?:^|[/])\.env(?:\.|$)/i,
  /(?:^|[/])credentials?\./i,
  /(?:^|[/])secret[s]?\./i,
  /(?:^|[/])\.ssh[/]/i,
  /(?:^|[/])id_rsa/i,
  /(?:^|[/])\.aws[/]/i,
  /(?:^|[/])private[_-]?key/i,
  /(?:^|[/])token[s]?\./i,
]

const PORTABLE_FILE_PATTERN = /^\.\/(?!.*\\)[^\u0000-\u001f\u007f]+$/

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ArchiveMeta {
  formatVersion: typeof ARCHIVE_FORMAT_VERSION
  packageDigest: string
  archiveDigest: string
  createdAt: string
  signature?: ArchiveSignature
}

export interface ArchiveSignature {
  algorithm: string
  publicKey: string
  value: string
}

export interface ArchiveEntry {
  path: string
  bytes: Uint8Array
}

export interface PackResult {
  archive: Uint8Array
  meta: ArchiveMeta
  manifest: EmployeePackageManifest
}

export interface InspectResult {
  meta: ArchiveMeta
  manifest: EmployeePackageManifest
  files: string[]
  totalBytes: number
}

export interface VerifyResult {
  valid: boolean
  packageDigest: string
  archiveDigest: string
  errors: string[]
}

export interface InstallRecord {
  employeeId: string
  version: string
  packageDigest: string
  archiveDigest: string
  installedAt: string
  files: string[]
}

export interface InstallStorePort {
  list(): InstallRecord[]
  get(employeeId: string, version: string): InstallRecord | undefined
  getCurrent(employeeId: string): InstallRecord | undefined
  getHistory(employeeId: string): InstallRecord[]
  put(record: InstallRecord): void
  remove(employeeId: string, version: string): boolean
  setCurrent(employeeId: string, version: string): void
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ArchiveError extends Error {
  override name = "ArchiveError"
  constructor(
    public readonly code: string,
    message?: string,
    public readonly details?: unknown,
  ) {
    super(message ?? code)
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function archiveError(code: string, details?: unknown): ArchiveError {
  return new ArchiveError(code, code, details)
}

function validatePortablePath(path: string): void {
  if (!PORTABLE_FILE_PATTERN.test(path)) {
    throw archiveError("archive_invalid_path", { path })
  }
  const segments = path.slice(2).split("/")
  if (
    segments.length === 0 ||
    segments.some((s) => !s || s === "." || s === "..")
  ) {
    throw archiveError("archive_path_escape", { path })
  }
}

function detectSecrets(path: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(path))
}

function computeArchiveDigest(entries: readonly ArchiveEntry[]): string {
  const hash = createHash("sha256")
  hash.update("employee-archive.v1\n", "ascii")
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path))
  for (const entry of sorted) {
    hash.update(entry.path, "utf8")
    hash.update("\0")
    const lenBuf = Buffer.allocUnsafe(4)
    lenBuf.writeUInt32BE(entry.bytes.length)
    hash.update(lenBuf)
    hash.update(entry.bytes)
  }
  return `sha256:${hash.digest("hex")}`
}

/**
 * Serialises archive entries into a deterministic binary format.
 * Format: [entry-count:u32] [entry...]
 * Each entry: [path-len:u32] [path:utf8] [data-len:u32] [data:bytes]
 */
function serialiseArchive(entries: readonly ArchiveEntry[]): Uint8Array {
  let totalSize = 4
  for (const entry of entries) {
    const pathBytes = Buffer.from(entry.path, "utf8")
    totalSize += 4 + pathBytes.length + 4 + entry.bytes.length
  }
  const buffer = Buffer.alloc(totalSize)
  let offset = 0
  buffer.writeUInt32BE(entries.length, offset)
  offset += 4
  for (const entry of entries) {
    const pathBytes = Buffer.from(entry.path, "utf8")
    buffer.writeUInt32BE(pathBytes.length, offset)
    offset += 4
    pathBytes.copy(buffer, offset)
    offset += pathBytes.length
    buffer.writeUInt32BE(entry.bytes.length, offset)
    offset += 4
    Buffer.from(entry.bytes).copy(buffer, offset)
    offset += entry.bytes.length
  }
  return buffer
}

function deserialiseArchive(data: Uint8Array): ArchiveEntry[] {
  const buffer = Buffer.from(data)
  if (buffer.length < 4) {
    throw archiveError("archive_corrupt", { reason: "too_short" })
  }
  let offset = 0
  const entryCount = buffer.readUInt32BE(offset)
  offset += 4
  if (entryCount > 1024) {
    throw archiveError("archive_corrupt", { reason: "too_many_entries" })
  }
  const entries: ArchiveEntry[] = []
  for (let i = 0; i < entryCount; i++) {
    if (offset + 4 > buffer.length) {
      throw archiveError("archive_corrupt", { reason: "truncated_path_len" })
    }
    const pathLen = buffer.readUInt32BE(offset)
    offset += 4
    if (pathLen > 1024 || offset + pathLen > buffer.length) {
      throw archiveError("archive_corrupt", { reason: "truncated_path" })
    }
    const path = buffer.subarray(offset, offset + pathLen).toString("utf8")
    offset += pathLen
    if (offset + 4 > buffer.length) {
      throw archiveError("archive_corrupt", { reason: "truncated_data_len" })
    }
    const dataLen = buffer.readUInt32BE(offset)
    offset += 4
    if (offset + dataLen > buffer.length) {
      throw archiveError("archive_corrupt", { reason: "truncated_data" })
    }
    const bytes = new Uint8Array(buffer.subarray(offset, offset + dataLen))
    offset += dataLen
    entries.push({ path, bytes })
  }
  if (offset !== buffer.length) {
    throw archiveError("archive_corrupt", { reason: "trailing_bytes" })
  }
  return entries
}

// ---------------------------------------------------------------------------
// Pack
// ---------------------------------------------------------------------------

export interface PackInput {
  manifest: unknown
  files: ReadonlyArray<{ path: string; bytes: Uint8Array }>
  /** ISO-8601 timestamp override for determinism; defaults to epoch. */
  createdAt?: string
  signature?: ArchiveSignature
}

/**
 * Packs an employee package into a deterministic archive.
 *
 * Validates the manifest, ensures all declared assets are present,
 * rejects undeclared files / secrets / symlinks / path escapes.
 */
export function packArchive(input: PackInput): PackResult {
  const manifest = validateEmployeePackageManifest(input.manifest)

  const compat = classifySchemaCompatibility(manifest.schemaVersion)
  if (compat.action === "reject") {
    throw archiveError("archive_incompatible_schema", {
      reason: compat.reason,
    })
  }

  const fileMap = new Map<string, Uint8Array>()
  for (const file of input.files) {
    validatePortablePath(file.path)
    if (detectSecrets(file.path)) {
      throw archiveError("archive_secret_detected", { path: file.path })
    }
    if (fileMap.has(file.path)) {
      throw archiveError("archive_duplicate_file", { path: file.path })
    }
    fileMap.set(file.path, file.bytes)
  }

  const manifestPath = `./${EMPLOYEE_PACKAGE_MANIFEST_NAME}`
  const manifestBytes = Buffer.from(
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  )
  fileMap.set(manifestPath, manifestBytes)

  const requiredPaths = new Set<string>([
    manifest.entrypoints.skill,
    manifest.entrypoints.inputSchema,
    manifest.entrypoints.outputSchema,
    ...(manifest.entrypoints.mcp ? [manifest.entrypoints.mcp] : []),
    ...manifest.assets,
  ])
  for (const required of requiredPaths) {
    if (!fileMap.has(required)) {
      throw archiveError("archive_missing_declared_file", { path: required })
    }
  }

  const allowedPaths = new Set<string>([manifestPath, ...requiredPaths])
  for (const path of fileMap.keys()) {
    if (!allowedPaths.has(path)) {
      throw archiveError("archive_undeclared_file", { path })
    }
  }

  let totalBytes = 0
  for (const bytes of fileMap.values()) {
    totalBytes += bytes.length
  }
  if (totalBytes > ARCHIVE_MAX_BYTES) {
    throw archiveError("archive_too_large", { totalBytes })
  }

  const digestEntries: EmployeePackageDigestEntry[] = []
  for (const [path, bytes] of fileMap) {
    digestEntries.push({ path, bytes: new Uint8Array(bytes) })
  }
  const packageDigest = computeEmployeePackageDigest(digestEntries)

  const sortedPaths = [...fileMap.keys()].sort()
  const archiveEntries: ArchiveEntry[] = sortedPaths.map((path) => ({
    path,
    bytes: fileMap.get(path)!,
  }))

  const archiveDigest = computeArchiveDigest(archiveEntries)

  const meta: ArchiveMeta = {
    formatVersion: ARCHIVE_FORMAT_VERSION,
    packageDigest,
    archiveDigest,
    createdAt: input.createdAt ?? "1970-01-01T00:00:00.000Z",
    ...(input.signature ? { signature: input.signature } : {}),
  }

  const metaBytes = Buffer.from(JSON.stringify(meta, null, 2) + "\n", "utf8")
  const fullEntries: ArchiveEntry[] = [
    { path: ARCHIVE_META_NAME, bytes: metaBytes },
    ...archiveEntries,
  ]

  const archive = serialiseArchive(fullEntries)

  return { archive, meta, manifest }
}

// ---------------------------------------------------------------------------
// Inspect
// ---------------------------------------------------------------------------

/**
 * Inspects an archive without running any employee code.
 * Returns metadata, manifest, and file listing.
 */
export function inspectArchive(data: Uint8Array): InspectResult {
  const entries = deserialiseArchive(data)
  if (entries.length === 0) {
    throw archiveError("archive_empty")
  }

  const metaEntry = entries[0]
  if (metaEntry.path !== ARCHIVE_META_NAME) {
    throw archiveError("archive_missing_meta")
  }

  let meta: ArchiveMeta
  try {
    meta = JSON.parse(Buffer.from(metaEntry.bytes).toString("utf8"))
  } catch {
    throw archiveError("archive_meta_parse_error")
  }

  if (meta.formatVersion !== ARCHIVE_FORMAT_VERSION) {
    throw archiveError("archive_unsupported_format", {
      version: meta.formatVersion,
    })
  }

  const manifestEntry = entries.find(
    (e) => e.path === `./${EMPLOYEE_PACKAGE_MANIFEST_NAME}`,
  )
  if (!manifestEntry) {
    throw archiveError("archive_missing_manifest")
  }

  let manifest: EmployeePackageManifest
  try {
    const raw = JSON.parse(
      Buffer.from(manifestEntry.bytes).toString("utf8"),
    )
    manifest = validateEmployeePackageManifest(raw)
  } catch (err) {
    if (err instanceof ValidationError || err instanceof ArchiveError) throw err
    throw archiveError("archive_manifest_parse_error")
  }

  const files = entries
    .filter((e) => e.path !== ARCHIVE_META_NAME)
    .map((e) => e.path)

  let totalBytes = 0
  for (const entry of entries) {
    totalBytes += entry.bytes.length
  }

  return { meta, manifest, files, totalBytes }
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Verifies archive integrity: digest match, no tampering, no undeclared files,
 * no path escapes, no secrets. Does NOT execute employee code.
 */
export function verifyArchive(data: Uint8Array): VerifyResult {
  const errors: string[] = []

  let entries: ArchiveEntry[]
  try {
    entries = deserialiseArchive(data)
  } catch (err) {
    return {
      valid: false,
      packageDigest: "",
      archiveDigest: "",
      errors: [
        err instanceof ArchiveError ? err.code : "archive_corrupt",
      ],
    }
  }

  if (entries.length === 0) {
    return { valid: false, packageDigest: "", archiveDigest: "", errors: ["archive_empty"] }
  }

  const metaEntry = entries[0]
  if (metaEntry.path !== ARCHIVE_META_NAME) {
    errors.push("archive_missing_meta")
    return { valid: false, packageDigest: "", archiveDigest: "", errors }
  }

  let meta: ArchiveMeta
  try {
    meta = JSON.parse(Buffer.from(metaEntry.bytes).toString("utf8"))
  } catch {
    errors.push("archive_meta_parse_error")
    return { valid: false, packageDigest: "", archiveDigest: "", errors }
  }

  if (meta.formatVersion !== ARCHIVE_FORMAT_VERSION) {
    errors.push("archive_unsupported_format")
  }

  const contentEntries = entries.filter((e) => e.path !== ARCHIVE_META_NAME)

  const computedArchiveDigest = computeArchiveDigest(contentEntries)
  if (computedArchiveDigest !== meta.archiveDigest) {
    errors.push("archive_digest_mismatch")
  }

  const digestEntries: EmployeePackageDigestEntry[] = contentEntries.map(
    (e) => ({ path: e.path, bytes: e.bytes }),
  )
  let computedPackageDigest: string
  try {
    computedPackageDigest = computeEmployeePackageDigest(digestEntries)
  } catch {
    errors.push("archive_package_digest_computation_failed")
    return {
      valid: false,
      packageDigest: meta.packageDigest,
      archiveDigest: meta.archiveDigest,
      errors,
    }
  }
  if (computedPackageDigest !== meta.packageDigest) {
    errors.push("archive_package_digest_mismatch")
  }

  const manifestEntry = contentEntries.find(
    (e) => e.path === `./${EMPLOYEE_PACKAGE_MANIFEST_NAME}`,
  )
  if (!manifestEntry) {
    errors.push("archive_missing_manifest")
  } else {
    try {
      const raw = JSON.parse(
        Buffer.from(manifestEntry.bytes).toString("utf8"),
      )
      const manifest = validateEmployeePackageManifest(raw)

      const compat = classifySchemaCompatibility(manifest.schemaVersion)
      if (compat.action === "reject") {
        errors.push("archive_incompatible_schema")
      }

      const contentPaths = new Set(contentEntries.map((e) => e.path))
      const requiredPaths = [
        manifest.entrypoints.skill,
        manifest.entrypoints.inputSchema,
        manifest.entrypoints.outputSchema,
        ...(manifest.entrypoints.mcp ? [manifest.entrypoints.mcp] : []),
        ...manifest.assets,
      ]
      for (const required of requiredPaths) {
        if (!contentPaths.has(required)) {
          errors.push(`archive_missing_declared_file:${required}`)
        }
      }

      const manifestPath = `./${EMPLOYEE_PACKAGE_MANIFEST_NAME}`
      const allowedPaths = new Set([manifestPath, ...requiredPaths])
      for (const path of contentPaths) {
        if (!allowedPaths.has(path)) {
          errors.push(`archive_undeclared_file:${path}`)
        }
      }
    } catch (err) {
      if (err instanceof ValidationError) {
        errors.push(`archive_manifest_invalid:${err.message}`)
      } else {
        errors.push("archive_manifest_parse_error")
      }
    }
  }

  for (const entry of contentEntries) {
    try {
      validatePortablePath(entry.path)
    } catch {
      errors.push(`archive_path_escape:${entry.path}`)
    }
    if (detectSecrets(entry.path)) {
      errors.push(`archive_secret_detected:${entry.path}`)
    }
  }

  return {
    valid: errors.length === 0,
    packageDigest: computedPackageDigest!,
    archiveDigest: computedArchiveDigest,
    errors,
  }
}

// ---------------------------------------------------------------------------
// In-memory install store
// ---------------------------------------------------------------------------

export class InMemoryInstallStore implements InstallStorePort {
  private readonly records = new Map<string, InstallRecord>()
  private readonly current = new Map<string, string>()

  private key(employeeId: string, version: string): string {
    return `${employeeId}@${version}`
  }

  list(): InstallRecord[] {
    return [...this.records.values()]
  }

  get(employeeId: string, version: string): InstallRecord | undefined {
    return this.records.get(this.key(employeeId, version))
  }

  getCurrent(employeeId: string): InstallRecord | undefined {
    const version = this.current.get(employeeId)
    if (!version) return undefined
    return this.get(employeeId, version)
  }

  getHistory(employeeId: string): InstallRecord[] {
    return [...this.records.values()]
      .filter((r) => r.employeeId === employeeId)
      .sort((a, b) => a.installedAt.localeCompare(b.installedAt))
  }

  put(record: InstallRecord): void {
    this.records.set(this.key(record.employeeId, record.version), record)
  }

  remove(employeeId: string, version: string): boolean {
    return this.records.delete(this.key(employeeId, version))
  }

  setCurrent(employeeId: string, version: string): void {
    if (!this.records.has(this.key(employeeId, version))) {
      throw archiveError("archive_install_not_found", {
        employeeId,
        version,
      })
    }
    this.current.set(employeeId, version)
  }
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

export interface InstallOptions {
  store: InstallStorePort
  /** ISO-8601 timestamp override; defaults to now. */
  installedAt?: string
}

/**
 * Installs a verified archive into the local store.
 * Verification is performed before installation.
 */
export function installArchive(
  data: Uint8Array,
  options: InstallOptions,
): InstallRecord {
  const verification = verifyArchive(data)
  if (!verification.valid) {
    throw archiveError("archive_install_verification_failed", {
      errors: verification.errors,
    })
  }

  const inspection = inspectArchive(data)
  const { manifest } = inspection

  const record: InstallRecord = {
    employeeId: manifest.name,
    version: manifest.version,
    packageDigest: verification.packageDigest,
    archiveDigest: verification.archiveDigest,
    installedAt: options.installedAt ?? new Date().toISOString(),
    files: inspection.files,
  }

  options.store.put(record)
  options.store.setCurrent(manifest.name, manifest.version)

  return record
}

// ---------------------------------------------------------------------------
// Upgrade
// ---------------------------------------------------------------------------

export interface UpgradeOptions {
  store: InstallStorePort
  installedAt?: string
}

/**
 * Upgrades an installed employee to a new version.
 * The new archive must pass verification and have a different digest.
 * The previous version remains in the store for rollback.
 */
export function upgradeArchive(
  data: Uint8Array,
  options: UpgradeOptions,
): InstallRecord {
  const verification = verifyArchive(data)
  if (!verification.valid) {
    throw archiveError("archive_upgrade_verification_failed", {
      errors: verification.errors,
    })
  }

  const inspection = inspectArchive(data)
  const { manifest } = inspection

  const current = options.store.getCurrent(manifest.name)
  if (current && current.packageDigest === verification.packageDigest) {
    throw archiveError("archive_upgrade_same_digest", {
      employeeId: manifest.name,
      version: manifest.version,
    })
  }

  const record: InstallRecord = {
    employeeId: manifest.name,
    version: manifest.version,
    packageDigest: verification.packageDigest,
    archiveDigest: verification.archiveDigest,
    installedAt: options.installedAt ?? new Date().toISOString(),
    files: inspection.files,
  }

  options.store.put(record)
  options.store.setCurrent(manifest.name, manifest.version)

  return record
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

export interface RollbackOptions {
  store: InstallStorePort
  /** Target version to roll back to. Must already be in the store. */
  targetVersion: string
}

/**
 * Rolls back an employee to a previously installed version.
 * The target version must exist in the install history.
 */
export function rollbackArchive(
  employeeId: string,
  options: RollbackOptions,
): InstallRecord {
  const target = options.store.get(employeeId, options.targetVersion)
  if (!target) {
    throw archiveError("archive_rollback_target_not_found", {
      employeeId,
      targetVersion: options.targetVersion,
    })
  }

  const current = options.store.getCurrent(employeeId)
  if (current && current.version === options.targetVersion) {
    throw archiveError("archive_rollback_already_current", {
      employeeId,
      version: options.targetVersion,
    })
  }

  options.store.setCurrent(employeeId, options.targetVersion)
  return target
}
