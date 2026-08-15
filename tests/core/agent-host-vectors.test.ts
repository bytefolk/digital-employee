import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  AGENT_HOST_CAPABILITIES,
  AGENT_HOST_PROTOCOL_VERSION,
  createUnknownAgentHostCapabilities,
} from "../../packages/core/src/agent-host.js"
import { validateAgentHostProbeResult } from "../../packages/core/src/agent-host-registry.js"
import {
  AGENT_HOST_VECTOR_FAMILIES,
  AGENT_HOST_VECTOR_SCHEMA_VERSION,
  computeCorpusDigest,
  parseAgentHostVectorFile,
  parseAgentHostVectorManifest,
  runAgentHostVectorCorpus,
} from "../../packages/core/src/agent-host-vectors.js"
import {
  AGENT_HOST_VECTOR_CODES,
  validateAgentHostProbeWire,
} from "../../packages/core/src/agent-host-wire.js"
import { CoreError } from "../../packages/core/src/contracts.js"

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/agent-host-vectors",
)

const CORPUS_REVISIONS = ["v1", "v2"] as const
type CorpusRevision = (typeof CORPUS_REVISIONS)[number]

const FROZEN_V1_CORPUS_DIGEST =
  "2ac92b971c5131b9b3076d0052809592fc9f3d05716c2dfceb8dd27fe745ecf0"
const FROZEN_V1_MANIFEST_SHA256 =
  "46ef7079fa11bd0a388107c675ee80adfae6f3c94cfd72e7075105e57ac1adbc"
const ISSUE_46_CORPUS_DIGEST =
  "74c13ac0d3036e11dae0e248e9950a9799e7181dfe0582167e44c7aa869a6864"

function corpusRoot(revision: CorpusRevision): string {
  return path.join(fixtureRoot, revision)
}

function readJson(revision: CorpusRevision, name: string): unknown {
  return JSON.parse(
    readFileSync(path.join(corpusRoot(revision), name), "utf8"),
  )
}

function loadCorpus(revision: CorpusRevision) {
  const manifest = parseAgentHostVectorManifest(
    readJson(revision, "manifest.json"),
  )
  const files = manifest.files.map((entry) => {
    const raw = readJson(revision, entry.file) as { family: unknown }
    assert.ok(
      AGENT_HOST_VECTOR_FAMILIES.includes(
        raw.family as (typeof AGENT_HOST_VECTOR_FAMILIES)[number],
      ),
      `unknown family in ${revision}/${entry.file}`,
    )
    const family = raw.family as (typeof AGENT_HOST_VECTOR_FAMILIES)[number]
    const file = parseAgentHostVectorFile(raw, family)
    assert.equal(
      file.vectors.length,
      entry.vectorCount,
      `${revision}/${entry.file}`,
    )
    return file
  })
  return { manifest, files, result: runAgentHostVectorCorpus(files) }
}

function readyProbe() {
  return {
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    hostId: "fixture",
    displayName: "Fixture Host",
    status: "ready",
    available: true,
    adapterStatus: "runnable",
    capabilities: createUnknownAgentHostCapabilities(),
    capabilitySource: "conformance_test",
    issues: [],
  }
}

function rejectsCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof CoreError && error.code === code
}

test("frozen v1 corpus remains byte-pinned and behaviorally unchanged", () => {
  const { manifest, result } = loadCorpus("v1")
  const manifestDigest = createHash("sha256")
    .update(readFileSync(path.join(corpusRoot("v1"), "manifest.json")))
    .digest("hex")
  assert.equal(manifestDigest, FROZEN_V1_MANIFEST_SHA256)
  assert.equal(manifest.corpusDigest, FROZEN_V1_CORPUS_DIGEST)
  assert.equal(result.total, 44)
  assert.deepEqual(
    Object.keys(readJson("v1", "manifest.json") as object).sort(),
    ["corpusDigest", "families", "files", "protocolVersion", "schemaVersion"],
  )
})

