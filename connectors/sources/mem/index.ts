/**
 * Real-local mem MCP knowledge source connector (Phase A, Issue #42).
 *
 * Exercises scoped memory recall through an actual pinned local mem service
 * using the durable-context.v1 contract. All decisions use the REAL_LOCAL_CODES
 * namespace; synthetic codes are never reused.
 */
import { CoreError } from "../../../packages/core/src/contracts.js"
import {
  REAL_LOCAL_CODES,
  requireMatrixComponent,
} from "../../../packages/core/src/component-matrix.js"
import type {
  ComponentMatrix,
  ComponentMatrixEntry,
} from "../../../packages/core/src/component-matrix.js"
import type {
  CapabilityGrantSet,
  CapabilityScope,
  MemoryRecallItem,
} from "../../../packages/core/src/mcp-conformance.js"

export const MEM_CONTRACT = "durable-context.v1" as const
export const MEM_COMPONENT_NAME = "mem" as const

export interface MemSourceOptions {
  matrix: ComponentMatrix
  grants: CapabilityGrantSet
  principal: string
  workspace: string
  /** Override fetch for testing */
  fetchImpl?: typeof globalThis.fetch
}

export interface MemHealthResult {
  available: boolean
  version?: string
  error?: string
}

function realLocalError(code: string, details?: unknown): CoreError {
  return new CoreError(code, `real-local mem decision: ${code}`, {
    status: 400,
    retryable: false,
    details,
  })
}

function checkGrant(
  grants: CapabilityGrantSet,
  principal: string,
  workspace: string,
): void {
  const entry = grants.grants.find((g) => g.server === MEM_COMPONENT_NAME)
  if (!entry) {
    throw realLocalError(REAL_LOCAL_CODES.grantMissing, {
      server: MEM_COMPONENT_NAME,
    })
  }
  if (entry.revoked) {
    throw realLocalError(REAL_LOCAL_CODES.grantRevoked, {
      server: MEM_COMPONENT_NAME,
    })
  }
  if (entry.mode !== "read") {
    throw realLocalError(REAL_LOCAL_CODES.modeExcessive, {
      server: MEM_COMPONENT_NAME,
    })
  }
  const scoped = entry.scopes.some(
    (scope: CapabilityScope) =>
      scope.principal === principal && scope.workspace === workspace,
  )
  if (!scoped) {
    throw realLocalError(REAL_LOCAL_CODES.scopeDenied, {
      server: MEM_COMPONENT_NAME,
      principal,
      workspace,
    })
  }
}

/**
 * Read-only mem MCP source that connects to an actual pinned local mem service.
 */
export class MemKnowledgeSource {
  readonly component: ComponentMatrixEntry
  readonly grants: CapabilityGrantSet
  readonly principal: string
  readonly workspace: string
  readonly baseUrl: string
  private readonly fetchFn: typeof globalThis.fetch

  constructor(options: MemSourceOptions) {
    this.component = requireMatrixComponent(
      options.matrix,
      MEM_COMPONENT_NAME,
      MEM_CONTRACT,
    )
    this.grants = options.grants
    this.principal = options.principal
    this.workspace = options.workspace
    const port = this.component.ports["http"]
    if (!port) {
      throw realLocalError(REAL_LOCAL_CODES.matrixUnsupported, {
        reason: "no http port in matrix",
      })
    }
    this.baseUrl = `http://127.0.0.1:${port}`
    this.fetchFn = options.fetchImpl ?? globalThis.fetch
  }

  /**
   * Probes the health endpoint of the pinned mem service.
   */
  async health(): Promise<MemHealthResult> {
    try {
      const response = await this.fetchFn(
        `${this.baseUrl}${this.component.healthEndpoint}`,
        { method: "GET", signal: AbortSignal.timeout(5_000) },
      )
      if (!response.ok) {
        return { available: false, error: `status ${response.status}` }
      }
      const body = (await response.json()) as Record<string, unknown>
      return {
        available: true,
        version: typeof body.version === "string" ? body.version : undefined,
      }
    } catch (error) {
      return {
        available: false,
        error: error instanceof Error ? error.message : "unknown",
      }
    }
  }

  /**
   * Recalls approved, active memories for the granted principal/workspace scope.
   * Fails closed on any grant, scope, or service error.
   */
  async recall(): Promise<MemoryRecallItem[]> {
    checkGrant(this.grants, this.principal, this.workspace)

    let response: Response
    try {
      response = await this.fetchFn(
        `${this.baseUrl}/v1/context/${encodeURIComponent(this.workspace)}/recall`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ principal: this.principal }),
          signal: AbortSignal.timeout(30_000),
        },
      )
    } catch (error) {
      throw realLocalError(REAL_LOCAL_CODES.serviceUnavailable, {
        server: MEM_COMPONENT_NAME,
        reason: error instanceof Error ? error.message : "fetch_failed",
      })
    }

    if (!response.ok) {
      throw realLocalError(REAL_LOCAL_CODES.serviceUnavailable, {
        server: MEM_COMPONENT_NAME,
        status: response.status,
      })
    }

    const body = (await response.json()) as { memories?: unknown[] }
    if (!Array.isArray(body.memories)) {
      throw realLocalError(REAL_LOCAL_CODES.serviceUnavailable, {
        server: MEM_COMPONENT_NAME,
        reason: "invalid_response_shape",
      })
    }

    return body.memories
      .filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          (entry as Record<string, unknown>).state === "active" &&
          (entry as Record<string, unknown>).approved === true,
      )
      .map((entry) => ({
        locator: `mem://${this.workspace}/${entry.id}@${entry.revision}`,
        text: String(entry.text ?? ""),
      }))
  }
}
