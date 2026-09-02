/**
 * Single source of truth for service-credential visibility (#241).
 *
 * doctor, `run`, `validate`, and the turn model-port resolution must all
 * evaluate the SAME credential view when deciding host readiness, otherwise a
 * correctly configured machine reads "ready" in one command and
 * "not_configured" in another. The operator environment (process.env) is that
 * view.
 *
 * This module is deliberately value-safe: it reports presence/absence and
 * trimmed length only, never the credential itself, so it can be embedded in
 * diagnostics without leaking secrets. Child-process isolation (the credential
 * stripped from the spawned host's environment and delivered via the 0600
 * auth-payload file) is owned by each adapter's filteredRunEnvironment and is
 * NOT a readiness input.
 */

export const QODER_SERVICE_TOKEN_ENV = "QODER_PERSONAL_ACCESS_TOKEN" as const
export const CLAUDE_SERVICE_TOKEN_ENV = "ANTHROPIC_API_KEY" as const

/** Credential env keys per engine id, for view diffs and diagnostics. */
export const SERVICE_CREDENTIAL_KEYS: Record<string, string> = {
  qoder: QODER_SERVICE_TOKEN_ENV,
  "claude-code": CLAUDE_SERVICE_TOKEN_ENV,
}

/**
 * Read a service credential from the operator environment. Returns the trimmed
 * value, or undefined when absent/blank. Never logs the value.
 */
export function readServiceCredential(
  key: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = environment[key]
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export type CredentialState = "configured" | "missing"

/**
 * Describe the credential view for a set of keys WITHOUT exposing values.
 * Used to render the doctor/run credential-view diff in failure diagnostics.
 */
export function describeCredentialView(
  keys: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, CredentialState> {
  const view: Record<string, CredentialState> = {}
  for (const key of keys) {
    view[key] = readServiceCredential(key, environment) ? "configured" : "missing"
  }
  return view
}

/**
 * The operator credential view used for every readiness decision. Exposed so
 * doctor, run, validate and the turn path all resolve the identical object.
 */
export function operatorCredentialView(
  engine: string,
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, CredentialState> {
  const key = SERVICE_CREDENTIAL_KEYS[engine]
  return describeCredentialView(key ? [key] : [], environment)
}
