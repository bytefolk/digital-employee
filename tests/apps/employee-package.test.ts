import assert from "node:assert/strict"
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  createEmployeePackage,
  DEFAULT_EMPLOYEE_RECIPE,
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
  assert.equal(created.recipe, DEFAULT_EMPLOYEE_RECIPE)
  assert.equal(inspected.manifest.name, "team-answer")
  assert.equal(inspected.manifest.policy.mode, "read_only")
  assert.deepEqual(inspected.manifest.host.requiredCapabilities, [])
  assert.equal(inspected.files.includes("./SKILL.md"), true)
  const cases = JSON.parse(
    await readFile(path.join(target, "evals", "cases.json"), "utf8"),
  )
  assert.equal(cases.cases.length > 0, true)
  const skill = await readFile(path.join(target, "SKILL.md"), "utf8")
  assert.match(skill, /^---\nname: team-answer\n/)
})

test("init never overwrites an existing target", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "employee-existing-"))
  const target = path.join(parent, "existing")
  await mkdir(target)
  const sentinel = path.join(target, "keep.txt")
  await writeFile(sentinel, "must remain unchanged")
  await assert.rejects(
    () => createEmployeePackage(target),
    (error: unknown) =>
      error instanceof TypeError &&
      error.message === "init_target_already_exists",
  )
  assert.equal(await readFile(sentinel, "utf8"), "must remain unchanged")
  assert.deepEqual(await readdir(target), ["keep.txt"])
  assert.equal(
    (await readdir(parent)).some((entry) =>
      entry.startsWith(".digital-employee-existing-"),
    ),
    false,
  )
})

test("publish atomically refuses an empty target injected after staging", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "employee-publish-race-"))
  const target = path.join(parent, "race-answer")
  await assert.rejects(
    () =>
      createEmployeePackage(
        target,
        {},
        {
          beforePublish: () => mkdir(target),
        },
      ),
    (error: unknown) =>
      error instanceof TypeError &&
      error.message === "init_target_already_exists",
  )
  assert.deepEqual(await readdir(target), [])
  assert.equal(
    (await readdir(parent)).some((entry) =>
      entry.startsWith(".digital-employee-race-answer-"),
    ),
    false,
  )
})

test("a failed owned claim removes its target and staging directory", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "employee-claim-failure-"))
  const target = path.join(parent, "claim-failure")
  await assert.rejects(
    () =>
      createEmployeePackage(
        target,
        {},
        {
          afterClaim() {
            throw new Error("injected_publish_failure")
          },
        },
      ),
    (error: unknown) =>
      error instanceof TypeError && error.message === "init_publish_incomplete",
  )
  await assert.rejects(() => lstat(target), /ENOENT/)
  assert.equal(
    (await readdir(parent)).some((entry) =>
      entry.startsWith(".digital-employee-claim-failure-"),
    ),
    false,
  )
})

test("failed claim cleanup preserves content from a competing writer", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "employee-claim-mixed-"))
  const target = path.join(parent, "claim-mixed")
  const competitor = path.join(target, "competitor.txt")
  await assert.rejects(
    () =>
      createEmployeePackage(
        target,
        {},
        {
          async afterClaim() {
            await writeFile(competitor, "competitor data")
            throw new Error("injected_mixed_publish_failure")
          },
        },
      ),
    (error: unknown) =>
      error instanceof TypeError && error.message === "init_publish_incomplete",
  )
  assert.equal(await readFile(competitor, "utf8"), "competitor data")
  assert.deepEqual(await readdir(target), ["competitor.txt"])
  assert.equal(
    (await readdir(parent)).some((entry) =>
      entry.startsWith(".digital-employee-claim-mixed-"),
    ),
    false,
  )
})

test("concurrent init has one complete winner and cleans every staging directory", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "employee-concurrent-"))
  const target = path.join(parent, "concurrent-answer")
  let staged = 0
  let release!: () => void
  const bothStaged = new Promise<void>((resolve) => {
    release = resolve
  })
  const hooks = {
    async beforePublish() {
      staged += 1
      if (staged === 2) release()
      await bothStaged
    },
  }
  const results = await Promise.allSettled([
    createEmployeePackage(target, { author: "publisher-one" }, hooks),
    createEmployeePackage(target, { author: "publisher-two" }, hooks),
  ])
  const fulfilled = results.filter((result) => result.status === "fulfilled")
  const rejected = results.filter((result) => result.status === "rejected")
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.equal(
    rejected[0]?.status === "rejected" && rejected[0].reason instanceof TypeError
      ? rejected[0].reason.message
      : "unexpected_rejection",
    "init_target_already_exists",
  )
  const inspected = await inspectEmployeePackage(target)
  assert.equal(inspected.manifest.name, "concurrent-answer")
  assert.equal(inspected.files.length, 5)
  assert.equal(
    (await readdir(target)).some((entry) =>
      entry.startsWith(".digital-employee-init-claim-"),
    ),
    false,
  )
  assert.equal(
    (await readdir(parent)).some((entry) =>
      entry.startsWith(".digital-employee-concurrent-answer-"),
    ),
    false,
  )
})

test("init rejects unknown recipe names and versions without creating a target", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "employee-recipe-"))
  for (const recipe of ["minimal-answer", "minimal-answer.v2", "../minimal-answer.v1"]) {
    const target = path.join(parent, `target-${recipe.replaceAll(/[^a-z0-9]/g, "-")}`)
    await assert.rejects(
      () => createEmployeePackage(target, { recipe }),
      (error: unknown) =>
        error instanceof TypeError &&
        error.message === `unknown_employee_recipe:${recipe}`,
    )
    await assert.rejects(() => lstat(target), /ENOENT/)
  }
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

test("static validation rejects asynchronous input and output Schemas", async () => {
  for (const schemaName of ["input.schema.json", "output.schema.json"]) {
    const parent = await mkdtemp(path.join(os.tmpdir(), "employee-async-schema-"))
    const target = path.join(parent, `team-${schemaName.split(".")[0]}`)
    await createEmployeePackage(target)
    await writeFile(
      path.join(target, "schemas", schemaName),
      `${JSON.stringify({ $async: true, type: "object" })}\n`,
    )

    await assert.rejects(
      () => inspectEmployeePackage(target),
      (error: unknown) =>
        error instanceof TypeError &&
        error.message ===
          `employee_package_invalid_json_schema:./schemas/${schemaName}`,
    )
  }
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
