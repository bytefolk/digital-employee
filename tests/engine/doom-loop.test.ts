import assert from "node:assert/strict"
import test from "node:test"

import { DoomLoopDetector } from "../../packages/engine/src/index.js"

test("repetition triggers at the threshold", () => {
  const detector = new DoomLoopDetector({ repetitionThreshold: 3 })
  assert.equal(detector.observe("same"), "none")
  assert.equal(detector.observe("same"), "none")
  assert.equal(detector.observe("same"), "repetition")
})

test("continuously changing output never trips repetition", () => {
  const detector = new DoomLoopDetector({ repetitionThreshold: 3 })
  for (let index = 0; index < 10; index += 1) {
    assert.equal(detector.observe(`answer ${index}`), "none")
  }
})

test("oscillation triggers after the configured full cycles", () => {
  const detector = new DoomLoopDetector({
    oscillationCycles: 2,
    repetitionThreshold: 10,
  })
  const sequence = ["A", "B", "A", "B", "A", "B", "A", "B"]
  const results = sequence.map((value) => detector.observe(value))
  assert.equal(results.slice(0, 7).every((value) => value === "none"), true)
  assert.equal(results[7], "oscillation")
})

test("a broken oscillation resets the cycle count", () => {
  const detector = new DoomLoopDetector({
    oscillationCycles: 2,
    repetitionThreshold: 10,
  })
  for (const value of ["A", "B", "A", "B", "C"]) {
    assert.equal(detector.observe(value), "none")
  }
  assert.equal(detector.observe("A"), "none")
  assert.equal(detector.observe("B"), "none")
  assert.equal(detector.observe("A"), "none")
})

test("reset clears history", () => {
  const detector = new DoomLoopDetector({ repetitionThreshold: 2 })
  detector.observe("x")
  detector.reset()
  assert.equal(detector.observe("x"), "none")
})

test("invalid configuration fails closed", () => {
  assert.throws(
    () => new DoomLoopDetector({ repetitionThreshold: 1 }),
    TypeError,
  )
  assert.throws(
    () => new DoomLoopDetector({ oscillationCycles: 0 }),
    TypeError,
  )
})
