import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"

import {
  EMPLOYEE_PACKAGE_VECTOR_FAMILIES,
  EMPLOYEE_PACKAGE_VECTOR_SCHEMA_VERSION,
  parseEmployeePackageVectorFile,
  parseEmployeePackageVectorManifest,
  runEmployeePackageVectorCorpus,
} from "../../packages/core/index.js"
import type {
  EmployeePackageVectorFamily,
  EmployeePackageVectorFile,
} from "../../packages/core/index.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = resolve(
  __dirname,
  "../../fixtures/employee-package-vectors/v1",
)

function readFixture(filename: string): Buffer {
  return readFileSync(resolve(FIXTURES_DIR, filename))
}

test("manifest declares all families", () => {
  const manifest = parseEmployeePackageVectorManifest(
    JSON.parse(readFixture("manifest.json").toString()),
  )
  assert.deepEqual([...manifest.families], [...EMPLOYEE_PACKAGE_VECTOR_FAMILIES])
})

test("manifest has one file entry per family", () => {
  const manifest = parseEmployeePackageVectorManifest(
    JSON.parse(readFixture("manifest.json").toString()),
  )
  assert.equal(manifest.files.length, EMPLOYEE_PACKAGE_VECTOR_FAMILIES.length)
})

const manifestData = JSON.parse(readFixture("manifest.json").toString())
for (const entry of manifestData.files as Array<{
  file: string
  sha256: string
  vectorCount: number
}>) {
  test(`${entry.file} SHA-256 matches manifest`, () => {
    const content = readFixture(entry.file)
    const hash = createHash("sha256").update(content).digest("hex")
    assert.equal(hash, entry.sha256)
  })

  test(`${entry.file} vector count matches manifest`, () => {
    const data = JSON.parse(readFixture(entry.file).toString())
    assert.equal(data.vectors.length, entry.vectorCount)
  })
}

test("corpus runner — all vectors pass", () => {
  const files: EmployeePackageVectorFile[] = []
  for (const family of EMPLOYEE_PACKAGE_VECTOR_FAMILIES) {
    const filename = `${family}.json`
    const data = JSON.parse(readFixture(filename).toString())
    files.push(
      parseEmployeePackageVectorFile(
        data,
        family as EmployeePackageVectorFamily,
      ),
    )
  }
  const result = runEmployeePackageVectorCorpus(files)
  if (result.failed.length > 0) {
    const details = result.failed
      .map(
        (f) =>
          `  ${f.id}: expected ${f.expected.kind}${f.expected.code ? `:${f.expected.code}` : ""}, got ${f.actual.kind}${f.actual.code ? `:${f.actual.code}` : ""}`,
      )
      .join("\n")
    assert.fail(
      `${result.failed.length}/${result.total} vectors failed:\n${details}`,
    )
  }
  assert.equal(result.result, "PASS")
  assert.equal(result.total, 34)
  assert.equal(result.passed, 34)
})

test("corpus runner — result schema is correct", () => {
  const files: EmployeePackageVectorFile[] = []
  for (const family of EMPLOYEE_PACKAGE_VECTOR_FAMILIES) {
    const filename = `${family}.json`
    const data = JSON.parse(readFixture(filename).toString())
    files.push(
      parseEmployeePackageVectorFile(
        data,
        family as EmployeePackageVectorFamily,
      ),
    )
  }
  const result = runEmployeePackageVectorCorpus(files)
  assert.equal(result.schemaVersion, "employee-package-vectors-result.v1")
  assert.equal(result.corpusVersion, EMPLOYEE_PACKAGE_VECTOR_SCHEMA_VERSION)
  assert.equal(result.packageSchemaVersion, "employee-package.v1alpha1")
})
