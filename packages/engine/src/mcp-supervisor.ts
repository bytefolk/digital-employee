/**
 * Engine-owned MCP stdio supervisor (#301 R2).
 *
 * Manifest digest is checked before spawn. tools/list is informational and
 * never widens the declared tool list. Restarts are bounded to 2 (3 attempts).
 */

import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createInterface } from "node:readline"

import { intersectEffectiveSurface } from "../../core/src/effective-surface.js"

export const MCP_RESTART_BUDGET = 2
export const MCP_MANIFEST_DRIFT_CODE = "mcp_manifest_drift"
export const MCP_RESTART_EXHAUSTED_CODE = "mcp_restart_exhausted"

export class McpSupervisorError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "McpSupervisorError"
  }
}

export interface DeclaredStdioServer {
  name: string
  command: string
  args?: readonly string[]
}

export interface McpLoadEvidence {
  digest: string
  servers: string[]
  projectedAllowlist: string[]
  restartAttempts: number
  restartBudget: typeof MCP_RESTART_BUDGET
}

function canonicalDigest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex")}`
}

async function listToolsOnce(
  server: DeclaredStdioServer,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const child = spawn(server.command, [...(server.args ?? [])], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  })
  const names = await new Promise<string[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error("timeout"))
    }, 5_000)
    const settle = (error?: Error, result: string[] = []) => {
      clearTimeout(timer)
      child.kill("SIGKILL")
      if (error) reject(error)
      else resolve(result)
    }
    child.on("error", (error) => settle(error))
    const reader = createInterface({ input: child.stdout! })
    reader.on("line", (line) => {
      try {
        const parsed = JSON.parse(line) as {
          id?: number
          result?: { tools?: Array<{ name?: string }> }
        }
        if (parsed.id === 2 && Array.isArray(parsed.result?.tools)) {
          settle(
            undefined,
            parsed.result.tools
              .map((tool) => tool.name)
              .filter((name): name is string => typeof name === "string"),
          )
        }
      } catch {
        // ignore non-JSON
      }
    })
    const write = (payload: unknown) => {
      child.stdin!.write(`${JSON.stringify(payload)}\n`)
    }
    write({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "digital-employee", version: "0" },
      },
    })
    write({ jsonrpc: "2.0", method: "notifications/initialized" })
    write({ jsonrpc: "2.0", id: 2, method: "tools/list" })
  })
  return names
}

/**
 * Load declared MCP servers, fail closed on digest drift, project the
 * allowlist as declaredTools ∩ Authority Scope, and ignore discovery extras.
 */
export async function loadMcpAllowlist(input: {
  declaredManifest: unknown
  expectedDigest: string
  servers: readonly DeclaredStdioServer[]
  declaredTools: readonly string[]
  authorityAllow: readonly string[]
  authorityDeny?: readonly string[]
  env?: NodeJS.ProcessEnv
}): Promise<{ allow: string[]; evidence: McpLoadEvidence }> {
  const digest = canonicalDigest(input.declaredManifest)
  if (digest !== input.expectedDigest) {
    throw new McpSupervisorError(MCP_MANIFEST_DRIFT_CODE)
  }
  let restartAttempts = 0
  const discovered = new Set<string>()
  for (const server of input.servers) {
    let loaded = false
    for (let attempt = 0; attempt <= MCP_RESTART_BUDGET; attempt += 1) {
      if (attempt > 0) restartAttempts += 1
      try {
        const names = await listToolsOnce(server, input.env ?? process.env)
        for (const name of names) discovered.add(name)
        loaded = true
        break
      } catch {
        // retry until budget
      }
    }
    if (!loaded) {
      throw new McpSupervisorError(MCP_RESTART_EXHAUSTED_CODE)
    }
  }
  const surface = intersectEffectiveSurface({
    declared: input.declaredTools.map((id) => ({ kind: "mcp_tool" as const, id })),
    authorityScope: {
      tools: {
        allow: [...input.authorityAllow],
        ...(input.authorityDeny ? { deny: [...input.authorityDeny] } : {}),
      },
    },
  })
  const allow = surface.allow.map((item) => item.id)
  for (const name of discovered) {
    if (!input.declaredTools.includes(name) && !allow.includes(name)) {
      // informational only — never widen
    }
  }
  return {
    allow,
    evidence: {
      digest,
      servers: input.servers.map((server) => server.name),
      projectedAllowlist: allow,
      restartAttempts,
      restartBudget: MCP_RESTART_BUDGET,
    },
  }
}
