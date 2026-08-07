import assert from "node:assert/strict"
import test from "node:test"

import {
  classifySchemaCompatibility,
  detectUnknownManifestFields,
  isDowngradeRequired,
  EMPLOYEE_PACKAGE_SCHEMA_VERSIONS,
  EMPLOYEE_PACKAGE_KNOWN_FIELDS,
  EMPLOYEE_PACKAGE_DIGEST_RULES,
} from "../../packages/core/index.js"

test("classifySchemaCompatibility — accepts current version", () => {
  const result = classifySchemaCompatibility("employee-package.v1alpha1")
  assert.equal(result.action, "accept")
  assert.equal(result.reason, "exact_match")
})

test("classifySchemaCompatibility — rejects missing version", () => {
  const result = classifySchemaCompatibility(undefined)
  assert.equal(result.action, "reject")
  assert.equal(result.reason, "schema_version_missing")
})

test("classifySchemaCompatibility — rejects empty string", () => {
  const result = classifySchemaCompatibility("")
  assert.equal(result.action, "reject")
  assert.equal(result.reason, "schema_version_missing")
})

test("classifySchemaCompatibility — rejects future version (no downgrade)", () => {
  const result = classifySchemaCompatibility("employee-package.v2")
  assert.equal(result.action, "reject")
  assert.equal(result.reason, "unknown_version_no_downgrade")
})

test("classifySchemaCompatibility — rejects unrecognised family", () => {
  const result = classifySchemaCompatibility("something-else.v1")
  assert.equal(result.action, "reject")
  assert.equal(result.reason, "unknown_version_unrecognised")
})

test("classifySchemaCompatibility — migrates from older known version", () => {
  const consumerVersions = [
    "employee-package.v1alpha1",
    "employee-package.v1",
  ]
  const result = classifySchemaCompatibility(
    "employee-package.v1alpha1",
    consumerVersions,
  )
  assert.equal(result.action, "migrate")
  assert.equal(result.reason, "known_older_version")
  assert.equal(result.sourceVersion, "employee-package.v1alpha1")
  assert.equal(result.targetVersion, "employee-package.v1")
})

test("detectUnknownManifestFields — valid with known fields", () => {
  const result = detectUnknownManifestFields({
    schemaVersion: "employee-package.v1alpha1",
    name: "test",
    version: "1.0.0",
    description: "test",
    license: "MIT",
    authors: [],
    host: {},
    entrypoints: {},
    policy: {},
    assets: [],
  })
  assert.equal(result.valid, true)
  assert.deepEqual(result.unknownFields, [])
})

test("detectUnknownManifestFields — detects unknown fields", () => {
  const result = detectUnknownManifestFields({
    schemaVersion: "employee-package.v1alpha1",
    name: "test",
    extra: "unknown",
    anotherExtra: 42,
  })
  assert.equal(result.valid, false)
  assert.ok(result.unknownFields.includes("extra"))
  assert.ok(result.unknownFields.includes("anotherExtra"))
})

test("detectUnknownManifestFields — rejects non-object", () => {
  assert.equal(detectUnknownManifestFields(null).valid, false)
  assert.equal(detectUnknownManifestFields("string").valid, false)
  assert.equal(detectUnknownManifestFields([]).valid, false)
})

test("isDowngradeRequired — true for newer versions", () => {
  assert.equal(isDowngradeRequired("employee-package.v2"), true)
})

test("isDowngradeRequired — false for current version", () => {
  assert.equal(isDowngradeRequired("employee-package.v1alpha1"), false)
})

test("isDowngradeRequired — false for unrecognised family", () => {
  assert.equal(isDowngradeRequired("other.v1"), false)
})

test("frozen constants — schema versions", () => {
  assert.ok(Object.isFrozen(EMPLOYEE_PACKAGE_SCHEMA_VERSIONS))
  assert.deepEqual([...EMPLOYEE_PACKAGE_SCHEMA_VERSIONS], [
    "employee-package.v1alpha1",
  ])
})

test("frozen constants — known fields registry", () => {
  assert.ok(EMPLOYEE_PACKAGE_KNOWN_FIELDS.manifest.includes("schemaVersion"))
  assert.ok(EMPLOYEE_PACKAGE_KNOWN_FIELDS.host.includes("protocol"))
  assert.ok(EMPLOYEE_PACKAGE_KNOWN_FIELDS.entrypoints.includes("skill"))
  assert.ok(EMPLOYEE_PACKAGE_KNOWN_FIELDS.policy.includes("mode"))
  assert.ok(
    EMPLOYEE_PACKAGE_KNOWN_FIELDS["policy.filesystem"].includes("read"),
  )
  assert.ok(
    EMPLOYEE_PACKAGE_KNOWN_FIELDS["policy.mcpTools[]"].includes("name"),
  )
})

test("frozen constants — digest rules", () => {
  assert.ok(Object.isFrozen(EMPLOYEE_PACKAGE_DIGEST_RULES))
  assert.equal(
    EMPLOYEE_PACKAGE_DIGEST_RULES.domain,
    "digital-employee.employee-package.v1",
  )
  assert.equal(EMPLOYEE_PACKAGE_DIGEST_RULES.algorithm, "sha256")
  assert.equal(EMPLOYEE_PACKAGE_DIGEST_RULES.maxEntries, 513)
  assert.equal(EMPLOYEE_PACKAGE_DIGEST_RULES.outputFormat, "sha256:<hex>")
})
