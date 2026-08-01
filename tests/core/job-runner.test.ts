import assert from "node:assert/strict"
import test from "node:test"

import { JobRunner } from "../../packages/core/index.js"

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

test("JobRunner enforces concurrency and drains its FIFO queue", async () => {
  const runner = new JobRunner({
    maxConcurrent: 1,
    maxQueueSize: 2,
    queueTimeoutMs: 1_000,
  })
  const gate = deferred()
  const order = []

  const first = runner.run(
    { actorId: "actor-1", jobId: "job-1" },
    async () => {
      order.push("first:start")
      await gate.promise
      order.push("first:end")
      return "first-result"
    },
  )
  const second = runner.run(
    { actorId: "actor-2", jobId: "job-2" },
    async () => {
      order.push("second:start")
      return "second-result"
    },
  )

  assert.deepEqual(runner.snapshot(), {
    running: 1,
    queued: 1,
    maxConcurrent: 1,
    maxQueueSize: 2,
    closed: false,
  })
  gate.resolve()

  assert.equal(await first, "first-result")
  assert.equal(await second, "second-result")
  assert.deepEqual(order, ["first:start", "first:end", "second:start"])
})

test("JobRunner rejects duplicate jobs and concurrent jobs from the same actor", async () => {
  const runner = new JobRunner({ maxConcurrent: 2 })
  const gate = deferred()
  const first = runner.run(
    { actorId: "actor-1", jobId: "job-1" },
    () => gate.promise,
  )

  await assert.rejects(
    runner.run(
      { actorId: "actor-2", jobId: "job-1" },
      async () => "duplicate",
    ),
    (error) => error.code === "DUPLICATE_REQUEST",
  )
  await assert.rejects(
    runner.run(
      { actorId: "actor-1", jobId: "job-2" },
      async () => "busy",
    ),
    (error) => error.code === "ACTOR_BUSY",
  )

  gate.resolve("done")
  assert.equal(await first, "done")
})

test("JobRunner returns a retry interval while an actor is cooling down", async () => {
  let now = 1_000
  const runner = new JobRunner({
    cooldownMs: 100,
    clock: () => now,
  })

  assert.equal(
    await runner.run(
      { actorId: "actor-1", jobId: "job-1" },
      async () => "first",
    ),
    "first",
  )
  now += 40
  await assert.rejects(
    runner.run(
      { actorId: "actor-1", jobId: "job-2" },
      async () => "too-soon",
    ),
    (error) =>
      error.code === "RATE_LIMITED" &&
      error.details.retryAfterMs === 60 &&
      error.retryable,
  )
  now += 60
  assert.equal(
    await runner.run(
      { actorId: "actor-1", jobId: "job-3" },
      async () => "allowed",
    ),
    "allowed",
  )
})

test("JobRunner reports queue timeout without running the expired task", async () => {
  let timeoutCallback
  const runner = new JobRunner({
    maxConcurrent: 1,
    maxQueueSize: 1,
    queueTimeoutMs: 100,
    setTimer(callback) {
      timeoutCallback = callback
      return 1
    },
    clearTimer() {},
  })
  const gate = deferred()
  const first = runner.run(
    { actorId: "actor-1", jobId: "job-1" },
    () => gate.promise,
  )
  let ran = false
  const queued = runner.run(
    { actorId: "actor-2", jobId: "job-2" },
    async () => {
      ran = true
    },
  )
  const assertion = assert.rejects(
    queued,
    (error) => error.code === "QUEUE_TIMEOUT" && error.retryable,
  )

  timeoutCallback()
  await assertion
  assert.equal(ran, false)
  gate.resolve("done")
  await first
})

test("JobRunner evicts the oldest dedupe entry at the configured capacity", async () => {
  const runner = new JobRunner({
    dedupeWindowMs: 1_000,
    maxSeenJobs: 2,
  })

  for (const jobId of ["job-1", "job-2", "job-3"]) {
    assert.equal(
      await runner.run(
        { actorId: `actor-${jobId}`, jobId },
        async () => jobId,
      ),
      jobId,
    )
  }

  assert.equal(
    await runner.run(
      { actorId: "actor-retry", jobId: "job-1" },
      async () => "evicted",
    ),
    "evicted",
  )
  await assert.rejects(
    runner.run(
      { actorId: "actor-duplicate", jobId: "job-3" },
      async () => "duplicate",
    ),
    (error) => error.code === "DUPLICATE_REQUEST",
  )
})

test("JobRunner evicts the oldest cooldown entry at the configured capacity", async () => {
  const runner = new JobRunner({
    cooldownMs: 1_000,
    dedupeWindowMs: 0,
    maxTrackedActors: 2,
    clock: () => 1_000,
  })

  for (const actorId of ["actor-1", "actor-2", "actor-3"]) {
    assert.equal(
      await runner.run({ actorId }, async () => actorId),
      actorId,
    )
  }

  assert.equal(
    await runner.run({ actorId: "actor-1" }, async () => "evicted"),
    "evicted",
  )
  await assert.rejects(
    runner.run({ actorId: "actor-3" }, async () => "rate-limited"),
    (error) => error.code === "RATE_LIMITED",
  )
})

test("JobRunner validates tracking capacity options", () => {
  assert.throws(
    () => new JobRunner({ maxSeenJobs: 0 }),
    /maxSeenJobs must be an integer greater than or equal to 1/,
  )
  assert.throws(
    () => new JobRunner({ maxTrackedActors: 0 }),
    /maxTrackedActors must be an integer greater than or equal to 1/,
  )
})
