import {
  AgentHostRegistry,
} from "../../packages/core/src/agent-host-registry.js"
import type {
  AgentHostAdapter,
  AgentHostProbeResult,
} from "../../packages/core/src/agent-host.js"
import {
  BUILT_IN_AGENT_HOST_IDS,
  probeCliAgentHost,
} from "./agent-hosts.js"
import type { BuiltInAgentHostId } from "./agent-hosts.js"
import { createQoderAgentHostAdapter } from "./qoder-agent-host.js"

const BUILT_IN_ALIASES: Readonly<
  Partial<Record<BuiltInAgentHostId, readonly string[]>>
> = {
  "claude-code": ["claude"],
  qoder: ["qoder-cli", "qodercli"],
  codex: ["codex-cli"],
  "qwen-code": ["qwen"],
  codebuddy: ["codebuddy-code"],
}

const BUILT_IN_ADAPTER_FACTORIES: Readonly<
  Partial<Record<BuiltInAgentHostId, () => AgentHostAdapter>>
> = {
  qoder: () => createQoderAgentHostAdapter(),
}

/**
 * Creates the operator-owned host catalog. Nothing is auto-discovered from an
 * employee package, PATH, node_modules, or the current directory. Embedders may
 * explicitly register additional trusted adapters on the returned registry.
 */
export function createBuiltInAgentHostRegistry(): AgentHostRegistry {
  const registry = new AgentHostRegistry()
  for (const hostId of BUILT_IN_AGENT_HOST_IDS) {
    const createAdapter = BUILT_IN_ADAPTER_FACTORIES[hostId]
    registry.register({
      id: hostId,
      aliases: BUILT_IN_ALIASES[hostId],
      probe: () =>
        createAdapter
          ? createAdapter().probe()
          : probeCliAgentHost(hostId),
      ...(createAdapter ? { createAdapter } : {}),
    })
  }
  return registry
}

export const builtInAgentHostRegistry = createBuiltInAgentHostRegistry()

export function resolveBuiltInAgentHostId(
  value: string,
): BuiltInAgentHostId | undefined {
  try {
    return builtInAgentHostRegistry.resolve(value) as BuiltInAgentHostId
  } catch {
    return undefined
  }
}

export async function createBuiltInAgentHostAdapter(
  hostId: string,
): Promise<AgentHostAdapter | undefined> {
  if (!builtInAgentHostRegistry.hasAdapter(hostId)) return undefined
  return builtInAgentHostRegistry.create(hostId)
}

export async function probeBuiltInAgentHost(
  hostId: string,
): Promise<AgentHostProbeResult> {
  return builtInAgentHostRegistry.probe(hostId)
}

export async function probeBuiltInAgentHosts(
  hostIds: readonly string[] = BUILT_IN_AGENT_HOST_IDS,
): Promise<AgentHostProbeResult[]> {
  return Promise.all(hostIds.map((hostId) => probeBuiltInAgentHost(hostId)))
}
