/**
 * Fail-closed workspace command orchestration.
 *
 * `workspace init <dir> --template <id>` materializes a workspace skeleton
 * (organization.v1alpha1.json, workspace.json, positions/, context/) into a
 * new or empty directory. The command reuses the deploy command's i18n,
 * fail-closed code, and secret-safe write conventions: input is validated
 * before any effect, a non-empty target fails with exit 1 and a localized
 * recovery line, and generated state is written with ownership tracking so a
 * failed publish leaves no partial files behind.
 */

import path from "node:path"
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises"
import { randomBytes } from "node:crypto"

import {
  computeEmployeePackageDirectoryDigest,
  inspectEmployeePackage,
} from "../employee-package.js"
import {
  detectSystemLocale,
  getAvailableLocales,
  hasMessage,
  setLocale,
  t,
} from "../deploy/i18n.js"
import type { SupportedLocale } from "../deploy/i18n.js"
import {
  WORKSPACE_POSITION_PACKAGE_VERSION,
  resolveWorkspaceTemplate,
  renderSkeletonFiles,
  renderOrganizationFile,
  workspaceRoleDirectorySegments,
  workspaceTemplateIds,
} from "./templates.js"
import type {
  WorkspaceFile,
  WorkspacePositionDigest,
  WorkspaceTemplate,
} from "./templates.js"
import { validateOrganizationBudgets } from "../org/budget.js"

export interface WorkspaceOptions {
  subcommand?: string
  args: string[]
  template?: string
  locale?: string
  json?: boolean
  help?: boolean
  providedOptions?: ReadonlySet<string>
}

export interface WorkspaceInitOptions {
  directory?: string
  template?: string
  json?: boolean
  help?: boolean
  argsCount?: number
  providedOptions?: ReadonlySet<string>
}

const WORKSPACE_SUBCOMMANDS = ["init", "help"] as const
const WORKSPACE_OPTIONS = ["template", "locale", "json", "help"]

interface WorkspaceTargetState {
  exists: boolean
  empty: boolean
}

function fileErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined
}

function supported(values: readonly string[]): string {
  return values.join("|")
}

function failInput(field: string, values: readonly string[], json: boolean): void {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ status: "failed", code: `invalid_${field}` }, null, 2)}\n`,
    )
  } else {
    process.stderr.write(
      `${t("workspace.error_invalid_value", { field, supported: supported(values) })}\n`,
    )
  }
  process.exitCode = 1
}

function failCode(key: string, code: string, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ status: "failed", code }, null, 2)}\n`)
  } else {
    process.stderr.write(`${t(key, { code })}\n`)
  }
  process.exitCode = 1
}

/**
 * Render an optional localized recovery line for a fail-closed error code.
 * Known codes have a `workspace.recovery_<code>` catalog entry; unknown codes
 * fall back to `fallbackKey` when given and otherwise print nothing.
 */
function writeRecoveryGuidance(
  code: string,
  vars: Record<string, string> = {},
  fallbackKey?: string,
): void {
  const key = `workspace.recovery_${code}`
  if (hasMessage(key)) {
    process.stderr.write(`${t(key, vars)}\n`)
  } else if (fallbackKey) {
    process.stderr.write(`${t(fallbackKey, vars)}\n`)
  }
}

export function safeFailureCode(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback
  const match = error.message.match(/^([A-Za-z][A-Za-z0-9_.-]{0,127})/)
  return match?.[1]?.toLowerCase() ?? fallback
}

function explicitLocaleFromArgv(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!
    if (value.startsWith("--locale=")) return value.slice("--locale=".length)
    if (value === "--locale") return argv[index + 1]
  }
  return undefined
}

function initialLocale(requested: string | undefined, json: boolean): SupportedLocale {
  const locales = getAvailableLocales()
  if (requested !== undefined) {
    return locales.includes(requested) ? (requested as SupportedLocale) : "en"
  }
  return json ? "en" : detectSystemLocale()
}

function requireBusinessName(directory: string): string {
  const name = path.basename(directory)
  if (name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new TypeError(`workspace_invalid_business_name:${name}`)
  }
  return name
}

/**
 * Inspect the init target. A missing path is allowed (parent must be a real
 * directory); an existing directory must be empty; a file or symlink target
 * fails closed before any write.
 */
