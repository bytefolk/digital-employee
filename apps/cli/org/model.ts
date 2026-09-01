/**
 * Organization model state, directory-tree scan, and apply pipeline
 * (#157 REQ-003/REQ-004/REQ-005).
 *
 * The workspace directory is the enterprise; every position is a directory
 * holding its employee package plus a `budget.json` declaration, and the
 * parent-child directory relation is the reporting relationship:
 *
 *   add a position directory    -> hire   (budget gate: fail-closed)
 *   move a position directory   -> change the reporting line
 *   delete a position directory -> dismiss (recorded in the audit log)
 *
 * The authoritative organization model lives at
 * `<workspace>/.digital-employee/org.json` (0600). When it is absent,
 * `org apply` bootstraps it from `organization.v1alpha1.json`. All
 * validation happens before any write: an invalid change leaves the
 * organization model byte-for-byte unchanged. Every applied change is
 * appended to `.digital-employee/org-audit.jsonl` and triggers permission
 * recomputation into `.digital-employee/permissions.json` (#159 seam).
 */

import { randomBytes } from "node:crypto"
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import path from "node:path"

import {
  WORKSPACE_ORG_SCHEMA_ID,
  organizationNameSchema,
  positionBudgetDefs,
  positionModeSchema,
  validateOrganizationDocument,
  validatePositionBudget,
} from "./budget.js"
import type {
  PositionBudget,
  PositionMode,
  ValidatedOrganizationDocument,
  ValidatedOrganizationRole,
} from "./budget.js"
import { deriveOrganizationPermissions } from "./permissions.js"
import type { OrganizationPermissions } from "./permissions.js"
import {
  computeEmployeePackageDirectoryDigest,
  inspectEmployeePackage,
} from "../employee-package.js"
import type { EmployeePackageManifest } from "../../../packages/core/src/employee-package.js"

export const ORG_STATE_DIR = ".digital-employee"
export const ORG_MODEL_FILE = "org.json"
export const ORG_AUDIT_FILE = "org-audit.jsonl"
export const ORG_PERMISSIONS_FILE = "permissions.json"
export const ORGANIZATION_FILE = "organization.v1alpha1.json"
export const POSITIONS_DIR = "positions"
export const POSITION_MANIFEST_FILE = "employee.json"
export const POSITION_BUDGET_FILE = "budget.json"

export const ORG_AUDIT_SCHEMA_VERSION = "org-audit.v1"
export const ORG_TREE_SCHEMA_VERSION = "org-tree.v1"

const POSITION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const POSITION_ID_MAX_LENGTH = 64

export interface OrgPaths {
  workspace: string
  stateDir: string
  modelPath: string
  auditPath: string
  permissionsPath: string
  organizationPath: string
  positionsDir: string
}

export function orgPaths(workspace: string): OrgPaths {
  const resolved = path.resolve(workspace)
  const stateDir = path.join(resolved, ORG_STATE_DIR)
  return {
    workspace: resolved,
    stateDir,
    modelPath: path.join(stateDir, ORG_MODEL_FILE),
    auditPath: path.join(stateDir, ORG_AUDIT_FILE),
    permissionsPath: path.join(stateDir, ORG_PERMISSIONS_FILE),
    organizationPath: path.join(resolved, ORGANIZATION_FILE),
    positionsDir: path.join(resolved, POSITIONS_DIR),
  }
}

function fileErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined
}

async function assertRealDirectory(
  target: string,
  code: string,
): Promise<void> {
  let stat
  try {
    stat = await lstat(target)
  } catch (error) {
    if (fileErrorCode(error) === "ENOENT") throw new TypeError(code)
    throw error
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new TypeError(code)
  }
}

