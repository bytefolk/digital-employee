import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rmdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises"
import { constants as fsConstants } from "node:fs"
import { randomBytes } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
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
import { computeEmployeePackageDigest } from "../../packages/core/src/employee-package-digest.js"
import type { EmployeePackageDigestEntry } from "../../packages/core/src/employee-package-digest.js"

const MAX_MANIFEST_BYTES = 256 * 1024
const MAX_SKILL_BYTES = 128 * 1024
const MAX_SCHEMA_BYTES = 256 * 1024
const MAX_ASSET_BYTES = 5 * 1024 * 1024
const MAX_DECLARED_FILES = 512
const MAX_TOTAL_BYTES = 20 * 1024 * 1024
const EMPLOYEE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const EMPLOYEE_RECIPE_IDS = [
  "minimal-answer.v1",
  "structured-action.v1",
] as const
export type EmployeeRecipeId = (typeof EMPLOYEE_RECIPE_IDS)[number]
export const DEFAULT_EMPLOYEE_RECIPE: EmployeeRecipeId = "minimal-answer.v1"

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
)
const EMPLOYEE_RECIPE_PACKAGES: Record<EmployeeRecipeId, string> = {
  "minimal-answer.v1": path.join(
    packageRoot,
    "examples",
    "recipes",
    "minimal-answer.v1",
    "minimal-answer",
  ),
  "structured-action.v1": path.join(
    packageRoot,
    "examples",
    "recipes",
    "structured-action.v1",
    "structured-action",
  ),
}

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

/** @internal Coordinates deterministic path-replacement security tests. */
export interface EmployeePackageInspectionHooks {
  beforeFileOpen?: (
    portablePath: string,
    filePath: string,
  ) => void | Promise<void>
}

export interface SealedEmployeePackageSnapshot {
  /** Local ephemeral projection; never sent to or hosted by the platform. */
  directory: string
  digest: string
  manifest: EmployeePackageManifest
  cleanup(): Promise<void>
}

export interface CreateEmployeePackageOptions {
  name?: string
  author?: string
  recipe?: string
}

/** @internal Coordinates deterministic publish-race tests. */
export interface EmployeePackageCreationHooks {
  beforePublish?: () => void | Promise<void>
  afterClaim?: () => void | Promise<void>
}

export interface CreatedEmployeePackage extends EmployeePackageSummary {
  recipe: EmployeeRecipeId
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
    throw new TypeError("init_target_already_exists")
  } catch (error) {
    if (fileErrorCode(error) !== "ENOENT") throw error
  }
  const parent = await lstat(path.dirname(directory))
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new TypeError("init_parent_must_be_a_real_directory")
  }
}

type EmployeePackageFile = readonly [portablePath: string, content: Uint8Array]

interface OwnedPackagePath {
  path: string
  device: number
  inode: number
  directory: boolean
}

interface EmployeePackageTargetClaim {
  directory: string
  device: number
  inode: number
  markerPath: string
  markerContent: string
  owned: OwnedPackagePath[]
}

async function recordOwnedPackagePath(
  filePath: string,
  directory: boolean,
): Promise<OwnedPackagePath> {
  const stat = await lstat(filePath)
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile())
  ) {
    throw new TypeError("init_publish_ownership_changed")
  }
  return {
    path: filePath,
    device: stat.dev,
    inode: stat.ino,
    directory,
  }
}

async function sameOwnedPackagePath(entry: OwnedPackagePath): Promise<boolean> {
  try {
    const stat = await lstat(entry.path)
    return !stat.isSymbolicLink() &&
      stat.dev === entry.device &&
      stat.ino === entry.inode &&
      (entry.directory ? stat.isDirectory() : stat.isFile())
  } catch {
    return false
  }
}

