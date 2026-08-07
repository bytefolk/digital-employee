/**
 * Real-local doc MCP knowledge source connector (Phase A, Issue #42).
 *
 * Exercises version-addressed document reads through an actual pinned local doc
 * service. All decisions use the REAL_LOCAL_CODES namespace.
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
  DocumentReadItem,
} from "../../../packages/core/src/mcp-conformance.js"

export const DOC_CONTRACT = "document-read.v1" as const
export const DOC_COMPONENT_NAME = "doc" as const

export interface DocSourceOptions {
  matrix: ComponentMatrix
  grants: CapabilityGrantSet
  principal: string
  workspace: string
  /** Override fetch for testing */
  fetchImpl?: typeof globalThis.fetch
}

export interface DocHealthResult {
  available: boolean
  version?: string
  error?: string
}

function realLocalError(code: string, details?: unknown): CoreError {
  return new CoreError(code, `real-local doc decision: ${code}`, {
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
  const entry = grants.grants.find((g) => g.server === DOC_COMPONENT_NAME)
  if (!entry) {
    throw realLocalError(REAL_LOCAL_CODES.grantMissing, {
      server: DOC_COMPONENT_NAME,
    })
  }
  if (entry.revoked) {
    throw realLocalError(REAL_LOCAL_CODES.grantRevoked, {
      server: DOC_COMPONENT_NAME,
    })
  }
  if (entry.mode !== "read") {
    throw realLocalError(REAL_LOCAL_CODES.modeExcessive, {
      server: DOC_COMPONENT_NAME,
    })
  }
  const scoped = entry.scopes.some(
    (scope: CapabilityScope) =>
      scope.principal === principal && scope.workspace === workspace,
  )
  if (!scoped) {
    throw realLocalError(REAL_LOCAL_CODES.scopeDenied, {
      server: DOC_COMPONENT_NAME,
      principal,
      workspace,
    })
  }
}

/**
 * Read-only doc MCP source that connects to an actual pinned local doc service.
 */
export class DocKnowledgeSource {
  readonly component: ComponentMatrixEntry
  readonly grants: CapabilityGrantSet
  readonly principal: string
  readonly workspace: string
  readonly baseUrl: string
  private readonly fetchFn: typeof globalThis.fetch

  constructor(options: DocSourceOptions) {
    this.component = requireMatrixComponent(
      options.matrix,
      DOC_COMPONENT_NAME,
      DOC_CONTRACT,
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
   * Probes the health endpoint of the pinned doc service.
   */
  async health(): Promise<DocHealthResult> {
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
   * Reads a document at an exact pinned revision. Fails closed on grant, scope,
   * revocation, unavailability, or revision mismatch errors.
   */
  async read(documentId: string, revision: number): Promise<DocumentReadItem> {
    checkGrant(this.grants, this.principal, this.workspace)

    if (
      typeof documentId !== "string" ||
      documentId.length === 0 ||
      documentId.length > 128
    ) {
      throw realLocalError(REAL_LOCAL_CODES.itemUnavailable, { documentId })
    }
    if (
      !Number.isInteger(revision) ||
      revision < 1
    ) {
      throw realLocalError(REAL_LOCAL_CODES.revisionMismatch, {
        documentId,
        revision,
      })
    }

    let response: Response
    try {
      response = await this.fetchFn(
        `${this.baseUrl}/v1/documents/${encodeURIComponent(this.workspace)}/${encodeURIComponent(documentId)}?revision=${revision}`,
        {
          method: "GET",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(30_000),
        },
      )
    } catch (error) {
      throw realLocalError(REAL_LOCAL_CODES.serviceUnavailable, {
        server: DOC_COMPONENT_NAME,
        reason: error instanceof Error ? error.message : "fetch_failed",
      })
    }

    if (response.status === 404) {
      throw realLocalError(REAL_LOCAL_CODES.itemUnavailable, { documentId })
    }
    if (response.status === 410) {
      throw realLocalError(REAL_LOCAL_CODES.grantRevoked, { documentId })
    }
    if (response.status === 409) {
      throw realLocalError(REAL_LOCAL_CODES.revisionMismatch, {
        documentId,
        revision,
      })
    }
    if (!response.ok) {
      throw realLocalError(REAL_LOCAL_CODES.serviceUnavailable, {
        server: DOC_COMPONENT_NAME,
        status: response.status,
      })
    }

    const body = (await response.json()) as Record<string, unknown>
    if (
      typeof body.id !== "string" ||
      typeof body.title !== "string" ||
      typeof body.body !== "string" ||
      typeof body.revision !== "number"
    ) {
      throw realLocalError(REAL_LOCAL_CODES.serviceUnavailable, {
        server: DOC_COMPONENT_NAME,
        reason: "invalid_response_shape",
      })
    }

    if (body.revision !== revision) {
      throw realLocalError(REAL_LOCAL_CODES.revisionMismatch, {
        documentId,
        requested: revision,
        actual: body.revision,
      })
    }

    return {
      locator: `doc://${this.workspace}/${body.id}@${body.revision}`,
      title: body.title,
      body: body.body,
      revision: body.revision,
    }
  }
}
