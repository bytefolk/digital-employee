/**
 * Dual-dimension budget contract (turn budget + position budget).
 *
 * Declaration lives in the organization model; execution lives in the engine.
 * Units are tokens and iterations only — no monetary dimension enters the
 * budget gate (billing semantics are a non-goal of the workspace milestone).
 */

export const MAX_BUDGET_CAP = 1_000_000_000

export interface BudgetScope {
  tokens?: number
  iterations?: number
}

export interface PositionBudgetDeclaration {
  perTask: BudgetScope
  perDay: BudgetScope
}

export interface BudgetUsage {
  taskUsedTokens: number
  taskUsedIterations: number
  dayUsedTokens: number
  dayUsedIterations: number
}

export type BudgetDimension =
  | "position_day_tokens"
  | "position_day_iterations"
  | "position_task_tokens"
  | "position_task_iterations"
  | "turn_tokens"
  | "turn_iterations"

export interface BudgetExceeded {
  dimension: BudgetDimension
  used: number
  limit: number
}

function isPositiveBoundedInt(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_BUDGET_CAP
  )
}

function scopeAllocated(scope: BudgetScope): boolean {
  return (
    isPositiveBoundedInt(scope.tokens) || isPositiveBoundedInt(scope.iterations)
  )
}

/**
 * Fail-closed validation of a position budget declaration. "Fully allocated"
 * means both scopes are present and each carries at least one positive,
 * bounded integer cap.
 */
export function validatePositionBudgetDeclaration(
  value: unknown,
): PositionBudgetDeclaration {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("workspace_org_budget_missing")
  }
  const record = value as Record<string, unknown>
  const perTask = record.perTask
  const perDay = record.perDay
  if (
    perTask === null ||
    typeof perTask !== "object" ||
    Array.isArray(perTask) ||
    perDay === null ||
    typeof perDay !== "object" ||
    Array.isArray(perDay)
  ) {
    throw new TypeError("workspace_org_budget_not_allocated")
  }
  const taskScope = perTask as BudgetScope
  const dayScope = perDay as BudgetScope
  // Key/value legality is checked first so a malformed cap fails closed as
  // invalid rather than being masked as an unallocated scope.
  for (const scope of [taskScope, dayScope]) {
    for (const key of Object.keys(scope)) {
      if (key !== "tokens" && key !== "iterations") {
        throw new TypeError("workspace_org_budget_invalid")
      }
      if (!isPositiveBoundedInt(scope[key as keyof BudgetScope])) {
        throw new TypeError("workspace_org_budget_invalid")
      }
    }
  }
  // Then each scope must carry at least one cap.
  if (!scopeAllocated(taskScope) || !scopeAllocated(dayScope)) {
    throw new TypeError("workspace_org_budget_not_allocated")
  }
  return { perTask: taskScope, perDay: dayScope }
}

/**
 * Durable consumption ledger for position budgets. The engine core depends on
 * this port only; persistence policy (workspace-local JSON, 0600) belongs to
 * the wiring layer.
 */
export interface BudgetLedgerPort {
  read(
    positionId: string,
    taskId: string,
    dayKey: string,
  ): Promise<BudgetUsage>
  commit(entry: {
    positionId: string
    taskId: string
    dayKey: string
    tokens: number
    iterations: number
  }): Promise<void>
}

export function emptyBudgetUsage(): BudgetUsage {
  return {
    taskUsedTokens: 0,
    taskUsedIterations: 0,
    dayUsedTokens: 0,
    dayUsedIterations: 0,
  }
}

/** In-memory reference ledger for fixtures and tests. */
export function createInMemoryBudgetLedger(): BudgetLedgerPort {
  const store = new Map<string, BudgetUsage>()
  const key = (positionId: string, taskId: string, dayKey: string) =>
    `${positionId}\u0000${taskId}\u0000${dayKey}`
  return {
    async read(positionId, taskId, dayKey) {
      return { ...(store.get(key(positionId, taskId, dayKey)) ?? emptyBudgetUsage()) }
    },
    async commit(entry) {
      const k = key(entry.positionId, entry.taskId, entry.dayKey)
      const current = store.get(k) ?? emptyBudgetUsage()
      store.set(k, {
        taskUsedTokens: current.taskUsedTokens + entry.tokens,
        taskUsedIterations: current.taskUsedIterations + entry.iterations,
        dayUsedTokens: current.dayUsedTokens + entry.tokens,
        dayUsedIterations: current.dayUsedIterations + entry.iterations,
      })
    },
  }
}

/**
 * Deterministic consumption order: day scope first, then task scope. Returns
 * the first exceeded dimension, or undefined when the increment fits.
 */
export function checkPositionBudget(
  declaration: PositionBudgetDeclaration,
  usage: BudgetUsage,
  increment: { tokens: number; iterations: number },
): BudgetExceeded | undefined {
  const dayTokens = usage.dayUsedTokens + increment.tokens
  if (
    declaration.perDay.tokens !== undefined &&
    dayTokens > declaration.perDay.tokens
  ) {
    return { dimension: "position_day_tokens", used: dayTokens, limit: declaration.perDay.tokens }
  }
  const dayIterations = usage.dayUsedIterations + increment.iterations
  if (
    declaration.perDay.iterations !== undefined &&
    dayIterations > declaration.perDay.iterations
  ) {
    return {
      dimension: "position_day_iterations",
      used: dayIterations,
      limit: declaration.perDay.iterations,
    }
  }
  const taskTokens = usage.taskUsedTokens + increment.tokens
  if (
    declaration.perTask.tokens !== undefined &&
    taskTokens > declaration.perTask.tokens
  ) {
    return { dimension: "position_task_tokens", used: taskTokens, limit: declaration.perTask.tokens }
  }
  const taskIterations = usage.taskUsedIterations + increment.iterations
  if (
    declaration.perTask.iterations !== undefined &&
    taskIterations > declaration.perTask.iterations
  ) {
    return {
      dimension: "position_task_iterations",
      used: taskIterations,
      limit: declaration.perTask.iterations,
    }
  }
  return undefined
}
