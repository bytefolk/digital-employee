import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

import {
  RUNNER_PROTOCOL_VECTOR_FAMILIES,
  RUNNER_PROTOCOL_VECTOR_SCHEMA_VERSION,
  parseRunnerProtocolVectorFile,
  parseRunnerProtocolVectorManifest,
  classifyRunnerProtocolVector,
  runRunnerProtocolVectorCorpus,
} from "../../packages/core/src/runner-protocol-vectors.js"
import type {
  RunnerProtocolVectorFile,
  RunnerProtocolVectorManifest,
} from "../../packages/core/src/runner-protocol-vectors.js"

const VECTORS_DIR = join(
  import.meta.dirname,
  "../../fixtures/runner-protocol-vectors/v1",
)

function loadJson(filename: string): unknown {
  return JSON.parse(readFileSync(join(VECTORS_DIR, filename), "utf-8"))
}

function fileSha256(filename: string): string {
  const content = readFileSync(join(VECTORS_DIR, filename))
  return createHash("sha256").update(content).digest("hex")
}

// --- Manifest integrity ---

test("manifest is well-formed and covers all families", () => {
  const raw = loadJson("manifest.json")
  const manifest = parseRunnerProtocolVectorManifest(raw)
  assert.equal(manifest.schemaVersion, RUNNER_PROTOCOL_VECTOR_SCHEMA_VERSION)
  assert.equal(
    manifest.families.length,
    RUNNER_PROTOCOL_VECTOR_FAMILIES.length,
  )
  for (const family of RUNNER_PROTOCOL_VECTOR_FAMILIES) {
    assert.ok(
      manifest.families.includes(family),
      `manifest missing family: ${family}`,
    )
  }
})

test("manifest file checksums match on disk", () => {
  const manifest = parseRunnerProtocolVectorManifest(loadJson("manifest.json"))
  for (const entry of manifest.files) {
    const actual = fileSha256(entry.file)
    assert.equal(
      actual,
      entry.sha256,
      `checksum mismatch for ${entry.file}`,
    )
  }
})

test("manifest vector counts match file contents", () => {
  const manifest = parseRunnerProtocolVectorManifest(loadJson("manifest.json"))
  for (const entry of manifest.files) {
    const raw = loadJson(entry.file) as { vectors?: unknown[] }
    assert.ok(Array.isArray(raw.vectors))
    assert.equal(
      raw.vectors.length,
      entry.vectorCount,
      `vector count mismatch for ${entry.file}`,
    )
  }
})

// --- Per-family classification ---

test("canonical_bytes vectors classify correctly", async (t) => {
  const file = parseRunnerProtocolVectorFile(
    loadJson("canonical_bytes.json"),
    "canonical_bytes",
  )
  for (const vector of file.vectors) {
    await t.test(vector.id, () => {
      const result = classifyRunnerProtocolVector(vector)
      assert.equal(
        result.kind,
        vector.expect.kind,
        `${vector.id}: expected ${vector.expect.kind}, got ${result.kind} (code: ${result.code})`,
      )
      if (vector.expect.kind === "reject") {
        assert.equal(result.code, vector.expect.code)
      }
      if (
        vector.expect.kind === "accept" &&
        vector.expect.output?.canonical
      ) {
        assert.equal(
          (result.output as Record<string, unknown>)?.canonical,
          vector.expect.output.canonical,
        )
      }
    })
  }
})

test("task_envelope vectors classify correctly", async (t) => {
  const file = parseRunnerProtocolVectorFile(
    loadJson("task_envelope.json"),
    "task_envelope",
  )
  for (const vector of file.vectors) {
    await t.test(vector.id, () => {
      const result = classifyRunnerProtocolVector(vector)
      assert.equal(
        result.kind,
        vector.expect.kind,
        `${vector.id}: expected ${vector.expect.kind}, got ${result.kind} (code: ${result.code})`,
      )
      if (vector.expect.kind === "reject") {
        assert.equal(result.code, vector.expect.code)
      }
    })
  }
})

test("event_chain vectors classify correctly", async (t) => {
  const file = parseRunnerProtocolVectorFile(
    loadJson("event_chain.json"),
    "event_chain",
  )
  for (const vector of file.vectors) {
    await t.test(vector.id, () => {
      const result = classifyRunnerProtocolVector(vector)
      assert.equal(
        result.kind,
        vector.expect.kind,
        `${vector.id}: expected ${vector.expect.kind}, got ${result.kind} (code: ${result.code})`,
      )
      if (vector.expect.kind === "reject") {
        assert.equal(result.code, vector.expect.code)
      }
      if (
        vector.expect.kind === "accept" &&
        vector.expect.output?.digest
      ) {
        assert.equal(
          (result.output as Record<string, unknown>)?.digest,
          vector.expect.output.digest,
        )
      }
      if (
        vector.expect.kind === "accept" &&
        vector.expect.output?.finalDigest
      ) {
        assert.equal(
          (result.output as Record<string, unknown>)?.finalDigest,
          vector.expect.output.finalDigest,
        )
      }
    })
  }
})

