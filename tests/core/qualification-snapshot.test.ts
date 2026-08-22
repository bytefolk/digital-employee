import assert from "node:assert/strict"
import test from "node:test"

import {
  ADAPTER_QUALIFICATION_SCHEMA_ID,
  ADAPTER_QUALIFICATION_SNAPSHOT_SCHEMA_ID,
  QUALIFICATION_CREDENTIAL_SENTINEL,
  canonicalPolicyDigest,
  compareQualificationSnapshots,
  createQualificationSnapshot,
  qualificationFixtureCorpusDigest,
  qualificationKitCaseContract,
  validateAdapterQualificationSnapshot,
} from "../../packages/core/src/adapter-qualification.js"
import type {
  AdapterQualificationKitVersion,
  AdapterQualificationRecord,
  AdapterQualificationSnapshot,
} from "../../packages/core/src/adapter-qualification.js"

const GENERATED_AT = "2026-08-06T03:00:00Z"
const POLICY_DIGEST = canonicalPolicyDigest({
  tools: { default: "deny", allow: [{ name: "noop", mode: "read" }] },
  filesystem: { read: ["."], write: [] },
  network: { mode: "deny" },
  approval: { mode: "never" },
  maxTurns: 4,
})

function omitKey<T>(value: T, key: string): T {
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      ([entry]) => entry !== key,
    ),
  ) as T
}

/**
 * Synthesize a coherent record for one kit version: every corpus case passes
 * except the listed ids, and the summary/axes are derived exactly like the
 * kit derives them. The record validator re-derives everything, so an
 * incoherent synthesis fails the test instead of leaking into assertions.
 */
function syntheticRecord(
  kitVersion: AdapterQualificationKitVersion,
  options: {
    failedCaseIds?: readonly string[]
    liveEvidence?: { environment: string; evidenceDigest: string }
  } = {},
): AdapterQualificationRecord {
  const failed = new Set(options.failedCaseIds ?? [])
  const cases = qualificationKitCaseContract(kitVersion).map(
    ([domain, id]) => ({
      domain,
      id,
      passed: !failed.has(id),
      code: failed.has(id) ? `${id}_failed` : `${id}_ok`,
    }),
  )
  const domains: Record<string, { passed: number; failed: number }> = {}
  for (const entry of cases) {
    domains[entry.domain] ??= { passed: 0, failed: 0 }
    if (entry.passed) domains[entry.domain].passed += 1
    else domains[entry.domain].failed += 1
  }
  const implemented = cases.find((entry) => entry.id === "probe_contract")
    ?.passed === true
  const fixtureConformant =
    implemented && cases.every((entry) => entry.passed)
  return {
    schema: ADAPTER_QUALIFICATION_SCHEMA_ID,
    hostId: "reference-stdio-host",
    hostVersion: "1.0.0",
    policyDigest: POLICY_DIGEST,
    kitVersion,
    generatedAt: GENERATED_AT,
    axes: {
      implemented,
      fixtureConformant,
      liveQualified: options.liveEvidence !== undefined,
    },
    domains: domains as AdapterQualificationRecord["domains"],
    cases,
    ...(options.liveEvidence ? { liveEvidence: options.liveEvidence } : {}),
  }
}

function snapshotFor(
  kitVersion: AdapterQualificationKitVersion,
  options: {
    release?: string
    failedCaseIds?: readonly string[]
    liveEvidence?: { environment: string; evidenceDigest: string }
  } = {},
): AdapterQualificationSnapshot {
  return createQualificationSnapshot(syntheticRecord(kitVersion, options), {
    release: options.release ?? "0.4.0",
  })
}

function snapshotError(value: unknown, fragment: string): void {
  assert.throws(
    () => validateAdapterQualificationSnapshot(value),
    (error: unknown) =>
      error instanceof Error &&
      (error as { code?: unknown }).code === "INVALID_QUALIFICATION_SNAPSHOT" &&
      error.message.includes(fragment),
    fragment,
  )
}

