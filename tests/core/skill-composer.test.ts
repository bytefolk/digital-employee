import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import type { EmployeePackageSkillRef } from "../../packages/core/src/employee-package.js"
import {
  composeSkillUnits,
  resolveSkillPromptSurface,
} from "../../packages/core/src/skill-composer.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

function unit(
  overrides: Partial<EmployeePackageSkillRef> = {},
): EmployeePackageSkillRef {
  return {
    name: "lookup",
    version: "1.0.0",
    digest: `sha256:${"ab".repeat(32)}`,
    ...overrides,
  }
}

test("#306 AC-001: composition digest is stable across input order", () => {
  const a = unit({ name: "alpha", version: "1.0.0" })
  const b = unit({
    name: "beta",
    version: "2.0.0",
    digest: `sha256:${"cd".repeat(32)}`,
  })
  const forward = composeSkillUnits([a, b])
  const reverse = composeSkillUnits([b, a])
  assert.equal(forward.digest, reverse.digest)
  assert.deepEqual(
    forward.blocks,
    reverse.blocks,
  )
  assert.match(forward.digest, /^sha256:[a-f0-9]{64}$/)
  assert.equal(forward.blocks[0], `alpha@1.0.0\n${a.digest}`)
})

test("#306 AC-001: duplicate name fails closed", () => {
  assert.throws(
    () => composeSkillUnits([unit(), unit({ version: "1.0.1" })]),
    /skill_composer_duplicate_name/,
  )
})

test("#306 AC-002: declaration-free packages keep legacy prose bytes", () => {
  const legacy = "# current entrypoints.skill prose\n"
  assert.equal(resolveSkillPromptSurface(undefined, legacy), legacy)
  assert.equal(resolveSkillPromptSurface([], legacy), legacy)
})

test("#306 AC-003: composer module has no filesystem, clock, or network imports", async () => {
  const source = await readFile(
    path.join(root, "packages/core/src/skill-composer.ts"),
    "utf8",
  )
  assert.doesNotMatch(source, /node:fs|node:net|node:http|node:child_process|Date\.now|new Date/)
})
