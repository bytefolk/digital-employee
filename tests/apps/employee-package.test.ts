import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  createEmployeePackage,
  inspectEmployeePackage,
} from "../../apps/cli/employee-package.js"

test("init creates a host-neutral employee source package that validates statically", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "employee-init-"))
  const target = path.join(parent, "team-answer")
  const created = await createEmployeePackage(target, {
    author: "example-team",
  })
  const inspected = await inspectEmployeePackage(target)

  assert.equal(created.manifest.name, "team-answer")
  assert.equal(inspected.manifest.name, "team-answer")
  assert.equal(inspected.manifest.policy.mode, "read_only")
  assert.equal(inspected.files.includes("./SKILL.md"), true)
  const skill = await readFile(path.join(target, "SKILL.md"), "utf8")
  assert.match(skill, /^---\nname: team-answer\n/)
})

test("init never overwrites an existing target", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "employee-existing-"))
  const target = path.join(parent, "existing")
  await mkdir(target)
  await assert.rejects(
    () => createEmployeePackage(target),
    /init_target_already_exists/,
  )
})

test("init keeps the employee and Skill directory identity aligned", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "employee-name-"))
  await assert.rejects(
    () => createEmployeePackage(path.join(parent, "folder"), { name: "other" }),
    /employee_name_must_match_directory/,
  )
  await assert.rejects(
    () => createEmployeePackage(path.join(parent, "foo_bar")),
    /invalid_employee_name/,
  )
})

test("static validation rejects a mismatched Skill identity", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "employee-skill-"))
  const target = path.join(parent, "team-answer")
  await createEmployeePackage(target)
  const skillPath = path.join(target, "SKILL.md")
  const skill = await readFile(skillPath, "utf8")
  await writeFile(skillPath, skill.replace("name: team-answer", "name: other"))
  await assert.rejects(
    () => inspectEmployeePackage(target),
    /employee_skill_name_mismatch/,
  )
})

test("static validation refuses symlinked package artifacts", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "employee-link-"))
  const target = path.join(parent, "team-answer")
  await createEmployeePackage(target)
  const outside = path.join(parent, "outside.md")
  await writeFile(outside, "outside")
  const asset = path.join(target, "knowledge", "README.md")
  await writeFile(asset, "placeholder")
  await symlink(outside, path.join(target, "knowledge", "linked.md"))

  const manifestPath = path.join(target, "employee.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  manifest.assets.push("./knowledge/linked.md")
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  await assert.rejects(
    () => inspectEmployeePackage(target),
    /employee_package_symlink_not_allowed/,
  )
})