async function cleanupOwnedPackageTarget(
  claim: EmployeePackageTargetClaim,
): Promise<void> {
  let root
  try {
    root = await lstat(claim.directory)
    if (
      root.isSymbolicLink() ||
      !root.isDirectory() ||
      root.dev !== claim.device ||
      root.ino !== claim.inode
    ) {
      return
    }
    const marker = claim.owned[0]
    if (
      !marker ||
      marker.path !== claim.markerPath ||
      !(await sameOwnedPackagePath(marker)) ||
      (await readFile(claim.markerPath, "utf8")) !== claim.markerContent
    ) {
      return
    }
  } catch {
    return
  }

  for (const entry of [...claim.owned].reverse()) {
    if (!(await sameOwnedPackagePath(entry))) continue
    try {
      if (entry.directory) await rmdir(entry.path)
      else await unlink(entry.path)
    } catch {
      // Unknown or concurrently changed content is never removed.
    }
  }
  try {
    root = await lstat(claim.directory)
    if (
      !root.isSymbolicLink() &&
      root.isDirectory() &&
      root.dev === claim.device &&
      root.ino === claim.inode
    ) {
      await rmdir(claim.directory)
    }
  } catch {
    // A non-empty or changed target belongs to the competing writer.
  }
}

function packageDirectories(
  directory: string,
  files: readonly EmployeePackageFile[],
): string[] {
  const directories = new Set<string>()
  for (const [portablePath] of files) {
    const segments = portablePath.slice(2).split("/").slice(0, -1)
    let current = directory
    for (const segment of segments) {
      current = path.join(current, segment)
      directories.add(current)
    }
  }
  return [...directories]
}

async function writeEmployeePackageFiles(
  directory: string,
  files: readonly EmployeePackageFile[],
  owned?: OwnedPackagePath[],
): Promise<void> {
  for (const item of packageDirectories(directory, files)) {
    await mkdir(item, { mode: 0o700 })
    if (owned) owned.push(await recordOwnedPackagePath(item, true))
  }
  for (const [portablePath, content] of files) {
    const filePath = path.join(directory, portablePath.slice(2))
    await writeFile(filePath, content, {
      flag: "wx",
      mode: 0o600,
    })
    if (owned) owned.push(await recordOwnedPackagePath(filePath, false))
  }
}

function resolveEmployeeRecipeId(value: string | undefined): EmployeeRecipeId {
  const recipe = value ?? DEFAULT_EMPLOYEE_RECIPE
  if (!(EMPLOYEE_RECIPE_IDS as readonly string[]).includes(recipe)) {
    throw new TypeError(`unknown_employee_recipe:${recipe}`)
  }
  return recipe as EmployeeRecipeId
}

function renameRecipeSkill(
  content: string,
  sourceName: string,
  targetName: string,
): string {
  if (sourceName === targetName) return content
  const lines = content.split("\n")
  const frontmatterEnd = lines.indexOf("---", 1)
  const nameLines = lines
    .slice(1, frontmatterEnd)
    .map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => line === `name: ${sourceName}`)
  if (frontmatterEnd < 2 || nameLines.length !== 1) {
    throw new TypeError("employee_recipe_skill_name_not_replaceable")
  }
  lines[nameLines[0]!.index] = `name: ${targetName}`
  const heading = lines.indexOf(`# ${sourceName}`, frontmatterEnd + 1)
  if (heading >= 0) lines[heading] = `# ${targetName}`
  return lines.join("\n")
}

