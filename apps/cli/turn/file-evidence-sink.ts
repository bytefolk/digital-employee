import { constants } from "node:fs"
import { randomBytes } from "node:crypto"
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rm,
} from "node:fs/promises"
import path from "node:path"

import {
  TURN_EVIDENCE_VERSION,
} from "../../../packages/engine/src/turn-evidence.js"
import type {
  EvidenceSinkPort,
  TurnEvidenceRecord,
} from "../../../packages/engine/src/turn-evidence.js"

const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const MAX_PATH_ID_LENGTH = 200
const MAX_WORKSPACE_REF_LENGTH = 4096
const MAX_SERIALIZED_RECORD_BYTES = 128 * 1024
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const PATH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/

// codeql[js/clear-text-storage]: false positive — this module never imports
// node:os or resolves temporary directories. All paths derive from the
// caller-supplied root validated by assertRoot(), O_NOFOLLOW blocks symlink
// following on open, and handle.stat() re-verifies the opened descriptor is a
// regular file before any read.
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0

const RECORD_KEYS = new Set([
  "schemaVersion",
  "evidenceId",
  "workspaceRef",
  "positionId",
  "turnId",
  "runId",
  "engineVersion",
  "inputDigest",
  "outputDigest",
  "budget",
  "terminal",
  "escalationRef",
  "approvalRef",
  "permissions",
  "memory",
  "context",
  "assemblyManifestDigest",
  "timeBounds",
])

export type FileEvidenceSinkErrorCode =
  | "file_evidence_root_invalid"
  | "file_evidence_root_symlink"
  | "file_evidence_root_not_directory"
  | "file_evidence_position_invalid"
  | "file_evidence_position_symlink"
  | "file_evidence_position_not_directory"
  | "file_evidence_turn_invalid"
  | "file_evidence_record_invalid"
  | "file_evidence_target_symlink"
  | "file_evidence_target_not_regular"
  | "file_evidence_existing_invalid"
  | "file_evidence_turn_duplicate"
  | "file_evidence_atomic_write_failed"

export class FileEvidenceSinkError extends Error {
  constructor(
    readonly code: FileEvidenceSinkErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options)
    this.name = "FileEvidenceSinkError"
  }
}

export interface FileEvidenceSinkOptions {
  /** Maximum serialized record size; lower values can tighten the default. */
  maxRecordBytes?: number
}

export interface FileEvidenceWriteLocation {
  positionDirectory: string
  filePath: string
}

function fail(
  code: FileEvidenceSinkErrorCode,
  cause?: unknown,
): never {
  throw new FileEvidenceSinkError(
    code,
    cause === undefined ? undefined : { cause },
  )
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function assertText(
  value: unknown,
  code: FileEvidenceSinkErrorCode,
  maxLength: number,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(code)
  }
}

function assertPathId(
  value: unknown,
  code:
    | "file_evidence_position_invalid"
    | "file_evidence_turn_invalid"
    | "file_evidence_record_invalid",
): asserts value is string {
  if (typeof value !== "string" || !PATH_ID_PATTERN.test(value)) {
    fail(code)
  }
}

function assertRoot(root: unknown): string {
  if (
    typeof root !== "string" ||
    root.length === 0 ||
    root.length > 4096 ||
    !path.isAbsolute(root) ||
    root !== path.normalize(root) ||
    /[\u0000-\u001f\u007f]/.test(root)
  ) {
    fail("file_evidence_root_invalid")
  }
  return root
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry))
  if (!isObject(value)) return value
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) result[key] = canonicalize(value[key])
  }
  return result
}