async function hasPositionManifest(directory: string): Promise<boolean> {
  try {
    const stat = await lstat(path.join(directory, POSITION_MANIFEST_FILE))
    return stat.isFile() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

/** One position discovered in the directory tree. */
export interface ScannedPosition {
  id: string
  /** Absolute path of the position directory. */
  directory: string
  /** Nearest ancestor position id, or null for top-level positions. */
  reportTo: string | null
  /** Directory segments, ancestors first (includes the position itself). */
  segments: string[]
  /** 1-based depth in the positions tree. */
  depth: number
}

function assertPositionId(id: string): void {
  if (
    id.length === 0 ||
    id.length > POSITION_ID_MAX_LENGTH ||
    !POSITION_ID_PATTERN.test(id)
  ) {
    throw new TypeError("workspace_org_tree_invalid_position_id")
  }
}

/**
 * Scan the positions/ directory tree. A position is a directory containing
 * `employee.json`; its nearest ancestor position directory is its superior.
 * Direct children of positions/ must all be position directories (fail
 * closed on stray content). Subdirectories of a position without their own
 * manifest are package content and are not scanned further.
 */
export async function scanPositionsTree(
  workspace: string,
): Promise<ScannedPosition[]> {
  const paths = orgPaths(workspace)
  await assertRealDirectory(paths.positionsDir, "workspace_org_positions_missing")
  const positions: ScannedPosition[] = []
  const seen = new Set<string>()

  const register = (position: ScannedPosition): void => {
    assertPositionId(position.id)
    if (seen.has(position.id)) {
      throw new TypeError("workspace_org_tree_duplicate_position")
    }
    seen.add(position.id)
    positions.push(position)
  }

  const scanChildren = async (
    parent: ScannedPosition,
  ): Promise<void> => {
    const entries = (await readdir(parent.directory, { withFileTypes: true }))
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, "en"))
    for (const entry of entries) {
      const full = path.join(parent.directory, entry.name)
      const stat = await lstat(full)
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue
      if (!(await hasPositionManifest(full))) continue
      const child: ScannedPosition = {
        id: entry.name,
        directory: full,
        reportTo: parent.id,
        segments: [...parent.segments, entry.name],
        depth: parent.depth + 1,
      }
      register(child)
      await scanChildren(child)
    }
  }

  const entries = (await readdir(paths.positionsDir, { withFileTypes: true }))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, "en"))
  for (const entry of entries) {
    const full = path.join(paths.positionsDir, entry.name)
    const stat = await lstat(full)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new TypeError("workspace_org_tree_position_invalid")
    }
    if (!(await hasPositionManifest(full))) {
      throw new TypeError("workspace_org_tree_position_invalid")
    }
    const position: ScannedPosition = {
      id: entry.name,
      directory: full,
      reportTo: null,
      segments: [entry.name],
      depth: 1,
    }
    register(position)
    await scanChildren(position)
  }
  return positions
}

/** A scanned position plus its validated package and budget declarations. */
export interface PositionDeclaration {
  position: ScannedPosition
  manifest: EmployeePackageManifest
  budget: PositionBudget
  digest: string
}

/**
 * Read and validate one position's declarations (employee package + budget).
 * A position without a fully allocated budget fails closed before any
 * change takes effect (#157 REQ-005, AC-005).
 */
