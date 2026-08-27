/**
 * Permission boundaries derived from the organization model (#159).
 *
 * Every position gets a Context Scope (what it may see) and an Authority
 * Scope (which tools it may call), derived solely from the org model:
 *
 * - Two default tiers: `owner` (the organization owner position) and
 *   `worker` (every other position).
 * - Read tools use explicit allowlists; write-capable tools stay out of the
 *   first release (`writes: "deny"` is the default for every tier).
 * - An owner never inherits subordinate declarations: derivation is purely
 *   per-position (#159 REQ-002).
 * - Out-of-scope requests fail closed with a stable code and point at the
 *   owner position as the correct entry (#159 REQ-003).
 *
 * `org apply` recomputes this artifact after every validated change and
 * stores it at `<workspace>/.digital-employee/permissions.json`.
 */

import type {
  ValidatedOrganizationDocument,
  ValidatedOrganizationRole,
} from "./budget.js"
import type { PositionMode } from "../../../packages/engine/src/org-permissions.js"

export const ORG_PERMISSIONS_SCHEMA_VERSION = "org-permissions.v1" as const

/** Read-only tool allowlist; the only tools derivable in the first release. */
export const READ_TOOL_ALLOWLIST = ["Read", "Grep", "Glob"] as const

export type PermissionTier = "owner" | "worker"

export interface AuthorityScope {
  /** Write-capable tools are default-deny in the first release (#159 AC-003). */
  writes: "deny"
  tools: {
    allow: string[]
    deny: string[]
  }
  /**
   * Owners may delegate to their direct reports; workers may not delegate
   * and only escalate upward along the reporting line (#157 REQ-007/REQ-008).
   */
  delegation: {
    allow: boolean
    targets: string[]
    escalateTo: string | null
  }
}

export interface PositionPermissions {
  position: string
  tier: PermissionTier
  /** Position mode consumed from role.mode; absent defaults to read_only. */
  mode: PositionMode
  /** Portable workspace-relative read scopes, e.g. "./positions/<path>/". */
  contextScope: { read: string[] }
  authorityScope: AuthorityScope
}

export interface OrganizationPermissions {
  schemaVersion: typeof ORG_PERMISSIONS_SCHEMA_VERSION
  business: string
  owner: string
  positions: Record<string, PositionPermissions>
}

/**
 * Portable workspace-relative path of a position's package directory
 * (ancestors first), e.g. ["repo-owner", "issue-researcher"].
 */
export function positionDirectorySegments(
  model: Pick<ValidatedOrganizationDocument, "roles">,
  positionId: string,
): string[] {
  const byId = new Map(model.roles.map((role) => [role.id, role]))
  const segments: string[] = []
  let current: string | null = positionId
  const visited = new Set<string>()
  while (current !== null) {
    if (visited.has(current)) {
      throw new TypeError("workspace_org_document_invalid:reporting_cycle")
    }
    visited.add(current)
    segments.unshift(current)
    const role = byId.get(current)
    current = role ? role.reportTo : null
  }
  return segments
}

function deriveAuthority(
  model: ValidatedOrganizationDocument,
  role: ValidatedOrganizationRole,
  tier: PermissionTier,
): AuthorityScope {
  const declared =
    role.toolAllow.length > 0 ? role.toolAllow : [...READ_TOOL_ALLOWLIST]
  const allow: string[] = []
  for (const tool of declared) {
    if (
      (READ_TOOL_ALLOWLIST as readonly string[]).includes(tool) &&
      !role.toolDeny.includes(tool) &&
      !allow.includes(tool)
    ) {
      allow.push(tool)
    }
  }
  const directReports =
    tier === "owner"
      ? model.roles
          .filter((entry) => entry.reportTo === role.id)
          .map((entry) => entry.id)
          .sort()
      : []
  return {
    writes: "deny",
    tools: { allow, deny: [...role.toolDeny] },
    delegation:
      tier === "owner"
        ? { allow: true, targets: directReports, escalateTo: null }
        : { allow: false, targets: [], escalateTo: role.reportTo },
  }
}

