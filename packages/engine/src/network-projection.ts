/**
 * S1 engine-route network policy projection (#309 R2).
 *
 * The S1 engine has no egress surface. declared `host_policy` / `allowlist`
 * are recorded as unenforceable; they are never silently rewritten to a
 * stronger "enforced deny" claim. `deny` and undeclared record effective deny
 * with enforceable=false so the record cannot claim Host-side enforcement.
 */

export type DeclaredNetworkMode = "deny" | "host_policy" | "allowlist"

export interface TurnEvidenceNetwork {
  declared: DeclaredNetworkMode | "undeclared"
  effective: "deny" | "declared_unenforceable"
  enforceable: false
}

export function projectS1NetworkEvidence(
  declared?: DeclaredNetworkMode,
): TurnEvidenceNetwork {
  if (declared === "host_policy" || declared === "allowlist") {
    return {
      declared,
      effective: "declared_unenforceable",
      enforceable: false,
    }
  }
  return {
    declared: declared === "deny" ? "deny" : "undeclared",
    effective: "deny",
    enforceable: false,
  }
}
