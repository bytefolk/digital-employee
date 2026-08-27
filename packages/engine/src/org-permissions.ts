/**
 * Organization permission enforcement (#159 R3, #165 S2 harness).
 *
 * Single source of truth for the permission-enforcement semantics. The engine
 * execution chain is the enforcement point (#159 REQ-004): it consumes the
 * single enforcement artifact `permissions.json` (`org-permissions.v1`,
 * recomputed by `org apply`) and evaluates Context Scope and Authority Scope.
 * The workbench/orchestration layer is NOT an enforcement point; the `org
 * scope` CLI stays diagnostic. Derivation (org model -> artifact) lives in
 * apps/cli and re-exports these evaluation symbols.
 *
 * Enforcement semantics (#159 REQ-005):
 * - out-of-scope context reads deny with `workspace_org_context_denied`;
 * - out-of-authority tool calls deny with `workspace_org_authority_denied`;
 * - unknown positions fail with `workspace_org_position_unknown` before spawn;
 * - every denial carries `redirectTo` = owner position;
 * - a denial attempt record carries (positionId, requested, code, redirectTo)
 *   and ZERO content from the denied resource.
 */

export const ORG_PERMISSIONS_SCHEMA_VERSION = "org-permissions.v1" as const

/** Read-only tool allowlist; the only tools derivable in the first release. */
export const READ_TOOL_ALLOWLIST = ["Read", "Grep", "Glob"] as const

export type PermissionTier = "owner" | "worker"

/** Position mode consumed from workspace-org.v1 role.mode (#159 REQ-006). */
export type PositionMode = "read_only" | "approval_required"

export interface AuthorityScope {
  /** Write-capable tools are default-deny in the first release (#159 AC-003). */
  writes: "deny"
  tools: {
    allow: string[]
    deny: string[]
  }
  delegation: {
    allow: boolean
    targets: string[]
    escalateTo: string | null
  }
}