test("receipt_envelope vectors classify correctly", async (t) => {
  const file = parseRunnerProtocolVectorFile(
    loadJson("receipt_envelope.json"),
    "receipt_envelope",
  )
  for (const vector of file.vectors) {
    await t.test(vector.id, () => {
      const result = classifyRunnerProtocolVector(vector)
      assert.equal(
        result.kind,
        vector.expect.kind,
        `${vector.id}: expected ${vector.expect.kind}, got ${result.kind} (code: ${result.code})`,
      )
      if (vector.expect.kind === "reject") {
        assert.equal(result.code, vector.expect.code)
      }
    })
  }
})

test("execution_bundle vectors classify correctly", async (t) => {
  const file = parseRunnerProtocolVectorFile(
    loadJson("execution_bundle.json"),
    "execution_bundle",
  )
  for (const vector of file.vectors) {
    await t.test(vector.id, () => {
      const result = classifyRunnerProtocolVector(vector)
      assert.equal(
        result.kind,
        vector.expect.kind,
        `${vector.id}: expected ${vector.expect.kind}, got ${result.kind} (code: ${result.code})`,
      )
      if (vector.expect.kind === "reject") {
        assert.equal(result.code, vector.expect.code)
      }
    })
  }
})

test("usage_binding vectors classify correctly", async (t) => {
  const file = parseRunnerProtocolVectorFile(
    loadJson("usage_binding.json"),
    "usage_binding",
  )
  for (const vector of file.vectors) {
    await t.test(vector.id, () => {
      const result = classifyRunnerProtocolVector(vector)
      assert.equal(
        result.kind,
        vector.expect.kind,
        `${vector.id}: expected ${vector.expect.kind}, got ${result.kind} (code: ${result.code})`,
      )
      if (vector.expect.kind === "reject") {
        assert.equal(result.code, vector.expect.code)
      }
    })
  }
})

test("version_negotiation vectors classify correctly", async (t) => {
  const file = parseRunnerProtocolVectorFile(
    loadJson("version_negotiation.json"),
    "version_negotiation",
  )
  for (const vector of file.vectors) {
    await t.test(vector.id, () => {
      const result = classifyRunnerProtocolVector(vector)
      assert.equal(
        result.kind,
        vector.expect.kind,
        `${vector.id}: expected ${vector.expect.kind}, got ${result.kind} (code: ${result.code})`,
      )
      if (vector.expect.kind === "reject") {
        assert.equal(result.code, vector.expect.code)
      }
    })
  }
})

test("migration vectors classify correctly", async (t) => {
  const file = parseRunnerProtocolVectorFile(
    loadJson("migration.json"),
    "migration",
  )
  for (const vector of file.vectors) {
    await t.test(vector.id, () => {
      const result = classifyRunnerProtocolVector(vector)
      assert.equal(
        result.kind,
        vector.expect.kind,
        `${vector.id}: expected ${vector.expect.kind}, got ${result.kind} (code: ${result.code})`,
      )
      if (vector.expect.kind === "reject") {
        assert.equal(result.code, vector.expect.code)
      }
    })
  }
})

// --- Full corpus run ---

test("full corpus passes with zero failures", () => {
  const manifest = parseRunnerProtocolVectorManifest(loadJson("manifest.json"))
  const files: RunnerProtocolVectorFile[] = []
  for (const entry of manifest.files) {
    const raw = loadJson(entry.file)
    // Derive family from filename (strip .json)
    const family = entry.file.replace(".json", "")
    files.push(parseRunnerProtocolVectorFile(raw, family as never))
  }
  const result = runRunnerProtocolVectorCorpus(files)
  assert.equal(result.result, "PASS", `Failures: ${JSON.stringify(result.failed, null, 2)}`)
  assert.equal(result.total, 61)
  assert.equal(result.passed, 61)
  assert.equal(result.failed.length, 0)
})

// --- Determinism check ---

test("classifying same vector twice produces identical results", () => {
  const file = parseRunnerProtocolVectorFile(
    loadJson("canonical_bytes.json"),
    "canonical_bytes",
  )
  for (const vector of file.vectors) {
    const r1 = classifyRunnerProtocolVector(vector)
    const r2 = classifyRunnerProtocolVector(vector)
    assert.deepEqual(r1, r2, `non-deterministic result for ${vector.id}`)
  }
})