test("a capability claim earns a snapshot through the standardized path", () => {
  const snapshot = snapshotFor("1.3.0")
  assert.equal(snapshot.schema, ADAPTER_QUALIFICATION_SNAPSHOT_SCHEMA_ID)
  assert.equal(snapshot.hostId, "reference-stdio-host")
  assert.equal(snapshot.hostVersion, "1.0.0")
  assert.equal(snapshot.kitVersion, "1.3.0")
  assert.equal(
    snapshot.fixtureCorpusDigest,
    qualificationFixtureCorpusDigest("1.3.0"),
  )
  assert.deepEqual(snapshot.axes, {
    implemented: true,
    fixtureConformant: true,
    liveQualified: false,
  })
  assert.equal(snapshot.domains.length, 10)
  assert.deepEqual(
    snapshot.domains.find((row) => row.domain === "readonly_projection"),
    { domain: "readonly_projection", status: "supported", passed: 2, failed: 0 },
  )
  assert.deepEqual(
    validateAdapterQualificationSnapshot(structuredClone(snapshot)),
    snapshot,
  )
})

test("snapshot derivation re-derives axes and status from the record", () => {
  const snapshot = snapshotFor("1.3.0", { failedCaseIds: ["valid_json"] })
  assert.deepEqual(
    snapshot.domains.find((row) => row.domain === "output_schema"),
    { domain: "output_schema", status: "unsupported", passed: 5, failed: 1 },
  )
  assert.deepEqual(snapshot.axes, {
    implemented: true,
    fixtureConformant: false,
    liveQualified: false,
  })
})

test("snapshot derivation rejects an invalid record or release", () => {
  const record = syntheticRecord("1.3.0")
  assert.throws(() =>
    createQualificationSnapshot(
      { ...record, axes: { ...record.axes, fixtureConformant: false } },
      { release: "0.5.0" },
    ),
  )
  assert.throws(() =>
    createQualificationSnapshot(record, { release: "0.5" }),
  )
  assert.throws(() =>
    createQualificationSnapshot(record, { release: "0.5.0-beta.1" }),
  )
})

test("the evidence standard rejects incomplete claims (AC-001)", () => {
  const base = snapshotFor("1.3.0")
  snapshotError(null, "must be an object")
  snapshotError([], "must be an object")
  snapshotError(
    { ...base, schema: "adapter-qualification-snapshot.v0" },
    "schema must be",
  )
  snapshotError({ ...base, unexpected: true }, "unknown qualification snapshot field")
  snapshotError(omitKey(base, "release"), "stable x.y.z version")
  snapshotError({ ...base, release: "0.4" }, "stable x.y.z version")
  snapshotError(omitKey(base, "hostId"), "hostId")
  snapshotError({ ...base, hostId: "Reference_Host" }, "hostId")
  snapshotError(omitKey(base, "hostVersion"), "exact Host version")
  snapshotError({ ...base, hostVersion: "" }, "exact Host version")
  snapshotError(
    omitKey(base, "kitVersion"),
    "deterministic fixture (kit) version",
  )
  snapshotError(
    { ...base, kitVersion: "2.0.0" },
    "deterministic fixture (kit) version",
  )
  snapshotError(
    omitKey(base, "fixtureCorpusDigest"),
    "fixture-corpus sha256 digest",
  )
  snapshotError(
    { ...base, fixtureCorpusDigest: "not-a-digest" },
    "fixture-corpus sha256 digest",
  )
  snapshotError(
    { ...base, fixtureCorpusDigest: qualificationFixtureCorpusDigest("1.2.0") },
    "does not match the kit 1.3.0 corpus contract",
  )
  snapshotError(omitKey(base, "generatedAt"), "ISO-8601")
  snapshotError(omitKey(base, "axes"), "boundary axes")
  snapshotError(
    { ...base, axes: omitKey(base.axes, "liveQualified") },
    "boundary axes",
  )
  snapshotError(omitKey(base, "domains"), "non-empty array")
  snapshotError(
    { ...base, domains: [...base.domains, base.domains[0]] },
    "duplicate qualification domain row",
  )
  snapshotError(
    { ...base, domains: base.domains.slice(1) },
    "missing qualification domain row",
  )
  snapshotError(
    {
      ...base,
      domains: base.domains.map((row) =>
        row.domain === "output_schema"
          ? { ...row, passed: row.passed - 1, failed: row.failed + 1 }
          : row,
      ),
    },
    "status does not match its passed/failed counts",
  )
  snapshotError(
    {
      ...base,
      domains: base.domains.map((row) =>
        row.domain === "output_schema"
          ? { domain: row.domain, status: "unsupported", passed: 5, failed: 2 }
          : row,
      ),
    },
    "must account for every case in the kit 1.3.0 corpus",
  )
})