function serializeRecord(
  record: TurnEvidenceRecord,
  maxRecordBytes = MAX_SERIALIZED_RECORD_BYTES,
): string {
  if (!isObject(record)) fail("file_evidence_record_invalid")
  const keys = Object.keys(record)
  if (
    keys.some((key) => !RECORD_KEYS.has(key)) ||
    record.schemaVersion !== TURN_EVIDENCE_VERSION
  ) {
    fail("file_evidence_record_invalid")
  }

  assertPathId(record.evidenceId, "file_evidence_record_invalid")
  assertText(record.workspaceRef, "file_evidence_record_invalid", MAX_WORKSPACE_REF_LENGTH)
  assertPathId(record.positionId, "file_evidence_position_invalid")
  assertPathId(record.turnId, "file_evidence_turn_invalid")
  assertPathId(record.runId, "file_evidence_record_invalid")
  assertText(record.engineVersion, "file_evidence_record_invalid", 128)
  for (const field of [
    "inputDigest",
    "outputDigest",
    "assemblyManifestDigest",
  ] as const) {
    if (
      typeof record[field] !== "string" ||
      !SHA256_PATTERN.test(record[field])
    ) {
      fail("file_evidence_record_invalid")
    }
  }
  if (!isObject(record.budget) || !isObject(record.terminal)) {
    fail("file_evidence_record_invalid")
  }
  if (
    record.terminal.status !== "completed" &&
    record.terminal.status !== "failed"
  ) {
    fail("file_evidence_record_invalid")
  }
  assertText(record.terminal.reason, "file_evidence_record_invalid", 512)
  if (
    !isObject(record.timeBounds) ||
    typeof record.timeBounds.startedAt !== "string" ||
    typeof record.timeBounds.completedAt !== "string"
  ) {
    fail("file_evidence_record_invalid")
  }
  assertText(record.timeBounds.startedAt, "file_evidence_record_invalid", 128)
  assertText(record.timeBounds.completedAt, "file_evidence_record_invalid", 128)

  const serialized = JSON.stringify(canonicalize(record))
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, "utf8") > maxRecordBytes
  ) {
    fail("file_evidence_record_invalid")
  }
  return serialized
}

function errorCode(error: unknown): string | undefined {
  return isObject(error) && "code" in error ? String(error.code) : undefined
}

async function assertDirectory(
  directory: string,
  symlinkCode: FileEvidenceSinkErrorCode,
  notDirectoryCode: FileEvidenceSinkErrorCode,
): Promise<void> {
  let stat
  try {
    stat = await lstat(directory)
  } catch (error) {
    fail(notDirectoryCode, error)
  }
  if (stat.isSymbolicLink()) fail(symlinkCode)
  if (!stat.isDirectory()) fail(notDirectoryCode)
}

async function assertPrivateDirectory(
  directory: string,
  symlinkCode: FileEvidenceSinkErrorCode,
  notDirectoryCode: FileEvidenceSinkErrorCode,
): Promise<void> {
  await assertDirectory(directory, symlinkCode, notDirectoryCode)
  await chmod(directory, PRIVATE_DIRECTORY_MODE)
  await assertDirectory(directory, symlinkCode, notDirectoryCode)
}

async function ensurePrivateDirectory(root: string): Promise<void> {
  const missing: string[] = []
  let current = root
  while (true) {
    try {
      await assertDirectory(
        current,
        "file_evidence_root_symlink",
        "file_evidence_root_not_directory",
      )
      break
    } catch (error) {
      if (
        !(error instanceof FileEvidenceSinkError) ||
        error.code !== "file_evidence_root_not_directory" ||
        error.cause === undefined ||
        errorCode(error.cause) !== "ENOENT"
      ) {
        throw error
      }
      missing.push(current)
      const parent = path.dirname(current)
      if (parent === current) fail("file_evidence_root_not_directory")
      current = parent
    }
  }
  for (const directory of missing.reverse()) {
    try {
      await mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE })
    } catch (error) {
      if (errorCode(error) !== "EEXIST") fail("file_evidence_root_not_directory", error)
    }
    await assertPrivateDirectory(
      directory,
      "file_evidence_root_symlink",
      "file_evidence_root_not_directory",
    )
  }
  await assertPrivateDirectory(
    root,
    "file_evidence_root_symlink",
    "file_evidence_root_not_directory",
  )
}