export async function createEmployeePackage(
  requestedDirectory: string,
  options: CreateEmployeePackageOptions = {},
  hooks: EmployeePackageCreationHooks = {},
): Promise<CreatedEmployeePackage> {
  const directory = path.resolve(requestedDirectory)
  const recipe = resolveEmployeeRecipeId(options.recipe)
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
  const recipeInspection = await inspectEmployeePackage(
    EMPLOYEE_RECIPE_PACKAGES[recipe],
  )
  const recipeEntries = await readPackageDigestEntries(
    recipeInspection.directory,
    recipeInspection,
  )
  const manifest = validateEmployeePackageManifest({
    ...recipeInspection.manifest,
    name,
    authors: [author],
  })
  const files = recipeEntries.map((entry) => {
    if (entry.path === `./${EMPLOYEE_PACKAGE_MANIFEST_NAME}`) {
      return [entry.path, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)] as const
    }
    if (entry.path === recipeInspection.manifest.entrypoints.skill) {
      return [
        entry.path,
        Buffer.from(
          renameRecipeSkill(
            Buffer.from(entry.bytes).toString("utf8"),
            recipeInspection.manifest.name,
            name,
          ),
        ),
      ] as const
    }
    return [entry.path, entry.bytes] as const
  })
  const temporaryRoot = await mkdtemp(
    path.join(path.dirname(directory), `.digital-employee-${name}-`),
  )
  const temporaryDirectory = path.join(temporaryRoot, name)
  try {
    await mkdir(temporaryDirectory, { mode: 0o700 })
    await writeEmployeePackageFiles(temporaryDirectory, files)
    await inspectEmployeePackage(temporaryDirectory)
    await hooks.beforePublish?.()
    try {
      await mkdir(directory, { mode: 0o700 })
    } catch (error) {
      if (fileErrorCode(error) === "EEXIST") {
        throw new TypeError("init_target_already_exists")
      }
      throw error
    }
    let claim: EmployeePackageTargetClaim | undefined
    try {
      const root = await lstat(directory)
      const ownershipToken = randomBytes(16).toString("hex")
      const markerPath = path.join(
        directory,
        `.digital-employee-init-claim-${ownershipToken}`,
      )
      const markerContent = `digital-employee-init-claim.v1\n${ownershipToken}\n`
      await writeFile(markerPath, markerContent, {
        flag: "wx",
        mode: 0o600,
      })
      claim = {
        directory,
        device: root.dev,
        inode: root.ino,
        markerPath,
        markerContent,
        owned: [await recordOwnedPackagePath(markerPath, false)],
      }
      await hooks.afterClaim?.()
      await writeEmployeePackageFiles(directory, files, claim.owned)
      await inspectEmployeePackage(directory)
      await unlink(markerPath)
    } catch (error) {
      if (claim) await cleanupOwnedPackageTarget(claim)
      else {
        try {
          await rmdir(directory)
        } catch {
          // A non-empty claim is preserved because ownership was not proven.
        }
      }
      throw new TypeError("init_publish_incomplete", { cause: error })
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }

  return {
    directory,
    manifest,
    files: files.map(([portablePath]) => portablePath),
    recipe,
  }
}

interface PackagePathIdentity {
  filePath: string
  portablePath: string
  components: Array<{
    path: string
    device: number
    inode: number
    mode: number
    size: number
    ctimeMs: number
    directory: boolean
  }>
}

const inspectionDigestEntries = new WeakMap<
  EmployeePackageInspection,
  EmployeePackageDigestEntry[]
>()

function samePathIdentity(
  stat: Awaited<ReturnType<typeof lstat>>,
  expected: PackagePathIdentity["components"][number],
): boolean {
  return stat.dev === expected.device &&
    stat.ino === expected.inode &&
    stat.mode === expected.mode &&
    stat.size === expected.size &&
    stat.ctimeMs === expected.ctimeMs &&
    stat.isDirectory() === expected.directory &&
    !stat.isSymbolicLink()
}

async function capturePackagePath(
  directory: string,
  portablePath: string,
  maxBytes: number,
): Promise<PackagePathIdentity> {
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
  const paths = [directory]
  let current = directory
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment)
    paths.push(current)
  }
  const components: PackagePathIdentity["components"] = []
  for (const [index, componentPath] of paths.entries()) {
    const stat = await lstat(componentPath)
    if (stat.isSymbolicLink()) {
      throw new TypeError(`employee_package_symlink_not_allowed:${portablePath}`)
    }
    const final = index === paths.length - 1
    if ((!final && !stat.isDirectory()) || (final && !stat.isFile())) {
      throw new TypeError(`employee_package_file_must_be_regular:${portablePath}`)
    }
    if (final && stat.size > maxBytes) {
      throw new TypeError(`employee_package_file_too_large:${portablePath}`)
    }
    components.push({
      path: componentPath,
      device: stat.dev,
      inode: stat.ino,
      mode: stat.mode,
      size: stat.size,
      ctimeMs: stat.ctimeMs,
      directory: stat.isDirectory(),
    })
  }
  return { filePath: resolved, portablePath, components }
}

