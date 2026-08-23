import assert from "node:assert/strict"
import test from "node:test"

import {
  CONTEXT_SLOT_ORDER,
  assembleContext,
} from "../../packages/engine/src/index.js"

const input = {
  positionId: "repo-owner",
  turnId: "turn-1",
  instructions: "You are the repo owner.",
  spec: "mode=read_only",
  turnInput: "Summarize the open issues.",
}

test("assembly order is fixed and deterministic", () => {
  const assembled = assembleContext(input)
  assert.deepEqual(
    assembled.blocks.map((block) => block.slot),
    ["position_instructions", "position_spec", "turn_input"],
  )
  assert.deepEqual(assembled.manifest.order, [...CONTEXT_SLOT_ORDER])
})

test("memory recall slot stays empty until integration but keeps its place", () => {
  const withoutRecall = assembleContext(input)
  assert.ok(
    !withoutRecall.blocks.some((block) => block.slot === "memory_recall"),
  )
  const withRecall = assembleContext({ ...input, memoryRecall: ["fact A"] })
  const recallBlock = withRecall.blocks.find(
    (block) => block.slot === "memory_recall",
  )
  assert.ok(recallBlock)
  assert.equal(recallBlock!.text, "fact A")
  assert.equal(
    withRecall.blocks[withRecall.blocks.length - 1]!.slot,
    "memory_recall",
  )
})

test("digest is stable for identical inputs and changes with content", () => {
  const first = assembleContext(input)
  const second = assembleContext({ ...input })
  assert.equal(first.manifest.digest, second.manifest.digest)
  const changed = assembleContext({ ...input, turnInput: "Different." })
  assert.notEqual(first.manifest.digest, changed.manifest.digest)
})

test("block byte limit truncates and leaves a trace", () => {
  const assembled = assembleContext(
    { ...input, instructions: "a".repeat(100) },
    { maxBlockBytes: 40 },
  )
  const instructions = assembled.blocks.find(
    (block) => block.slot === "position_instructions",
  )!
  assert.equal(instructions.byteLength, 40)
  assert.equal(instructions.truncatedBytes, 60)
  assert.equal(
    assembled.manifest.blocks.find(
      (entry) => entry.slot === "position_instructions",
    )!.truncatedBytes,
    60,
  )
})

test("total byte limit truncates lower-priority slots last", () => {
  const assembled = assembleContext(
    {
      ...input,
      instructions: "i".repeat(50),
      spec: "s".repeat(50),
      turnInput: "t".repeat(50),
    },
    { maxTotalBytes: 120 },
  )
  const total = assembled.blocks.reduce(
    (sum, block) => sum + block.byteLength,
    0,
  )
  assert.ok(total <= 120)
  assert.equal(assembled.blocks[0]!.byteLength, 50)
  assert.equal(assembled.blocks[1]!.byteLength, 50)
  assert.equal(assembled.blocks[2]!.byteLength, 20)
  assert.equal(assembled.blocks[2]!.truncatedBytes, 30)
})

test("multi-byte truncation never splits a code point", () => {
  const assembled = assembleContext(
    { ...input, instructions: "汉".repeat(10) },
    { maxBlockBytes: 4 },
  )
  const instructions = assembled.blocks.find(
    (block) => block.slot === "position_instructions",
  )!
  assert.equal(instructions.byteLength, 3)
  assert.equal(instructions.text, "汉")
  assert.equal(instructions.truncatedBytes, 27)
})

test("empty turn input is rejected", () => {
  assert.throws(() => assembleContext({ ...input, turnInput: "" }), TypeError)
})