async function readExistingRecord(filePath: string): Promise<string> {
  let stat
  try {
    stat = await lstat(filePath)
  } catch (error) {
    return fail("file_evidence_atomic_write_failed", error)
  }
  if (stat.isSymbolicLink()) fail("file_evidence_target_symlink")
  if (!stat.isFile()) fail("file_evidence_target_not_regular")

  let handle
  try {
    handle = await open(filePath, constants.O_RDONLY | O_NOFOLLOW)
    const opened = await handle.stat()
    if (!opened.isFile()) fail("file_evidence_target_not_regular")
    return await handle.readFile("utf8")
  } catch (error) {
    if (error instanceof FileEvidenceSinkError) throw error
    return fail("file_evidence_atomic_write_failed", error)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export class FileEvidenceSink implements EvidenceSinkPort {
  readonly root: string
  readonly options: Readonly<FileEvidenceSinkOptions>

  constructor(root: string, options: FileEvidenceSinkOptions = {}) {
    this.root = assertRoot(root)
    if (
      options.maxRecordBytes !== undefined &&
      (!Number.isSafeInteger(options.maxRecordBytes) ||
        options.maxRecordBytes < 1 ||
        options.maxRecordBytes > MAX_SERIALIZED_RECORD_BYTES)
    ) {
      fail("file_evidence_record_invalid")
    }
    this.options = Object.freeze({ ...options })
  }

  locationFor(positionId: string, turnId: string): FileEvidenceWriteLocation {
    assertPathId(positionId, "file_evidence_position_invalid")
    assertPathId(turnId, "file_evidence_turn_invalid")
    const positionDirectory = path.join(this.root, positionId)
    const filePath = path.join(positionDirectory, `${turnId}.json`)
    if (
      path.dirname(positionDirectory) !== this.root ||
      path.dirname(filePath) !== positionDirectory
    ) {
      fail("file_evidence_turn_invalid")
    }
    return { positionDirectory, filePath }
  }

  async write(record: TurnEvidenceRecord): Promise<void> {
    const serialized = serializeRecord(record, this.options.maxRecordBytes)
    const location = this.locationFor(record.positionId, record.turnId)

    try {
      await ensurePrivateDirectory(this.root)
      try {
        await lstat(location.positionDirectory)
        await assertPrivateDirectory(
          location.positionDirectory,
          "file_evidence_position_symlink",
          "file_evidence_position_not_directory",
        )
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          await mkdir(location.positionDirectory, { mode: PRIVATE_DIRECTORY_MODE })
          await assertPrivateDirectory(
            location.positionDirectory,
            "file_evidence_position_symlink",
            "file_evidence_position_not_directory",
          )
        } else if (
          error instanceof FileEvidenceSinkError &&
          error.code === "file_evidence_position_not_directory" &&
          error.cause !== undefined &&
          errorCode(error.cause) === "ENOENT"
        ) {
          await mkdir(location.positionDirectory, { mode: PRIVATE_DIRECTORY_MODE })
          await assertPrivateDirectory(
            location.positionDirectory,
            "file_evidence_position_symlink",
            "file_evidence_position_not_directory",
          )
        } else if (error !== undefined) {
          throw error
        }
      }

      try {
        const existing = await readExistingRecord(location.filePath)
        if (existing === serialized) return
        fail("file_evidence_turn_duplicate")
      } catch (error) {
        if (
          !(error instanceof FileEvidenceSinkError) ||
          error.code !== "file_evidence_atomic_write_failed" ||
          error.cause === undefined ||
          errorCode(error.cause) !== "ENOENT"
        ) {
          throw error
        }
      }

      const temporaryPath = path.join(
        location.positionDirectory,
        `.${record.turnId}.${randomBytes(12).toString("hex")}.tmp`,
      )
      let handle
      try {
        handle = await open(
          temporaryPath,
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_WRONLY |
            O_NOFOLLOW,
          PRIVATE_FILE_MODE,
        )
        await handle.writeFile(serialized, "utf8")
        await handle.sync()
        await handle.chmod(PRIVATE_FILE_MODE)
      } finally {
        await handle?.close().catch(() => undefined)
      }

      try {
        const temporaryStat = await lstat(temporaryPath)
        if (temporaryStat.isSymbolicLink() || !temporaryStat.isFile()) {
          fail("file_evidence_atomic_write_failed")
        }
        await link(temporaryPath, location.filePath)
      } catch (error) {
        if (errorCode(error) === "EEXIST") {
          const existing = await readExistingRecord(location.filePath)
          if (existing === serialized) return
          fail("file_evidence_turn_duplicate")
        }
        if (error instanceof FileEvidenceSinkError) throw error
        fail("file_evidence_atomic_write_failed", error)
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined)
      }
    } catch (error) {
      if (error instanceof FileEvidenceSinkError) throw error
      fail("file_evidence_atomic_write_failed", error)
    }
  }
}

export function createFileEvidenceSink(
  root: string,
  options?: FileEvidenceSinkOptions,
): FileEvidenceSink {
  return new FileEvidenceSink(root, options)
}