async function assertPackagePathUnchanged(
  captured: PackagePathIdentity,
): Promise<void> {
  for (const component of captured.components) {
    let stat
    try {
      stat = await lstat(component.path)
    } catch {
      throw new TypeError(
        `employee_package_file_changed_during_snapshot:${captured.portablePath}`,
      )
    }
    if (!samePathIdentity(stat, component)) {
      throw new TypeError(
        `employee_package_file_changed_during_snapshot:${captured.portablePath}`,
      )
    }
  }
}

function freezeSharedPackageComponents(
  frozen: Map<string, PackagePathIdentity["components"][number]>,
  captured: PackagePathIdentity,
): void {
  for (const component of captured.components) {
    const expected = frozen.get(component.path)
    if (expected) {
      if (
        expected.device !== component.device ||
        expected.inode !== component.inode ||
        expected.mode !== component.mode ||
        expected.size !== component.size ||
        expected.ctimeMs !== component.ctimeMs ||
        expected.directory !== component.directory
      ) {
        throw new TypeError(
          `employee_package_file_changed_during_snapshot:${captured.portablePath}`,
        )
      }
      continue
    }
    frozen.set(component.path, component)
  }
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
    const validate = ajv.compile(schema)
    if ("$async" in validate && validate.$async === true) {
      throw new TypeError(`employee_package_invalid_json_schema:${label}`)
    }
  } catch {
    throw new TypeError(`employee_package_invalid_json_schema:${label}`)
  }
  return schema
}

