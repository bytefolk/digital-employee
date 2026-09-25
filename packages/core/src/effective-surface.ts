import { MCP_CONFORMANCE_CODES } from "./mcp-conformance.js"

/**
 * Reconciled engine-route capability codes (#300 R2).
 * Existing `MCP_CONFORMANCE_CODES` public strings are copied unchanged;
 * additive codes live beside them. Consumers must not fork private copies.
 */
export const ENGINE_CAPABILITY_CODES = {
  ...MCP_CONFORMANCE_CODES,
  wideningDenied: "capability_widening_denied",
  skillToolDenied: "capability_skill_tool_denied",
  networkUnenforceable: "capability_network_unenforceable",
} as const

export type EngineCapabilityCode =
  (typeof ENGINE_CAPABILITY_CODES)[keyof typeof ENGINE_CAPABILITY_CODES]

export type CapabilityKind = "mcp_tool" | "skill_tool" | "network_mode"

export interface DeclaredCapability {
  kind: CapabilityKind
  id: string
}

export interface AuthorityScopeInput {
  tools: {
    allow: readonly string[]
    deny?: readonly string[]
  }
}

export interface DeniedCapability {
  capability: DeclaredCapability
  code: EngineCapabilityCode
}

export interface EffectiveSurface {
  allow: DeclaredCapability[]
  deny: DeniedCapability[]
  codes: EngineCapabilityCode[]
}

function compareCapability(left: DeclaredCapability, right: DeclaredCapability) {
  return left.kind === right.kind
    ? left.id.localeCompare(right.id)
    : left.kind.localeCompare(right.kind)
}

function toolPermitted(id: string, scope: AuthorityScopeInput["tools"]): boolean {
  if (scope.deny?.includes(id)) return false
  return scope.allow.includes(id)
}

function denyCode(kind: CapabilityKind): EngineCapabilityCode {
  if (kind === "skill_tool") return ENGINE_CAPABILITY_CODES.skillToolDenied
  if (kind === "network_mode") return ENGINE_CAPABILITY_CODES.networkUnenforceable
  return ENGINE_CAPABILITY_CODES.scopeDenied
}

/**
 * Pure intersection of declared capabilities with position Authority Scope.
 * The result is never a superset of `declared ∩ authorityScope`.
 */
export function intersectEffectiveSurface(input: {
  declared: readonly DeclaredCapability[]
  authorityScope: AuthorityScopeInput
}): EffectiveSurface {
  const allow: DeclaredCapability[] = []
  const deny: DeniedCapability[] = []
  for (const capability of input.declared) {
    if (capability.kind === "network_mode") {
      allow.push({ ...capability })
      continue
    }
    if (toolPermitted(capability.id, input.authorityScope.tools)) {
      allow.push({ ...capability })
    } else {
      deny.push({ capability: { ...capability }, code: denyCode(capability.kind) })
    }
  }
  allow.sort(compareCapability)
  deny.sort((left, right) =>
    compareCapability(left.capability, right.capability),
  )
  const codes = [...new Set(deny.map((item) => item.code))].sort()
  return { allow, deny, codes }
}
