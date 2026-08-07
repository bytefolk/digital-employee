/**
 * AI engine detection for the deploy command.
 * Reuses the existing agent-host probe infrastructure.
 */

import { probeCliAgentHost } from "../agent-hosts.js"
import type { BuiltInAgentHostId } from "../agent-hosts.js"

export interface EngineStatus {
  id: BuiltInAgentHostId
  displayName: string
  available: boolean
}

/** Agent hosts that support actual runs (not probe-only). */
const DEPLOY_ELIGIBLE_HOSTS: BuiltInAgentHostId[] = [
  "qoder",
  "claude-code",
  "qwen-code",
  "codebuddy",
]

const DISPLAY_NAMES: Record<BuiltInAgentHostId, string> = {
  "claude-code": "Claude Code",
  qoder: "Qoder CLI",
  codex: "Codex CLI",
  "qwen-code": "Qwen Code",
  codebuddy: "CodeBuddy",
}

/**
 * Probe all deploy-eligible agent hosts and return their status.
 */
export async function detectEngines(): Promise<EngineStatus[]> {
  const results = await Promise.all(
    DEPLOY_ELIGIBLE_HOSTS.map(async (id) => {
      const probe = await probeCliAgentHost(id)
      return {
        id,
        displayName: DISPLAY_NAMES[id],
        available: probe.available,
      }
    }),
  )
  return results
}