async function checkWorkspaceTarget(directory: string): Promise<WorkspaceTargetState> {
  let stat
  try {
    stat = await lstat(directory)
  } catch (error) {
    if (fileErrorCode(error) !== "ENOENT") throw error
    const parent = await lstat(path.dirname(directory))
    if (!parent.isDirectory() || parent.isSymbolicLink()) {
      throw new TypeError("workspace_init_parent_must_be_a_real_directory")
    }
    return { exists: false, empty: false }
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new TypeError("workspace_init_target_must_be_a_real_directory")
  }
  const entries = await readdir(directory)
  return { exists: true, empty: entries.length === 0 }
}

interface OwnedWorkspacePath {
  filePath: string
  device: number
  inode: number
  directory: boolean
}

interface WorkspaceTargetClaim {
  directory: string
  device: number
  inode: number
  markerPath: string
  markerContent: string
  owned: OwnedWorkspacePath[]
}

async function recordOwnedWorkspacePath(
  filePath: string,
  directory: boolean,
): Promise<OwnedWorkspacePath> {
  const stat = await lstat(filePath)
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile())
  ) {
    throw new TypeError("workspace_publish_ownership_changed")
  }
  return {
    filePath,
    device: stat.dev,
    inode: stat.ino,
    directory,
  }
}

async function sameOwnedWorkspacePath(entry: OwnedWorkspacePath): Promise<boolean> {
  try {
    const stat = await lstat(entry.filePath)
    return !stat.isSymbolicLink() &&
      stat.dev === entry.device &&
      stat.ino === entry.inode &&
      (entry.directory ? stat.isDirectory() : stat.isFile())
  } catch {
    return false
  }
}

/**
 * Remove only paths this process provably created (marker verified, then the
 * tracked entries by device/inode). Unknown or concurrently changed content
 * is never removed.
 */
async function cleanupWorkspaceTarget(
  claim: WorkspaceTargetClaim,
  createdRoot: boolean,
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
      marker.filePath !== claim.markerPath ||
      !(await sameOwnedWorkspacePath(marker)) ||
      (await readFile(claim.markerPath, "utf8")) !== claim.markerContent
    ) {
      return
    }
  } catch {
    return
  }

  for (const entry of [...claim.owned].reverse()) {
    if (!(await sameOwnedWorkspacePath(entry))) continue
    try {
      if (entry.directory) await rmdir(entry.filePath)
      else await unlink(entry.filePath)
    } catch {
      // Unknown or concurrently changed content is never removed.
    }
  }
  if (!createdRoot) return
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

function workspaceDirectories(
  directory: string,
  files: readonly WorkspaceFile[],
): string[] {
  const directories = new Set<string>()
  for (const file of files) {
    const segments = file.portablePath.slice(2).split("/").slice(0, -1)
    let current = directory
    for (const segment of segments) {
      current = path.join(current, segment)
      directories.add(current)
    }
  }
  return [...directories]
}

async function writeWorkspaceFiles(
  directory: string,
  files: readonly WorkspaceFile[],
  owned: OwnedWorkspacePath[],
): Promise<void> {
  for (const item of workspaceDirectories(directory, files)) {
    await mkdir(item, { mode: 0o700 })
    owned.push(await recordOwnedWorkspacePath(item, true))
  }
  for (const file of files) {
    const filePath = path.join(directory, file.portablePath.slice(2))
    await writeFile(filePath, file.content, {
      flag: "wx",
      mode: 0o600,
    })
    owned.push(await recordOwnedWorkspacePath(filePath, false))
  }
}

async function computePositionDigests(
  directory: string,
  template: WorkspaceTemplate,
): Promise<Record<string, WorkspacePositionDigest>> {
  const digests: Record<string, WorkspacePositionDigest> = {}
  for (const role of template.roles) {
    const positionDirectory = path.join(
      directory,
      "positions",
      ...workspaceRoleDirectorySegments(template, role.id),
    )
    digests[role.id] = {
      name: role.id,
      version: WORKSPACE_POSITION_PACKAGE_VERSION,
      digest: await computeEmployeePackageDirectoryDigest(positionDirectory),
    }
  }
  return digests
}

/**
 * Verify a staged or published workspace: every position package passes the
 * employee-package inspection and the organization file carries the expected
 * shape. Inspections fail closed on any contract violation.
 */