for (const revision of CORPUS_REVISIONS) {
  test(`${revision} manifest pins every family and shipped file`, () => {
    const { manifest, files } = loadCorpus(revision)
    assert.equal(manifest.schemaVersion, AGENT_HOST_VECTOR_SCHEMA_VERSION)
    assert.equal(manifest.protocolVersion, AGENT_HOST_PROTOCOL_VERSION)
    assert.deepEqual([...manifest.families], [...AGENT_HOST_VECTOR_FAMILIES])
    assert.equal(manifest.files.length, AGENT_HOST_VECTOR_FAMILIES.length)

    for (const entry of manifest.files) {
      const raw = readFileSync(path.join(corpusRoot(revision), entry.file))
      const digest = createHash("sha256").update(raw).digest("hex")
      assert.equal(
        digest,
        entry.sha256,
        `digest mismatch for ${revision}/${entry.file}`,
      )
    }

    const ids = files.flatMap((file) => file.vectors.map((vector) => vector.id))
    assert.equal(new Set(ids).size, ids.length, `${revision} vector IDs must be global`)
  })

  test(`${revision} golden vector corpus classifies to PASS`, () => {
    const { result } = loadCorpus(revision)
    assert.deepEqual(result.failed, [], JSON.stringify(result.failed, null, 2))
    assert.equal(result.result, "PASS")
    assert.equal(result.total, result.passed)
    assert.equal(result.protocolVersion, AGENT_HOST_PROTOCOL_VERSION)
  })
}

test("corpus rejects malformed files fail-closed", () => {
  assert.throws(() => parseAgentHostVectorFile({}, "probe"))
  assert.throws(() =>
    parseAgentHostVectorFile(
      {
        schemaVersion: AGENT_HOST_VECTOR_SCHEMA_VERSION,
        family: "probe",
        vectors: [
          {
            id: "a",
            family: "probe",
            input: {},
            expect: { kind: "accept" },
          },
          {
            id: "a",
            family: "probe",
            input: {},
            expect: { kind: "accept" },
          },
        ],
      },
      "probe",
    ),
  )
  assert.throws(() => parseAgentHostVectorManifest({}))
  const manifest = readJson("v2", "manifest.json") as Record<string, unknown>
  assert.throws(() =>
    parseAgentHostVectorManifest({ ...manifest, corpusDigest: "0".repeat(64) }),
  )
  assert.equal(
    computeCorpusDigest([
      { file: "b.json", sha256: "b".repeat(64) },
      { file: "a.json", sha256: "a".repeat(64) },
    ]),
    computeCorpusDigest([
      { file: "a.json", sha256: "a".repeat(64) },
      { file: "b.json", sha256: "b".repeat(64) },
    ]),
  )
})

test("Issue #46 integrated ledger closes all five observations in v2", () => {
  const v1 = loadCorpus("v1")
  const v2 = loadCorpus("v2")
  assert.equal(v2.manifest.corpusDigest, ISSUE_46_CORPUS_DIGEST)
  assert.equal(v2.result.result, "PASS")
  assert.equal(v2.result.total, 50)

  const newVectorIds = new Set([
    "probe-reject-unknown-capability-key",
    "migration-reject-not-ready",
    "migration-reject-adapter-declaration",
    "migration-reject-probe-only",
    "migration-reject-unavailable",
    "terminal-reject-completed-and-failed",
  ])
  const v1Ids = new Set(
    v1.files.flatMap((file) => file.vectors.map((vector) => vector.id)),
  )
  const v2Vectors = v2.files.flatMap((file) => file.vectors)
  const v2Ids = new Set(v2Vectors.map((vector) => vector.id))
  for (const id of newVectorIds) {
    assert.equal(v1Ids.has(id), false, `${id} must not mutate frozen v1`)
    assert.equal(v2Ids.has(id), true, `${id} missing from v2`)
    assert.equal(
      v2Vectors.find((vector) => vector.id === id)?.expect.kind,
      "reject",
    )
  }

  const valid = readyProbe()
  assert.deepEqual(Object.keys(valid.capabilities), [...AGENT_HOST_CAPABILITIES])
  const unknownCapability = {
    ...valid,
    capabilities: { ...valid.capabilities, vendor_extension: "supported" },
  }
  assert.throws(
    () => validateAgentHostProbeWire(unknownCapability, "fixture"),
    rejectsCode(AGENT_HOST_VECTOR_CODES.probeInvalid),
  )
  assert.throws(
    () => validateAgentHostProbeResult(unknownCapability, "fixture"),
    rejectsCode("AGENT_HOST_PROBE_INVALID"),
  )
  assert.throws(
    () => validateAgentHostProbeResult({ ...valid, vendorExtension: true }, "fixture"),
    rejectsCode("AGENT_HOST_PROBE_INVALID"),
  )
  assert.throws(
    () =>
      validateAgentHostProbeResult(
        {
          ...valid,
          issues: [
            { code: "x", message: "blocked", blocking: true, severity: "high" },
          ],
        },
        "fixture",
      ),
    rejectsCode("AGENT_HOST_PROBE_INVALID"),
  )
})
