import assert from "node:assert/strict"
import test from "node:test"

import {
  checkPositionBudget,
  createInMemoryBudgetLedger,
  emptyBudgetUsage,
  validatePositionBudgetDeclaration,
} from "../../packages/engine/src/index.js"

const FULL_DECLARATION = {
  perTask: { tokens: 100, iterations: 4 },
  perDay: { tokens: 500, iterations: 20 },
}

test("fully allocated declaration parses", () => {
  const parsed = validatePositionBudgetDeclaration(FULL_DECLARATION)
  assert.equal(parsed.perTask.tokens, 100)
  assert.equal(parsed.perDay.iterations, 20)
})

test("single-scope allocation is accepted per scope", () => {
  const parsed = validatePositionBudgetDeclaration({
    perTask: { iterations: 2 },
    perDay: { tokens: 10 },
  })
  assert.equal(parsed.perTask.iterations, 2)
  assert.equal(parsed.perDay.tokens, 10)
})

test("missing budget fails closed with the missing code", () => {
  assert.throws(
    () => validatePositionBudgetDeclaration(null),
    (error: unknown) =>
      error instanceof TypeError && error.message === "workspace_org_budget_missing",
  )
})

test("absent scope fails closed as not allocated", () => {
  assert.throws(
    () => validatePositionBudgetDeclaration({ perTask: { tokens: 5 } }),
    (error: unknown) =>
      error instanceof TypeError &&
      error.message === "workspace_org_budget_not_allocated",
  )
})

test("empty scopes fail closed as not allocated", () => {
  assert.throws(
    () => validatePositionBudgetDeclaration({ perTask: {}, perDay: {} }),
    (error: unknown) =>
      error instanceof TypeError &&
      error.message === "workspace_org_budget_not_allocated",
  )
})

test("non-positive, oversized, and unknown keys fail closed as invalid", () => {
  for (const bad of [
    { perTask: { tokens: 0 }, perDay: { tokens: 5 } },
    { perTask: { tokens: 2_000_000_000 }, perDay: { tokens: 5 } },
    { perTask: { tokens: 1.5 }, perDay: { tokens: 5 } },
    { perTask: { tokens: 5, currency: "usd" }, perDay: { tokens: 5 } },
  ]) {
    assert.throws(
      () => validatePositionBudgetDeclaration(bad),
      (error: unknown) =>
        error instanceof TypeError &&
        error.message === "workspace_org_budget_invalid",
    )
  }
})

test("consumption order is day before task", () => {
  const usage = { ...emptyBudgetUsage(), dayUsedIterations: 20 }
  const exceeded = checkPositionBudget(FULL_DECLARATION, usage, {
    tokens: 0,
    iterations: 1,
  })
  assert.equal(exceeded?.dimension, "position_day_iterations")
})

test("task token breach reports the task dimension", () => {
  const usage = { ...emptyBudgetUsage(), taskUsedTokens: 100 }
  const exceeded = checkPositionBudget(FULL_DECLARATION, usage, {
    tokens: 1,
    iterations: 0,
  })
  assert.equal(exceeded?.dimension, "position_task_tokens")
  assert.equal(exceeded?.used, 101)
  assert.equal(exceeded?.limit, 100)
})

test("usage within all caps passes", () => {
  const exceeded = checkPositionBudget(FULL_DECLARATION, emptyBudgetUsage(), {
    tokens: 10,
    iterations: 1,
  })
  assert.equal(exceeded, undefined)
})

test("in-memory ledger accumulates per position/task/day", async () => {
  const ledger = createInMemoryBudgetLedger()
  await ledger.commit({
    positionId: "p",
    taskId: "t",
    dayKey: "2026-08-23",
    tokens: 30,
    iterations: 2,
  })
  await ledger.commit({
    positionId: "p",
    taskId: "t",
    dayKey: "2026-08-23",
    tokens: 10,
    iterations: 1,
  })
  const usage = await ledger.read("p", "t", "2026-08-23")
  assert.equal(usage.taskUsedTokens, 40)
  assert.equal(usage.taskUsedIterations, 3)
  assert.equal(usage.dayUsedTokens, 40)
  const other = await ledger.read("p", "t2", "2026-08-23")
  assert.equal(other.taskUsedTokens, 0)
})