async function verifyWorkspace(
  directory: string,
  template: WorkspaceTemplate,
  business: string,
): Promise<void> {
  for (const role of template.roles) {
    const inspection = await inspectEmployeePackage(
      path.join(
        directory,
        "positions",
        ...workspaceRoleDirectorySegments(template, role.id),
      ),
    )
    if (inspection.manifest.name !== role.id) {
      throw new TypeError("workspace_position_package_name_mismatch")
    }
  }
  const organization = JSON.parse(
    await readFile(path.join(directory, "organization.v1alpha1.json"), "utf8"),
  ) as {
    schemaVersion?: string
    business?: string
    owner?: string
    roles?: unknown[]
  }
  if (
    organization.schemaVersion !== "workspace-org.v1" ||
    organization.business !== business ||
    organization.owner !== template.owner ||
    !Array.isArray(organization.roles) ||
    organization.roles.length !== template.roles.length
  ) {
    throw new TypeError("workspace_organization_file_invalid")
  }
  // Budget contract is fail-closed (#157 REQ-006): a position without a fully
  // allocated budget declaration never passes verification.
  validateOrganizationBudgets(
    (organization.roles as Array<{ id?: unknown; budget?: unknown }>).map(
      (role) => ({
        id: typeof role.id === "string" ? role.id : "",
        budget: role.budget,
      }),
    ),
  )
}