export interface PositionPermissions {
  position: string
  tier: PermissionTier
  /** Optional per-position mode; absent defaults to read_only (#159 REQ-006). */
  mode?: PositionMode
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

export type PermissionDecision =
  | { status: "allowed" }
  | {
      status: "denied"
      code:
        | "workspace_org_authority_denied"
        | "workspace_org_context_denied"
        | "workspace_org_position_unknown"
      redirectTo: string
    }

export function permissionsFor(
  permissions: OrganizationPermissions,
  positionId: string,
): PositionPermissions {
  const entry = permissions.positions[positionId]
  if (!entry) {
    throw new TypeError(`workspace_org_position_unknown:${positionId}`)
  }
  return entry
}

/** Resolve the effective mode for a position (absent -> read_only). */
export function effectiveMode(entry: PositionPermissions): PositionMode {
  return entry.mode ?? "read_only"
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

/**
 * A denial attempt recorded in turn evidence (#159 REQ-005). Carries the
 * position, the requested path or tool name, the stable code, and the
 * redirect target — and NEVER any content from the denied resource.
 */
export interface PermissionDenialAttempt {
  positionId: string
  /** Requested context path or tool name only; no resource content. */
  requested: string
  code:
    | "workspace_org_authority_denied"
    | "workspace_org_context_denied"
    | "workspace_org_position_unknown"
  redirectTo: string
}

/** Per-turn permission decision summary (#159 REQ-005). */
export interface PermissionDecisionSummary {
  allowCount: number
  denyCount: number
  codesSeen: string[]
  redirectToTargets: string[]
}

export interface PermissionGateResult {
  allowed: boolean
  denials: PermissionDenialAttempt[]
  summary: PermissionDecisionSummary
  /** Set when the position itself is unknown (fails before spawn). */
  unknownPosition?: string
}

/**
 * The engine harness permission gate (#159 REQ-004 layer (a) pre-check).
 * Evaluates Context Scope over requested context paths and Authority Scope
 * over requested tools, before any model consumption. Pure and deterministic.
 * Denials never carry resource content.
 */
export function createPermissionGate(permissions: OrganizationPermissions) {
  const denials: PermissionDenialAttempt[] = []
  let allowCount = 0

  const recordDenial = (attempt: PermissionDenialAttempt): void => {
    denials.push(attempt)
  }

  return {
    /**
     * Fail-closed position existence check. Returns the unknown position id
     * when absent so the caller can fail before spawn (#159 AC-006).
     */
    checkPosition(positionId: string): { ok: boolean; unknown?: string } {
      if (!permissions.positions[positionId]) {
        return { ok: false, unknown: positionId }
      }
      return { ok: true }
    },

    /** Evaluate a context read request; records a denial attempt on deny. */
    evaluateContextRead(positionId: string, requestedPath: string): PermissionDecision {
      let decision: PermissionDecision
      try {
        decision = evaluateContextAccess(permissions, positionId, requestedPath)
      } catch {
        decision = {
          status: "denied",
          code: "workspace_org_context_denied",
          redirectTo: permissions.owner,
        }
      }
      if (decision.status === "allowed") {
        allowCount += 1
      } else {
        recordDenial({
          positionId,
          requested: requestedPath,
          code: decision.code,
          redirectTo: decision.redirectTo,
        })
      }
      return decision
    },

    /** Evaluate a tool call; records a denial attempt on deny. */
    evaluateToolCall(positionId: string, tool: string): PermissionDecision {
      let decision: PermissionDecision
      try {
        decision = evaluateToolAuthority(permissions, positionId, tool)
      } catch {
        decision = {
          status: "denied",
          code: "workspace_org_authority_denied",
          redirectTo: permissions.owner,
        }
      }
      if (decision.status === "allowed") {
        allowCount += 1
      } else {
        recordDenial({
          positionId,
          requested: tool,
          code: decision.code,
          redirectTo: decision.redirectTo,
        })
      }
      return decision
    },

    /** Snapshot of denial attempts (zero resource content). */
    denialAttempts(): readonly PermissionDenialAttempt[] {
      return [...denials]
    },

    /** Per-turn decision summary disjoint from approval settlement fields. */
    summary(): PermissionDecisionSummary {
      const codesSeen = [...new Set(denials.map((d) => d.code))]
      const redirectToTargets = [...new Set(denials.map((d) => d.redirectTo))]
      return {
        allowCount,
        denyCount: denials.length,
        codesSeen,
        redirectToTargets,
      }
    },
  }
}

export type PermissionGate = ReturnType<typeof createPermissionGate>

/**
 * Strict artifact validator for org-permissions.v1 (#159 REQ-009). The engine
 * re-validates the artifact shape on every read; a missing or malformed
 * artifact fails the turn closed before model invocation.
 */
export function validateOrganizationPermissionsArtifact(
  value: unknown,
): OrganizationPermissions {
  const invalid = (detail: string): never => {
    throw new TypeError(`workspace_org_permissions_invalid:${detail}`)
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid("not_an_object")
  }
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== ORG_PERMISSIONS_SCHEMA_VERSION) {
    invalid("schema_version")
  }
  if (typeof record.business !== "string" || record.business.length === 0) {
    invalid("business")
  }
  if (typeof record.owner !== "string" || record.owner.length === 0) {
    invalid("owner")
  }
  const positions = record.positions
  if (
    positions === null ||
    typeof positions !== "object" ||
    Array.isArray(positions)
  ) {
    invalid("positions")
  }
  const validated: Record<string, PositionPermissions> = {}
  for (const [positionId, entry] of Object.entries(
    positions as Record<string, unknown>,
  )) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      invalid(`position:${positionId}`)
    }
    const p = entry as Record<string, unknown>
    if (p.position !== positionId) invalid(`position_mismatch:${positionId}`)
    if (p.tier !== "owner" && p.tier !== "worker") {
      invalid(`tier:${positionId}`)
    }
    if (
      p.mode !== undefined &&
      p.mode !== "read_only" &&
      p.mode !== "approval_required"
    ) {
      invalid(`mode:${positionId}`)
    }
    const contextScope = p.contextScope
    if (
      contextScope === null ||
      typeof contextScope !== "object" ||
      Array.isArray(contextScope)
    ) {
      invalid(`context_scope:${positionId}`)
    }
    const read = (contextScope as Record<string, unknown>).read
    if (
      !Array.isArray(read) ||
      read.some((scope) => typeof scope !== "string" || scope.length === 0)
    ) {
      invalid(`context_scope_read:${positionId}`)
    }
    const authorityScope = p.authorityScope
    if (
      authorityScope === null ||
      typeof authorityScope !== "object" ||
      Array.isArray(authorityScope)
    ) {
      invalid(`authority_scope:${positionId}`)
    }
    const authority = authorityScope as Record<string, unknown>
    if (authority.writes !== "deny") invalid(`writes:${positionId}`)
    const tools = authority.tools
    if (tools === null || typeof tools !== "object" || Array.isArray(tools)) {
      invalid(`tools:${positionId}`)
    }
    const toolsRecord = tools as Record<string, unknown>
    for (const key of ["allow", "deny"] as const) {
      const list = toolsRecord[key]
      if (
        !Array.isArray(list) ||
        list.some((tool) => typeof tool !== "string" || tool.length === 0)
      ) {
        invalid(`tools_${key}:${positionId}`)
      }
    }
    const delegation = authority.delegation
    if (
      delegation === null ||
      typeof delegation !== "object" ||
      Array.isArray(delegation)
    ) {
      invalid(`delegation:${positionId}`)
    }
    const delegationRecord = delegation as Record<string, unknown>
    if (typeof delegationRecord.allow !== "boolean") {
      invalid(`delegation_allow:${positionId}`)
    }
    if (
      !Array.isArray(delegationRecord.targets) ||
      delegationRecord.targets.some(
        (target) => typeof target !== "string" || target.length === 0,
      )
    ) {
      invalid(`delegation_targets:${positionId}`)
    }
    if (
      delegationRecord.escalateTo !== null &&
      typeof delegationRecord.escalateTo !== "string"
    ) {
      invalid(`delegation_escalate:${positionId}`)
    }
    validated[positionId] = {
      position: positionId,
      tier: p.tier as PermissionTier,
      ...(p.mode !== undefined ? { mode: p.mode as PositionMode } : {}),
      contextScope: { read: [...(read as string[])] },
      authorityScope: {
        writes: "deny",
        tools: {
          allow: [...(toolsRecord.allow as string[])],
          deny: [...(toolsRecord.deny as string[])],
        },
        delegation: {
          allow: delegationRecord.allow as boolean,
          targets: [...(delegationRecord.targets as string[])],
          escalateTo: delegationRecord.escalateTo as string | null,
        },
      },
    }
  }
  return {
    schemaVersion: ORG_PERMISSIONS_SCHEMA_VERSION,
    business: record.business as string,
    owner: record.owner as string,
    positions: validated,
  }
}