test("a pre-1.3.0 claim carrying readonly_projection fails closed", () => {
  const prior = snapshotFor("1.2.0")
  snapshotError(
    {
      ...prior,
      domains: [
        ...prior.domains,
        {
          domain: "readonly_projection",
          status: "supported",
          passed: 2,
          failed: 0,
        },
      ],
    },
    "unknown qualification domain for kit 1.2.0",
  )
})

test("incoherent evidence axes are rejected", () => {
  const weakened = snapshotFor("1.3.0", { failedCaseIds: ["valid_json"] })
  snapshotError(
    { ...weakened, axes: { ...weakened.axes, fixtureConformant: true } },
    "evidence axes do not match the derived domain state",
  )
  snapshotError(
    { ...weakened, axes: { ...weakened.axes, implemented: false } },
    "evidence axes do not match the derived domain state",
  )
})

test("the credential sentinel fails snapshot validation closed", () => {
  const base = snapshotFor("1.3.0")
  assert.throws(
    () =>
      validateAdapterQualificationSnapshot({
        ...base,
        hostVersion: QUALIFICATION_CREDENTIAL_SENTINEL,
      }),
    (error: unknown) =>
      error instanceof Error &&
      (error as { code?: unknown }).code ===
        "QUALIFICATION_EVIDENCE_SECRET_DETECTED",
  )
})

test("the regression harness passes when evidence only strengthens", () => {
  const baseline = snapshotFor("1.1.0", { release: "0.4.0" })
  const current = snapshotFor("1.3.0", { release: "0.5.0" })
  assert.deepEqual(compareQualificationSnapshots(baseline, current), [])
  assert.deepEqual(compareQualificationSnapshots(current, current), [])
  // A newer release may additionally earn the live axis without weakening.
  const live = snapshotFor("1.3.0", {
    release: "0.5.0",
    liveEvidence: { environment: "ci", evidenceDigest: "a".repeat(64) },
  })
  assert.deepEqual(compareQualificationSnapshots(baseline, live), [])
})

test("the regression harness fails closed when earned evidence weakens", () => {
  const baseline = snapshotFor("1.3.0", { release: "0.4.0" })
  const weakened = snapshotFor("1.3.0", {
    release: "0.5.0",
    failedCaseIds: ["valid_json"],
  })
  assert.deepEqual(compareQualificationSnapshots(baseline, weakened), [
    "evidence_axis_weakened:fixtureConformant",
    "capability_row_weakened:output_schema:supported->unsupported",
    "evidence_count_shrunk:output_schema:6->5",
    "failure_count_grew:output_schema:0->1",
  ])
})

test("the regression harness fails closed when evidence disappears", () => {
  const baseline = snapshotFor("1.3.0", { release: "0.4.0" })
  const prior = snapshotFor("1.2.0", { release: "0.5.0" })
  assert.deepEqual(compareQualificationSnapshots(baseline, prior), [
    "kit_version_regressed:1.3.0->1.2.0",
    "capability_row_disappeared:readonly_projection",
  ])
})

test("the regression harness pins the exact host identity and version", () => {
  const baseline = snapshotFor("1.1.0")
  const drifted = {
    ...snapshotFor("1.3.0"),
    hostVersion: "1.0.1",
  }
  assert.deepEqual(compareQualificationSnapshots(baseline, drifted), [
    "host_version_drifted:1.0.0->1.0.1",
  ])
  const renamed = {
    ...snapshotFor("1.3.0"),
    hostId: "other-host",
  }
  assert.deepEqual(compareQualificationSnapshots(baseline, renamed), [
    "host_identity_changed:reference-stdio-host->other-host",
  ])
})

test("the regression harness fails closed on a weakened live axis", () => {
  const baseline = snapshotFor("1.3.0", {
    liveEvidence: { environment: "ci", evidenceDigest: "a".repeat(64) },
  })
  assert.equal(baseline.axes.liveQualified, true)
  assert.deepEqual(
    compareQualificationSnapshots(baseline, snapshotFor("1.3.0")),
    ["evidence_axis_weakened:liveQualified"],
  )
})

test("the regression harness fails closed on malformed input", () => {
  const baseline = snapshotFor("1.1.0")
  assert.throws(() => compareQualificationSnapshots({}, baseline))
  assert.throws(() =>
    compareQualificationSnapshots(baseline, {
      ...snapshotFor("1.3.0"),
      fixtureCorpusDigest: "0".repeat(64),
    }),
  )
})
