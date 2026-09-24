import assert from "node:assert/strict"
import test from "node:test"

import { chat } from "../../apps/cli/turn/index.js"

test("#334 AC-002: chat without --position fails closed", async () => {
  await assert.rejects(
    () => chat({ args: [] }),
    /turn_run_requires_position/,
  )
})

test("#334 AC-002: chat --json fails closed like turn run", async () => {
  await assert.rejects(
    () => chat({ args: [], position: "repo-owner", json: true, question: "hi" }),
    /turn_run_emits_ndjson_not_json/,
  )
})

test("#334 AC-003: chat --help does not start a REPL", async () => {
  const chunks: string[] = []
  const original = process.stdout.write
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  try {
    await chat({ args: [], help: true })
  } finally {
    process.stdout.write = original
  }
  const text = chunks.join("")
  assert.match(text, /digital-employee chat/)
  assert.match(text, /--position/)
  assert.match(text, /no TTY REPL/)
})
