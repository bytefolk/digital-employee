import type { BudgetDimension } from "./budget.js"

export const ESCALATION_RECORD_VERSION = "escalation-record.v1" as const

/**
 * Structured escalation record — the V4 seam with the organization model.
 *
 * Budget-exceeded and loop-control stops share one escalation mechanism: the
 * route IS the reporting line. Engine-side fields are pinned by this
 * contract; organization-side wording follows the org schema record.
 */

export type EscalationCause =
  | "turn_budget_exceeded"
  | "position_budget_exceeded"
  | "iteration_cap"
  | "doom_loop"
  | "deadline_exceeded"

export interface EscalationBudgetSnapshot {
  dimension: BudgetDimension | "none"
  used: number
  limit: number
}

export interface EscalationRouting {
  /**
   * Direct superior resolved from the organization tree `reportTo` field.
   * Positions without a superior (the owner) escalate to the workspace
   * operator entry.
   */
  directSuperior: string
  resolvedFrom: "organization.v1alpha1#reportTo" | "workspace.operator_default"
}

export interface EscalationRecord {
  schemaVersion: typeof ESCALATION_RECORD_VERSION
  escalationId: string
  workspaceRef: string
  positionId: string
  turnId: string
  runId: string
  cause: EscalationCause
  budgetSnapshot: EscalationBudgetSnapshot
  routing: EscalationRouting
  evidenceRef?: string
  occurredAt: string
}

/**
 * Reporting-line lookup port. Returns the position's `reportTo` value, or
 * null for the owner / top position, or undefined when the position is
 * unknown to the organization model.
 */
export interface OrgReportingLookup {
  reportTo(positionId: string): string | null | undefined
}

export const WORKSPACE_OPERATOR_ENTRY = "workspace.operator" as const

/**
 * Resolve the escalation route along the reporting line. Owner (reportTo is
 * null) and unknown positions route to the workspace operator entry — S1
 * records the pointer only; delivery and hand-off belong to the workbench.
 */
export function resolveEscalationRouting(
  positionId: string,
  lookup: OrgReportingLookup | undefined,
): EscalationRouting {
  const superior = lookup?.reportTo(positionId)
  if (typeof superior === "string" && superior.trim().length > 0) {
    return {
      directSuperior: superior,
      resolvedFrom: "organization.v1alpha1#reportTo",
    }
  }
  return {
    directSuperior: WORKSPACE_OPERATOR_ENTRY,
    resolvedFrom: "workspace.operator_default",
  }
}

export interface EscalationSinkPort {
  write(record: EscalationRecord): Promise<void>
}

export interface InMemoryEscalationSink extends EscalationSinkPort {
  records: readonly EscalationRecord[]
}

export function createInMemoryEscalationSink(): InMemoryEscalationSink {
  const stored: EscalationRecord[] = []
  return {
    records: stored,
    async write(record) {
      stored.push(record)
    },
  }
}