export async function readPositionDeclaration(
  position: ScannedPosition,
): Promise<PositionDeclaration> {
  const budgetPath = path.join(position.directory, POSITION_BUDGET_FILE)
  let budgetStat
  try {
    budgetStat = await lstat(budgetPath)
  } catch (error) {
    if (fileErrorCode(error) === "ENOENT") {
      throw new TypeError(`workspace_org_budget_missing:${position.id}`)
    }
    throw error
  }
  if (!budgetStat.isFile() || budgetStat.isSymbolicLink()) {
    throw new TypeError(`workspace_org_budget_invalid:${position.id}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(budgetPath, "utf8")) as unknown
  } catch {
    throw new TypeError(`workspace_org_budget_invalid:${position.id}`)
  }
  const budget = validatePositionBudget(position.id, parsed)
  const inspection = await inspectEmployeePackage(position.directory)
  const digest = await computeEmployeePackageDirectoryDigest(position.directory)
  return {
    position,
    manifest: inspection.manifest,
    budget,
    digest,
  }
}

export interface LoadedOrgModel {
  model: ValidatedOrganizationDocument
  bootstrapped: boolean
}

/**
 * Load the current organization model: `.digital-employee/org.json` when
 * present, otherwise bootstrapped from `organization.v1alpha1.json`. Any
 * malformed state fails closed; nothing is rewritten silently.
 */
export async function loadOrgModel(workspace: string): Promise<LoadedOrgModel> {
  const paths = orgPaths(workspace)
  await assertRealDirectory(
    paths.workspace,
    "workspace_org_workspace_not_initialized",
  )
  try {
    const raw = await readFile(paths.modelPath, "utf8")
    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch {
      throw new TypeError("workspace_org_model_invalid")
    }
    try {
      return { model: validateOrganizationDocument(parsed), bootstrapped: false }
    } catch {
      throw new TypeError("workspace_org_model_invalid")
    }
  } catch (error) {
    if (fileErrorCode(error) !== "ENOENT") {
      if (error instanceof TypeError) throw error
      throw error
    }
  }
  let raw: string
  try {
    raw = await readFile(paths.organizationPath, "utf8")
  } catch (error) {
    if (fileErrorCode(error) === "ENOENT") {
      throw new TypeError("workspace_org_workspace_not_initialized")
    }
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    throw new TypeError("workspace_org_file_invalid")
  }
  try {
    return { model: validateOrganizationDocument(parsed), bootstrapped: true }
  } catch {
    throw new TypeError("workspace_org_file_invalid")
  }
}

/** Diff between the current model and the scanned, declared tree. */
export interface OrgChangeSet {
  hired: ValidatedOrganizationRole[]
  moved: Array<{ id: string; from: string | null; to: string | null }>
  dismissed: ValidatedOrganizationRole[]
  budgetUpdated: string[]
}

function budgetsEqual(a: PositionBudget, b: PositionBudget): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Compute hire/move/dismiss/budget changes. Pure: reads only the current
 * model and the validated declarations.
 */
export function diffOrganization(
  current: ValidatedOrganizationDocument,
  declarations: readonly PositionDeclaration[],
): OrgChangeSet {
  const currentById = new Map(current.roles.map((role) => [role.id, role]))
  const changes: OrgChangeSet = {
    hired: [],
    moved: [],
    dismissed: [],
    budgetUpdated: [],
  }
  const scannedIds = new Set<string>()
  for (const declaration of declarations) {
    const { position, budget } = declaration
    scannedIds.add(position.id)
    const existing = currentById.get(position.id)
    if (!existing) {
      changes.hired.push(buildRoleRecord(declaration))
      continue
    }
    if (existing.reportTo !== position.reportTo) {
      changes.moved.push({
        id: position.id,
        from: existing.reportTo,
        to: position.reportTo,
      })
    }
    if (!budgetsEqual(existing.budget, budget)) {
      changes.budgetUpdated.push(position.id)
    }
  }
  for (const role of current.roles) {
    if (!scannedIds.has(role.id)) {
      changes.dismissed.push(role)
    }
  }
  return changes
}

function buildRoleRecord(
  declaration: PositionDeclaration,
): ValidatedOrganizationRole {
  const { position, manifest, budget, digest } = declaration
  return {
    id: position.id,
    name: manifest.name,
    description: manifest.description,
    reportTo: position.reportTo,
    package: {
      name: manifest.name,
      version: manifest.version,
      digest,
      localReference: position.directory,
    },
    mode: manifest.policy.mode,
    // Fail-closed defaults for a fresh hire: the position sees its own
    // package slice only and declares no tools until granted (#159).
    memoryScope: "./",
    toolAllow: [],
    toolDeny: [],
    metadata: {},
    budget: {
      perTask: { ...budget.perTask },
      perDay: { ...budget.perDay },
    },
  }
}

/** The applied organization file (workspace-org.v1 with $schema ref). */
export interface OrgModelFile extends ValidatedOrganizationDocument {
  $schema: string
}

/**
 * Build the post-apply organization model in scanned tree order. Existing
 * positions keep their declared identity (name, tool lists, metadata) and
 * receive fresh reporting lines, package bindings, and budgets from the
 * tree; hired positions receive fail-closed defaults.
 */
export function buildAppliedOrganization(
  current: ValidatedOrganizationDocument,
  declarations: readonly PositionDeclaration[],
  updatedAt: string,
): OrgModelFile {
  const currentById = new Map(current.roles.map((role) => [role.id, role]))
  const roles: ValidatedOrganizationRole[] = declarations.map(
    (declaration) => {
      const { position, manifest, budget, digest } = declaration
      const existing = currentById.get(position.id)
      const freshPackage = {
        name: manifest.name,
        version: manifest.version,
        digest,
        localReference: position.directory,
      }
      if (!existing) {
        return buildRoleRecord(declaration)
      }
      return {
        ...existing,
        reportTo: position.reportTo,
        package: freshPackage,
        budget: {
          perTask: { ...budget.perTask },
          perDay: { ...budget.perDay },
        },
      }
    },
  )
  return {
    $schema: WORKSPACE_ORG_SCHEMA_ID,
    schemaVersion: current.schemaVersion,
    business: current.business,
    description: current.description,
    owner: current.owner,
    roles,
    updatedAt,
  }
}

/**
 * Write a private (0600) file atomically: temp file in the same directory,
 * then rename over the destination. The temp file is removed on failure.
 */
export async function writePrivateFileAtomic(
  filePath: string,
  content: string,
): Promise<void> {
  const tempPath = `${filePath}.tmp-${randomBytes(8).toString("hex")}`
  try {
    await writeFile(tempPath, content, { flag: "wx", mode: 0o600 })
    await rename(tempPath, filePath)
  } catch (error) {
    try {
      await rm(tempPath, { force: true })
    } catch {
      // Cleanup is best effort after the primary failure.
    }
    throw error
  }
}

export async function ensureOrgStateDir(workspace: string): Promise<void> {
  const paths = orgPaths(workspace)
  try {
    const stat = await lstat(paths.stateDir)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new TypeError("workspace_org_state_dir_invalid")
    }
    return
  } catch (error) {
    if (fileErrorCode(error) !== "ENOENT") throw error
  }
  await mkdir(paths.stateDir, { mode: 0o700 })
}

/** Append-only audit entry for one applied change set. */
export interface OrgAuditEntry {
  schemaVersion: typeof ORG_AUDIT_SCHEMA_VERSION
  at: string
  actor: string
  workspace: string
  bootstrapped: boolean
  changes: OrgChangeSet
  positionCount: number
}

export async function appendOrgAudit(
  auditPath: string,
  entry: OrgAuditEntry,
): Promise<void> {
  await appendFile(auditPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
}

export interface OrgApplyResult {
  model: OrgModelFile
  changes: OrgChangeSet
  bootstrapped: boolean
  permissions: OrganizationPermissions
  paths: OrgPaths
}

/**
 * Directory-driven `org apply`: load the current model, scan the tree,
 * validate every declaration (fail-closed budget gate), diff, then write the
 * model, append the audit record, and recompute permissions. All validation
 * happens before the first write, so an invalid change leaves the
 * organization model unchanged (#157 AC-005).
 */
export async function applyOrganization(
  workspace: string,
): Promise<OrgApplyResult> {
  const paths = orgPaths(workspace)
  const { model: current, bootstrapped } = await loadOrgModel(paths.workspace)
  const scanned = await scanPositionsTree(paths.workspace)
  const declarations: PositionDeclaration[] = []
  for (const position of scanned) {
    declarations.push(await readPositionDeclaration(position))
  }
  const changes = diffOrganization(current, declarations)
  const model = buildAppliedOrganization(
    current,
    declarations,
    new Date().toISOString(),
  )
  // Defense in depth: the applied document must pass the full contract.
  validateOrganizationDocument(JSON.parse(JSON.stringify(model)) as unknown)

  await ensureOrgStateDir(paths.workspace)
  try {
    await writePrivateFileAtomic(
      paths.modelPath,
      `${JSON.stringify(model, null, 2)}\n`,
    )
    await appendOrgAudit(paths.auditPath, {
      schemaVersion: ORG_AUDIT_SCHEMA_VERSION,
      at: model.updatedAt,
      actor: "digital-employee org apply",
      workspace: paths.workspace,
      bootstrapped,
      changes,
      positionCount: model.roles.length,
    })
    const permissions = deriveOrganizationPermissions(model)
    await writePrivateFileAtomic(
      paths.permissionsPath,
      `${JSON.stringify(permissions, null, 2)}\n`,
    )
    return { model, changes, bootstrapped, permissions, paths }
  } catch (error) {
    if (error instanceof TypeError) throw error
    throw new TypeError("workspace_org_write_failed")
  }
}

/**
 * Reporting-tree node for org-tree.v1 (frozen minimal shape): position id,
 * reporting line, budget declaration subset, children. The node deliberately
 * carries only what the org-tree consumer needs; the full position
 * declaration stays in the organization model.
 *
 * v0 increment (pre-merge additive): `name` (human-readable display name for
 * org-chart rendering) and `mode` (read-only/approval lock state source).
 * Both are optional in the published schema; the builder always emits them.
 */
export interface OrgTreeNode {
  id: string
  name: string
  reportTo: string | null
  mode: PositionMode
  budget: PositionBudget
  children: OrgTreeNode[]
}

/** Deterministic org-tree.v1 rendering of an organization model. */
export interface OrgTree {
  schemaVersion: typeof ORG_TREE_SCHEMA_VERSION
  business: string
  owner: string
  /** Applied-state stamp from the organization model; aligns org.updated. */
  updatedAt: string
  positionCount: number
  depth: number
  tree: OrgTreeNode[]
}

export function buildOrgTree(
  model: ValidatedOrganizationDocument,
): OrgTree {
  const childrenByParent = new Map<string | null, ValidatedOrganizationRole[]>()
  for (const role of model.roles) {
    const list = childrenByParent.get(role.reportTo) ?? []
    list.push(role)
    childrenByParent.set(role.reportTo, list)
  }
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => a.id.localeCompare(b.id, "en"))
  }
  let depth = 0
  const build = (
    role: ValidatedOrganizationRole,
    level: number,
  ): OrgTreeNode => {
    depth = Math.max(depth, level)
    return {
      id: role.id,
      name: role.name,
      reportTo: role.reportTo,
      mode: role.mode,
      budget: role.budget,
      children: (childrenByParent.get(role.id) ?? []).map((child) =>
        build(child, level + 1),
      ),
    }
  }
  const roots = childrenByParent.get(null) ?? []
  const tree = roots.map((root) => build(root, 1))
  return {
    schemaVersion: ORG_TREE_SCHEMA_VERSION,
    business: model.business,
    owner: model.owner,
    updatedAt: model.updatedAt,
    positionCount: model.roles.length,
    depth,
    tree,
  }
}

export const ORG_TREE_SCHEMA_ID =
  "https://raw.githubusercontent.com/fullstack-ai-infra/digital-employee/main/configs/org-tree.schema.json" as const

/**
 * Build the org-tree.v1 JSON Schema (draft 2020-12) for the frozen minimal
 * tree shape. The published file configs/org-tree.schema.json must be
 * byte-identical to `JSON.stringify(buildOrgTreeSchema(), null, 2) + "\n"`;
 * the schema-consistency test enforces this.
 */
export function buildOrgTreeSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: ORG_TREE_SCHEMA_ID,
    title: "org-tree.v1 reporting tree (frozen minimal shape)",
    type: "object",
    additionalProperties: false,
    required: [
      "schemaVersion",
      "business",
      "owner",
      "updatedAt",
      "positionCount",
      "depth",
      "tree",
    ],
    properties: {
      schemaVersion: { const: ORG_TREE_SCHEMA_VERSION },
      business: organizationNameSchema(),
      owner: organizationNameSchema(),
      updatedAt: { type: "string", minLength: 1 },
      positionCount: { type: "integer", minimum: 1 },
      depth: { type: "integer", minimum: 1 },
      tree: {
        type: "array",
        minItems: 1,
        items: { $ref: "#/$defs/orgTreeNode" },
      },
    },
    $defs: {
      orgTreeNode: {
        type: "object",
        additionalProperties: false,
        required: ["id", "reportTo", "budget", "children"],
        properties: {
          id: organizationNameSchema(),
          name: { type: "string", minLength: 1, maxLength: 128 },
          reportTo: {
            anyOf: [{ type: "null" }, organizationNameSchema()],
          },
          mode: positionModeSchema(),
          budget: { $ref: "#/$defs/positionBudget" },
          children: {
            type: "array",
            items: { $ref: "#/$defs/orgTreeNode" },
          },
        },
      },
      ...positionBudgetDefs(),
    },
  }
}