export async function inspectEmployeePackage(
  requestedDirectory: string,
  hooks: EmployeePackageInspectionHooks = {},
): Promise<EmployeePackageInspection> {
  const directory = path.resolve(requestedDirectory)
  const root = await lstat(directory)
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new TypeError("employee_package_root_must_be_a_real_directory")
  }

  const manifestPortablePath = `./${EMPLOYEE_PACKAGE_MANIFEST_NAME}`
  const manifestCapture = await capturePackagePath(
    directory,
    manifestPortablePath,
    MAX_MANIFEST_BYTES,
  )
  const frozenComponents = new Map<
    string,
    PackagePathIdentity["components"][number]
  >()
  freezeSharedPackageComponents(frozenComponents, manifestCapture)
  await assertPackagePathUnchanged(manifestCapture)
  await hooks.beforeFileOpen?.(
    manifestPortablePath,
    manifestCapture.filePath,
  )
  const manifestBytes = await readRegularFileNoFollow(
    manifestCapture.filePath,
    MAX_MANIFEST_BYTES,
    manifestPortablePath,
    manifestCapture,
  )
  await assertPackagePathUnchanged(manifestCapture)
  const manifestContent = manifestBytes.toString("utf8")
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
  const byteLimit = (file: string): number => {
    if (file === manifest.entrypoints.skill) return MAX_SKILL_BYTES
    if (
      file === manifest.entrypoints.inputSchema ||
      file === manifest.entrypoints.outputSchema ||
      file === manifest.entrypoints.mcp
    ) {
      return MAX_SCHEMA_BYTES
    }
    return MAX_ASSET_BYTES
  }
  const resolved = new Map<string, PackagePathIdentity>()
  for (const file of files) {
    const captured = await capturePackagePath(directory, file, byteLimit(file))
    freezeSharedPackageComponents(frozenComponents, captured)
    resolved.set(file, captured)
  }
  let totalBytes = 0
  for (const captured of resolved.values()) {
    totalBytes += captured.components.at(-1)!.size
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new TypeError("employee_package_declared_files_too_large")
    }
  }

  const fileBytes = new Map<string, Buffer>()
  for (const [file, captured] of resolved) {
    await assertPackagePathUnchanged(captured)
    await hooks.beforeFileOpen?.(file, captured.filePath)
    const bytes = await readRegularFileNoFollow(
      captured.filePath,
      byteLimit(file),
      file,
      captured,
    )
    await assertPackagePathUnchanged(captured)
    fileBytes.set(file, bytes)
  }

  const skill = fileBytes.get(manifest.entrypoints.skill)!.toString("utf8")
  const skillPath = resolved.get(manifest.entrypoints.skill)!.filePath
  if (
    path.basename(skillPath) !== "SKILL.md" ||
    path.basename(path.dirname(skillPath)) !== manifest.name
  ) {
    throw new TypeError("employee_skill_directory_mismatch")
  }
  validateSkillFrontmatter(skill, manifest.name)

  const inputSchemaContent = fileBytes
    .get(manifest.entrypoints.inputSchema)!
    .toString("utf8")
  const inputSchema = validateJsonSchema(
    inputSchemaContent,
    manifest.entrypoints.inputSchema,
  )
  const outputSchemaContent = fileBytes
    .get(manifest.entrypoints.outputSchema)!
    .toString("utf8")
  const outputSchema = validateJsonSchema(
    outputSchemaContent,
    manifest.entrypoints.outputSchema,
  )

  let mcpManifest: EmployeeMcpManifest | undefined
  if (manifest.entrypoints.mcp) {
    const mcp = fileBytes.get(manifest.entrypoints.mcp)!.toString("utf8")
    mcpManifest = validateEmployeeMcpManifest(
      parseJsonObject(mcp, manifest.entrypoints.mcp),
    )
  }

  const inspection: EmployeePackageInspection = {
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
  inspectionDigestEntries.set(inspection, [
    { path: manifestPortablePath, bytes: manifestBytes },
    ...files.map((portablePath) => ({
      path: portablePath,
      bytes: fileBytes.get(portablePath)!,
    })),
  ])
  return inspection
}

export async function readDeclaredEmployeePackageAsset(
  inspection: EmployeePackageInspection,
  portablePath: string,
): Promise<string> {
  if (!inspection.manifest.assets.includes(portablePath)) {
    throw new TypeError(`employee_package_asset_not_declared:${portablePath}`)
  }
  const captured = await capturePackagePath(
    inspection.directory,
    portablePath,
    MAX_ASSET_BYTES,
  )
  await assertPackagePathUnchanged(captured)
  const bytes = await readRegularFileNoFollow(
    captured.filePath,
    MAX_ASSET_BYTES,
    portablePath,
    captured,
  )
  await assertPackagePathUnchanged(captured)
  return bytes.toString("utf8")
}

async function readRegularFileNoFollow(
  filePath: string,
  maxBytes: number,
  label: string,
  captured?: PackagePathIdentity,
): Promise<Buffer> {
  let handle
  try {
    handle = await open(
      filePath,
      fsConstants.O_RDONLY |
        fsConstants.O_NOFOLLOW |
        (fsConstants.O_NONBLOCK ?? 0),
    )
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > maxBytes) {
      throw new TypeError(`employee_package_file_invalid_for_snapshot:${label}`)
    }
    const expected = captured?.components.at(-1)
    if (expected && !samePathIdentity(stat, expected)) {
      throw new TypeError(`employee_package_file_changed_during_snapshot:${label}`)
    }
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      )
      if (result.bytesRead === 0) {
        throw new TypeError(`employee_package_file_changed_during_snapshot:${label}`)
      }
      offset += result.bytesRead
    }
    const overflow = Buffer.alloc(1)
    const overflowRead = await handle.read(overflow, 0, 1, bytes.length)
    const finalStat = await handle.stat()
    if (
      overflowRead.bytesRead !== 0 ||
      !samePathIdentity(finalStat, {
        path: filePath,
        device: stat.dev,
        inode: stat.ino,
        mode: stat.mode,
        size: stat.size,
        ctimeMs: stat.ctimeMs,
        directory: false,
      }) ||
      (expected && !samePathIdentity(finalStat, expected))
    ) {
      throw new TypeError(`employee_package_file_changed_during_snapshot:${label}`)
    }
    return bytes
  } catch (error) {
    if (
      error instanceof TypeError &&
      error.message.startsWith("employee_package_file_")
    ) {
      throw error
    }
    throw new TypeError(`employee_package_file_unavailable_for_snapshot:${label}`)
  } finally {
    await handle?.close()
  }
}