function deriveContextScope(
  model: ValidatedOrganizationDocument,
  role: ValidatedOrganizationRole,
  tier: PermissionTier,
): { read: string[] } {
  if (tier === "owner") {
    // The owner sees the whole workspace, including the organization state.
    return { read: ["./"] }
  }
  const segments = positionDirectorySegments(model, role.id)
  return {
    read: [`./positions/${segments.join("/")}/`, "./context/"],
  }
}

/**
 * Derive Context Scope and Authority Scope for every position from the org
 * model. Pure and deterministic; the owner does not inherit subordinate
 * declarations (derivation is per-position only, #159 REQ-002).
 */
export function deriveOrganizationPermissions(
  model: ValidatedOrganizationDocument,
): OrganizationPermissions {
  const positions: Record<string, PositionPermissions> = {}
  for (const role of model.roles) {
    const tier: PermissionTier = role.id === model.owner ? "owner" : "worker"
    positions[role.id] = {
      position: role.id,
      tier,
      mode: role.mode,
      contextScope: deriveContextScope(model, role, tier),
      authorityScope: deriveAuthority(model, role, tier),
    }
  }
  return {
    schemaVersion: ORG_PERMISSIONS_SCHEMA_VERSION,
    business: model.business,
    owner: model.owner,
    positions,
  }
}

export type PermissionDecision =
  | { status: "allowed" }
  | {
      status: "denied"
      code: "workspace_org_authority_denied" | "workspace_org_context_denied"
      redirectTo: string
    }

function permissionsFor(
  permissions: OrganizationPermissions,
  positionId: string,
): PositionPermissions {
  const entry = permissions.positions[positionId]
  if (!entry) {
    throw new TypeError(`workspace_org_position_unknown:${positionId}`)
  }
  return entry
}

/**
 * Evaluate a tool-call request against a position's Authority Scope.
 * Writes are default-deny; only allowlisted read tools pass (#159 AC-003).
 */
export function evaluateToolAuthority(
  permissions: OrganizationPermissions,
  positionId: string,
  tool: string,
): PermissionDecision {
  const entry = permissionsFor(permissions, positionId)
  if (entry.authorityScope.tools.allow.includes(tool)) {
    return { status: "allowed" }
  }
  return {
    status: "denied",
    code: "workspace_org_authority_denied",
    redirectTo: permissions.owner,
  }
}

/**
 * Normalize a requested context path to a portable workspace-relative form.
 * Absolute paths, parent traversal, and backslash separators fail closed.
 */
export function normalizeContextPath(requested: string): string {
  const trimmed = requested.trim()
  if (trimmed.length === 0) {
    throw new TypeError("workspace_org_context_path_invalid")
  }
  if (trimmed.includes("\\")) {
    throw new TypeError("workspace_org_context_path_invalid")
  }
  if (/^[A-Za-z]:/.test(trimmed)) {
    throw new TypeError("workspace_org_context_path_invalid")
  }
  const withoutDot = trimmed.startsWith("./") ? trimmed.slice(2) : trimmed
  const absolute = withoutDot.startsWith("/")
  const segments: string[] = []
  for (const segment of withoutDot.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      throw new TypeError("workspace_org_context_path_invalid")
    }
    segments.push(segment)
  }
  if (absolute && segments.length > 0) {
    throw new TypeError("workspace_org_context_path_invalid")
  }
  return `./${segments.join("/")}`
}

/**
 * Evaluate a context read request against a position's Context Scope.
 * Workers see only their own position subtree and the shared context
 * directory; the owner sees the whole workspace (#159 user outcome).
 */
export function evaluateContextAccess(
  permissions: OrganizationPermissions,
  positionId: string,
  requestedPath: string,
): PermissionDecision {
  const entry = permissionsFor(permissions, positionId)
  const normalized = normalizeContextPath(requestedPath)
  const denied = {
    status: "denied" as const,
    code: "workspace_org_context_denied" as const,
    redirectTo: permissions.owner,
  }
  for (const scope of entry.contextScope.read) {
    if (scope === "./") return { status: "allowed" }
    const prefix = scope.endsWith("/") ? scope : `${scope}/`
    if (normalized === scope.replace(/\/$/, "") || normalized.startsWith(prefix)) {
      return { status: "allowed" }
    }
  }
  return denied
}