async function workspaceInit(options: WorkspaceInitOptions): Promise<void> {
  const locales = getAvailableLocales()
  const json = options.json === true

  if (options.help) {
    process.stdout.write(`${t("workspace.help_init", { locales: supported(locales) })}\n`)
    return
  }

  const directory = options.directory?.trim() || ""
  if (!directory) {
    failCode("workspace.error_aborted", "workspace_init_directory_required", json)
    writeRecoveryGuidance("workspace_init_directory_required")
    return
  }
  if (options.argsCount !== undefined && options.argsCount > 1) {
    failCode(
      "workspace.error_incompatible_options",
      "workspace_init_accepts_one_directory",
      json,
    )
    return
  }

  let template: WorkspaceTemplate
  if (options.template === undefined || options.template.trim() === "") {
    failCode("workspace.error_missing_template", "workspace_init_template_missing", json)
    writeRecoveryGuidance("workspace_init_template_missing")
    return
  }
  try {
    template = resolveWorkspaceTemplate(options.template)
  } catch (error) {
    failCode(
      "workspace.error_invalid_template",
      safeFailureCode(error, "workspace_unknown_template"),
      json,
    )
    return
  }

  const resolvedDirectory = path.resolve(directory)
  let target: WorkspaceTargetState
  try {
    target = await checkWorkspaceTarget(resolvedDirectory)
  } catch (error) {
    failCode(
      "workspace.error_aborted",
      safeFailureCode(error, "workspace_init_target_invalid"),
      json,
    )
    return
  }
  if (target.exists && !target.empty) {
    failCode(
      "workspace.error_target_already_exists",
      "workspace_init_target_already_exists",
      json,
    )
    writeRecoveryGuidance("workspace_init_target_already_exists", {
      directory: resolvedDirectory,
      template: template.id,
    })
    return
  }

  let business: string
  try {
    business = requireBusinessName(resolvedDirectory)
  } catch (error) {
    failCode(
      "workspace.error_aborted",
      safeFailureCode(error, "workspace_invalid_business_name"),
      json,
    )
    return
  }

  const createdAt = new Date().toISOString()
  const skeletonFiles = renderSkeletonFiles(template, business, createdAt)

  // Stage the entire skeleton in a sibling temp directory so the target only
  // receives fully verified content.
  const temporaryRoot = await mkdtemp(
    path.join(path.dirname(resolvedDirectory), `.digital-employee-workspace-${business}-`),
  )
  const stagedDirectory = path.join(temporaryRoot, business)
  try {
    await mkdir(stagedDirectory, { mode: 0o700 })
    await writeWorkspaceFiles(stagedDirectory, skeletonFiles, [])
    const digests = await computePositionDigests(stagedDirectory, template)
    const organizationFile = renderOrganizationFile(
      template,
      business,
      resolvedDirectory,
      digests,
      new Date().toISOString(),
    )
    await writeWorkspaceFiles(stagedDirectory, [organizationFile], [])
    await verifyWorkspace(stagedDirectory, template, business)

    // Publish into the target with ownership tracking; any failure rolls back
    // only what this process created.
    let claim: WorkspaceTargetClaim | undefined
    let createdRoot = false
    try {
      if (!target.exists) {
        await mkdir(resolvedDirectory, { mode: 0o700 })
        createdRoot = true
      }
      const root = await lstat(resolvedDirectory)
      const ownershipToken = randomBytes(16).toString("hex")
      const markerPath = path.join(
        resolvedDirectory,
        `.digital-employee-workspace-claim-${ownershipToken}`,
      )
      const markerContent = `digital-employee-workspace-claim.v1\n${ownershipToken}\n`
      await writeFile(markerPath, markerContent, {
        flag: "wx",
        mode: 0o600,
      })
      claim = {
        directory: resolvedDirectory,
        device: root.dev,
        inode: root.ino,
        markerPath,
        markerContent,
        owned: [await recordOwnedWorkspacePath(markerPath, false)],
      }
      const allFiles = [...skeletonFiles, organizationFile]
      await writeWorkspaceFiles(resolvedDirectory, allFiles, claim.owned)
      await verifyWorkspace(resolvedDirectory, template, business)
      await unlink(markerPath)
    } catch (error) {
      if (claim) await cleanupWorkspaceTarget(claim, createdRoot)
      else if (createdRoot) {
        try {
          await rmdir(resolvedDirectory)
        } catch {
          // A non-empty claim is preserved because ownership was not proven.
        }
      }
      failCode(
        "workspace.error_write_failed",
        safeFailureCode(error, "workspace_init_write_failed"),
        json,
      )
      writeRecoveryGuidance("workspace_init_write_failed", {
        directory: resolvedDirectory,
        template: template.id,
      })
      return
    }

    if (json) {
      process.stdout.write(
        `${JSON.stringify({
          status: "created",
          directory: resolvedDirectory,
          business,
          template: template.id,
          positions: template.roles.map((role) => role.id),
          organization: "./organization.v1alpha1.json",
          workspace: "./workspace.json",
          context: "./context",
        }, null, 2)}\n`,
      )
      return
    }
    process.stdout.write(
      `${t("workspace.init_done", {
        directory: resolvedDirectory,
        business,
        template: template.id,
        count: String(template.roles.length),
      })}\n`,
    )
    for (const role of template.roles) {
      process.stdout.write(`${t("workspace.init_file", { path: `positions/${role.id}` })}\n`)
    }
    process.stdout.write(`${t("workspace.init_file", { path: "context/" })}\n`)
    process.stdout.write(`${t("workspace.init_file", { path: "organization.v1alpha1.json" })}\n`)
    process.stdout.write(`${t("workspace.init_file", { path: "workspace.json" })}\n`)
    process.stdout.write(`${t("workspace.init_next_steps")}\n`)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

function renderWorkspaceHelp(): void {
  const locales = getAvailableLocales()
  process.stdout.write(`${t("workspace.help", { locales: supported(locales) })}\n`)
}

export async function workspace(options: WorkspaceOptions = { args: [] }): Promise<void> {
  const json = options.json === true
  const locales = getAvailableLocales()

  // Load the catalog first (invalid explicit locales fall back to en), then
  // fail closed on unsupported explicit locale values, mirroring deploy.
  setLocale(initialLocale(options.locale, json))
  if (
    options.providedOptions?.has("locale") &&
    (options.locale === undefined || !locales.includes(options.locale))
  ) {
    failInput("locale", locales, json)
    return
  }

  const subcommand = options.subcommand
  if (!subcommand || subcommand === "help") {
    renderWorkspaceHelp()
    return
  }
  if (subcommand !== "init") {
    failCode(
      "workspace.error_unknown_subcommand",
      `workspace_unknown_subcommand:${subcommand}`,
      json,
    )
    return
  }
  return workspaceInit({
    directory: options.args[0],
    template: options.template,
    json,
    help: options.help,
    argsCount: options.args.length,
    providedOptions: options.providedOptions,
  })
}

/**
 * Render a localized, side-effect-free parse failure for the workspace
 * command domain (mirrors the deploy command's renderer).
 */
export function renderWorkspaceParseFailure(
  argv: readonly string[],
  error: unknown,
): void {
  const locales = getAvailableLocales()
  const requestedLocale = explicitLocaleFromArgv(argv)
  setLocale(
    requestedLocale !== undefined
      ? locales.includes(requestedLocale)
        ? (requestedLocale as SupportedLocale)
        : "en"
      : detectSystemLocale(),
  )
  const message = error instanceof Error ? error.message : "invalid_arguments"
  const field = message.match(/'(--[A-Za-z0-9-]+)'/)?.[1] ?? "arguments"
  failInput(field, WORKSPACE_OPTIONS.map((entry) => `--${entry}`), false)
}