async function readPackageDigestEntries(
  directory: string,
  inspection: EmployeePackageInspection,
): Promise<EmployeePackageDigestEntry[]> {
  if (path.resolve(directory) !== inspection.directory) {
    throw new TypeError("employee_package_inspection_directory_mismatch")
  }
  const entries = inspectionDigestEntries.get(inspection)
  if (!entries) throw new TypeError("employee_package_inspection_bytes_unavailable")
  return entries.map((entry) => ({ path: entry.path, bytes: Buffer.from(entry.bytes) }))
}

export async function computeEmployeePackageDirectoryDigest(
  requestedDirectory: string,
): Promise<string> {
  const inspection = await inspectEmployeePackage(requestedDirectory)
  return computeEmployeePackageDigest(
    await readPackageDigestEntries(inspection.directory, inspection),
  )
}

/**
 * Copies a publisher-owned local package into a per-run read-only projection.
 * The platform supplies identity and digest only; it never supplies package
 * bytes, a path, Agent credentials, or an Agent Host.
 */
export async function createSealedEmployeePackageSnapshot(
  requestedDirectory: string,
): Promise<SealedEmployeePackageSnapshot> {
  const source = await inspectEmployeePackage(requestedDirectory)
  const entries = await readPackageDigestEntries(source.directory, source)
  const digest = computeEmployeePackageDigest(entries)
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "digital-employee-runner-"),
  )
  const directory = path.join(temporaryRoot, source.manifest.name)
  const directories = new Set<string>([directory])
  try {
    await mkdir(directory, { mode: 0o700 })
    for (const entry of entries) {
      const destination = path.join(directory, entry.path.slice(2))
      const parent = path.dirname(destination)
      await mkdir(parent, { recursive: true, mode: 0o700 })
      let current = parent
      while (current.startsWith(directory)) {
        directories.add(current)
        if (current === directory) break
        current = path.dirname(current)
      }
      await writeFile(destination, entry.bytes, {
        flag: "wx",
        mode: 0o400,
      })
    }
    const sealed = await inspectEmployeePackage(directory)
    if (
      sealed.manifest.name !== source.manifest.name ||
      sealed.manifest.version !== source.manifest.version
    ) {
      throw new TypeError("employee_package_changed_during_snapshot")
    }
    const sealedDigest = computeEmployeePackageDigest(
      await readPackageDigestEntries(directory, sealed),
    )
    if (sealedDigest !== digest) {
      throw new TypeError("employee_package_changed_during_snapshot")
    }
    for (const item of [...directories].sort((a, b) => b.length - a.length)) {
      await chmod(item, 0o500)
    }
    return {
      directory,
      digest,
      manifest: sealed.manifest,
      async cleanup() {
        for (const item of [...directories].sort((a, b) => a.length - b.length)) {
          try {
            await chmod(item, 0o700)
          } catch {
            // Cleanup remains best effort for already-removed paths.
          }
        }
        await rm(temporaryRoot, { recursive: true, force: true })
      },
    }
  } catch (error) {
    for (const item of [...directories].sort((a, b) => a.length - b.length)) {
      try {
        await chmod(item, 0o700)
      } catch {
        // Continue cleanup after partial construction.
      }
    }
    await rm(temporaryRoot, { recursive: true, force: true })
    throw error
  }
}
