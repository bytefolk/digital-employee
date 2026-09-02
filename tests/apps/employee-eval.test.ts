import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { evaluateEmployeePackage } from "../../apps/cli/employee-eval.js"
import {
  createEmployeePackage,
  inspectEmployeePackage,
} from "../../apps/cli/employee-package.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const cli = path.join(root, "apps", "cli", "bin.ts")

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
    cwd: root,
    encoding: "utf8",
    // Node >=24 emits a DEP0205 module.register() deprecation warning from the
    // tsx loader on the child's stderr; keep black-box stderr assertions stable
    // across Node versions without changing app behavior.
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  })
}

async function createMinimalPackage(name: string) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "employee-eval-"))
  const directory = path.join(parent, name)
  await createEmployeePackage(directory, { recipe: "minimal-answer.v1" })
  return directory
}

async function replaceCases(directory: string, cases: unknown[]) {
  await writeFile(
    path.join(directory, "evals", "cases.json"),
    `${JSON.stringify({ schemaVersion: "employee-evals.v1alpha1", cases }, null, 2)}\n`,
  )
}

async function writeEvalContract(directory: string, content: string) {
  await writeFile(path.join(directory, "evals", "cases.json"), content)
}

async function removeEvalAssetDeclaration(directory: string) {
  const manifestPath = path.join(directory, "employee.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  manifest.assets = manifest.assets.filter(
    (asset: unknown) => asset !== "./evals/cases.json",
  )
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

test("minimal recipe completes init, static inspection, and offline contract eval", async () => {
  const directory = await createMinimalPackage("support-answer")
  const inspection = await inspectEmployeePackage(directory)
  const result = await evaluateEmployeePackage(directory)

  assert.equal(inspection.manifest.name, "support-answer")
  assert.deepEqual(result, {
    schemaVersion: "employee-eval-result.v1alpha1",
    status: "passed",
    code: "EVAL_PASSED",
    employee: {
      name: "support-answer",
      version: "0.1.0",
      schemaVersion: "employee-package.v1alpha1",
    },
    summary: { total: 1, passed: 1, failed: 0 },
    cases: [
      {
        id: "approved-support-channel",
        status: "passed",
        code: "EVAL_CASE_PASSED",
      },
    ],
  })
})

test("contract eval reports real input and expected-output Schema failures", async () => {
  const directory = await createMinimalPackage("schema-failures")
  await replaceCases(directory, [
    {
      id: "invalid-input",
      input: { message: "" },
      expectedOutput: {
        status: "answered",
        answer: "unused",
        citations: [],
      },
    },
    {
      id: "invalid-output",
      input: { message: "valid" },
      expectedOutput: { status: "answered", answer: "missing citations" },
    },
  ])

  const result = await evaluateEmployeePackage(directory)
  assert.equal(result.status, "failed")
  assert.equal(result.code, "EVAL_CASE_INPUT_SCHEMA_INVALID")
  assert.deepEqual(result.summary, { total: 2, passed: 0, failed: 2 })
  assert.deepEqual(
    result.cases.map(({ id, code }) => ({ id, code })),
    [
      { id: "invalid-input", code: "EVAL_CASE_INPUT_SCHEMA_INVALID" },
      {
        id: "invalid-output",
        code: "EVAL_CASE_EXPECTED_OUTPUT_SCHEMA_INVALID",
      },
    ],
  )
})

test("CLI JSON failures are stable, path-free, parseable, and exit one", async () => {
  const directory = await createMinimalPackage("cli-invalid-input")
  await replaceCases(directory, [
    {
      id: "invalid-input",
      input: {},
      expectedOutput: {
        status: "answered",
        answer: "unused",
        citations: [],
      },
    },
  ])

  const result = runCli(["eval", directory, "--json"])
  assert.equal(result.status, 1, result.stderr)
  assert.equal(result.stderr, "")
  const output = JSON.parse(result.stdout)
  assert.equal(output.code, "EVAL_CASE_INPUT_SCHEMA_INVALID")
  assert.equal(output.cases[0].code, "EVAL_CASE_INPUT_SCHEMA_INVALID")
  assert.doesNotMatch(result.stdout, new RegExp(directory))
})

test("human eval output uses only contract fixture terminology", async () => {
  const directory = await createMinimalPackage("cli-contract-terms")
  const result = runCli(["eval", directory])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Contract eval \(offline fixture conformance\): passed/)
  assert.doesNotMatch(result.stdout, /behavior|quality|model|provider/i)
})

test("contract violations fail closed with one stable machine code", async (t) => {
  const validCase = {
    id: "valid-case",
    input: { message: "valid" },
    expectedOutput: {
      status: "answered",
      answer: "valid",
      citations: [],
    },
  }
  const validCaseJson = JSON.stringify(validCase)
  const tooManyCases = Array.from({ length: 513 }, (_, index) => ({
    ...validCase,
    id: `case-${index}`,
  }))
  const variants: Array<{ name: string; content: string }> = [
    {
      name: "invalid JSON",
      content: "{",
    },
    {
      name: "wrong schema version",
      content: JSON.stringify({ schemaVersion: "employee-evals.v2", cases: [validCase] }),
    },
    {
      name: "top-level unknown key",
      content: JSON.stringify({
        schemaVersion: "employee-evals.v1alpha1",
        cases: [validCase],
        unknown: true,
      }),
    },
    {
      name: "top-level missing key",
      content: JSON.stringify({ cases: [validCase] }),
    },
    {
      name: "top-level duplicate key",
      content:
        `{"schemaVersion":"employee-evals.v1alpha1",` +
        `"schemaVersion":"employee-evals.v1alpha1","cases":[${validCaseJson}]}`,
    },
    {
      name: "case unknown key",
      content: JSON.stringify({
        schemaVersion: "employee-evals.v1alpha1",
        cases: [{ ...validCase, unknown: true }],
      }),
    },
    {
      name: "case missing key",
      content: JSON.stringify({
        schemaVersion: "employee-evals.v1alpha1",
        cases: [{ id: validCase.id, input: validCase.input }],
      }),
    },
    {
      name: "missing case id",
      content: JSON.stringify({
        schemaVersion: "employee-evals.v1alpha1",
        cases: [{ input: validCase.input, expectedOutput: validCase.expectedOutput }],
      }),
    },
    {
      name: "case duplicate key",
      content:
        `{"schemaVersion":"employee-evals.v1alpha1","cases":[` +
        `{"id":"duplicate-key","input":{"message":"one"},` +
        `"input":{"message":"two"},"expectedOutput":${JSON.stringify(validCase.expectedOutput)}}]}`,
    },
    {
      name: "nested fixture duplicate key",
      content:
        `{"schemaVersion":"employee-evals.v1alpha1","cases":[` +
        `{"id":"nested-duplicate","input":{"message":"one","message":"two"},` +
        `"expectedOutput":${JSON.stringify(validCase.expectedOutput)}}]}`,
    },
    {
      name: "duplicate case id",
      content: JSON.stringify({
        schemaVersion: "employee-evals.v1alpha1",
        cases: [validCase, validCase],
      }),
    },
    {
      name: "empty cases",
      content: JSON.stringify({
        schemaVersion: "employee-evals.v1alpha1",
        cases: [],
      }),
    },
    {
      name: "cases over resource limit",
      content: JSON.stringify({
        schemaVersion: "employee-evals.v1alpha1",
        cases: tooManyCases,
      }),
    },
  ]

  for (const variant of variants) {
    await t.test(variant.name, async () => {
      const directory = await createMinimalPackage("invalid-contract")
      await writeEvalContract(directory, variant.content)
      const result = await evaluateEmployeePackage(directory)
      assert.equal(result.status, "failed")
      assert.equal(result.code, "EVAL_CONTRACT_INVALID")
      assert.deepEqual(result.summary, { total: 0, passed: 0, failed: 0 })
      assert.deepEqual(result.cases, [])
      assert.equal(result.employee?.name, "invalid-contract")
    })
  }
})

test("eval requires the fixed cases asset to be declared", async () => {
  const directory = await createMinimalPackage("undeclared-evals")
  await removeEvalAssetDeclaration(directory)
  const inspection = await inspectEmployeePackage(directory)
  assert.equal(inspection.manifest.assets.includes("./evals/cases.json"), false)

  const result = await evaluateEmployeePackage(directory)
  assert.equal(result.status, "failed")
  assert.equal(result.code, "EVAL_CONTRACT_INVALID")
  assert.equal(result.employee?.name, "undeclared-evals")
})

test("package and eval artifact regular-file boundaries fail as package invalid", async (t) => {
  await t.test("invalid package Schema", async () => {
    const directory = await createMinimalPackage("invalid-package-schema")
    await writeFile(
      path.join(directory, "schemas", "input.schema.json"),
      JSON.stringify({ type: "not-a-json-schema-type" }),
    )
    const result = await evaluateEmployeePackage(directory)
    assert.equal(result.status, "failed")
    assert.equal(result.code, "EVAL_PACKAGE_INVALID")
    assert.equal(result.employee, undefined)
  })

  await t.test("symlinked eval asset", async () => {
    const directory = await createMinimalPackage("symlinked-evals")
    const evalPath = path.join(directory, "evals", "cases.json")
    const outside = path.join(path.dirname(directory), "outside-cases.json")
    await writeFile(
      outside,
      JSON.stringify({ schemaVersion: "employee-evals.v1alpha1", cases: [] }),
    )
    await unlink(evalPath)
    await symlink(outside, evalPath)
    const result = await evaluateEmployeePackage(directory)
    assert.equal(result.code, "EVAL_PACKAGE_INVALID")
  })

  await t.test("directory in place of eval file", async () => {
    const directory = await createMinimalPackage("directory-evals")
    const evalPath = path.join(directory, "evals", "cases.json")
    await unlink(evalPath)
    await mkdir(evalPath)
    const result = await evaluateEmployeePackage(directory)
    assert.equal(result.code, "EVAL_PACKAGE_INVALID")
  })
})

test("CLI contract failure is JSON on stdout with exit one", async () => {
  const directory = await createMinimalPackage("cli-invalid-contract")
  await writeEvalContract(
    directory,
    `{"schemaVersion":"employee-evals.v1alpha1",` +
      `"schemaVersion":"employee-evals.v1alpha1","cases":[]}`,
  )
  const result = runCli(["eval", directory, "--json"])
  assert.equal(result.status, 1, result.stderr)
  assert.equal(result.stderr, "")
  assert.equal(JSON.parse(result.stdout).code, "EVAL_CONTRACT_INVALID")
})

test("CLI package and expected-output failures keep exact JSON codes and exit one", async () => {
  const invalidPackage = await createMinimalPackage("cli-invalid-package")
  await writeFile(
    path.join(invalidPackage, "schemas", "input.schema.json"),
    JSON.stringify({ type: "not-a-json-schema-type" }),
  )
  const packageResult = runCli(["eval", invalidPackage, "--json"])
  assert.equal(packageResult.status, 1, packageResult.stderr)
  assert.equal(packageResult.stderr, "")
  assert.equal(JSON.parse(packageResult.stdout).code, "EVAL_PACKAGE_INVALID")
  assert.doesNotMatch(packageResult.stdout, new RegExp(invalidPackage))

  const invalidOutput = await createMinimalPackage("cli-invalid-output")
  await replaceCases(invalidOutput, [
    {
      id: "invalid-output",
      input: { message: "valid" },
      expectedOutput: { status: "answered", answer: "missing citations" },
    },
  ])
  const outputResult = runCli(["eval", invalidOutput, "--json"])
  assert.equal(outputResult.status, 1, outputResult.stderr)
  assert.equal(outputResult.stderr, "")
  const output = JSON.parse(outputResult.stdout)
  assert.equal(output.code, "EVAL_CASE_EXPECTED_OUTPUT_SCHEMA_INVALID")
  assert.equal(
    output.cases[0].code,
    "EVAL_CASE_EXPECTED_OUTPUT_SCHEMA_INVALID",
  )
  assert.doesNotMatch(outputResult.stdout, new RegExp(invalidOutput))
})

test("eval rejects Agent Host selection instead of implying a live evaluation", async () => {
  const directory = await createMinimalPackage("no-live-host")
  const result = runCli(["eval", directory, "--engine", "qoder", "--json"])
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.equal(result.stderr, "digital-employee: eval_does_not_accept_engine\n")
})

test("both recipe selectors complete CLI init, validate, and contract eval", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "employee-recipe-cli-"))
  for (const [recipe, name] of [
    ["minimal-answer.v1", "cli-minimal"],
    ["structured-action.v1", "cli-structured"],
  ] as const) {
    const directory = path.join(parent, name)
    const initialized = runCli(["init", directory, "--recipe", recipe, "--json"])
    assert.equal(initialized.status, 0, initialized.stderr)
    assert.equal(JSON.parse(initialized.stdout).recipe, recipe)

    const validated = runCli(["validate", directory, "--json"])
    assert.equal(validated.status, 0, validated.stderr)
    assert.equal(JSON.parse(validated.stdout).status, "valid")

    const evaluated = runCli(["eval", directory, "--json"])
    assert.equal(evaluated.status, 0, evaluated.stderr)
    assert.equal(JSON.parse(evaluated.stdout).code, "EVAL_PASSED")
  }
})

test("CLI init conflict returns a stable JSON code without touching the target", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "employee-cli-conflict-"))
  const directory = path.join(parent, "existing-answer")
  await mkdir(directory)
  const sentinel = path.join(directory, "keep.txt")
  await writeFile(sentinel, "competition owns this directory")

  const result = runCli(["init", directory, "--json"])
  assert.equal(result.status, 1)
  assert.equal(result.stderr, "")
  assert.deepEqual(JSON.parse(result.stdout), {
    status: "failed",
    code: "INIT_TARGET_ALREADY_EXISTS",
  })
  assert.equal(
    await readFile(sentinel, "utf8"),
    "competition owns this directory",
  )
  await assert.rejects(
    () => readFile(path.join(directory, "employee.json"), "utf8"),
    /ENOENT/,
  )
})

test("structured recipe remains read-only proposal data with one capability", async () => {
  const source = path.join(
    root,
    "examples",
    "recipes",
    "structured-action.v1",
    "structured-action",
  )
  const sourceInspection = await inspectEmployeePackage(source)
  const sourceEval = await evaluateEmployeePackage(source)
  assert.deepEqual(sourceInspection.manifest.host.requiredCapabilities, [
    "structured_output",
  ])
  assert.equal(sourceInspection.manifest.policy.mode, "read_only")
  assert.equal(sourceInspection.manifest.policy.network, "deny")
  assert.deepEqual(sourceInspection.manifest.policy.filesystem.write, [])
  assert.deepEqual(sourceInspection.manifest.policy.mcpTools, [])
  assert.equal(sourceEval.code, "EVAL_PASSED")

  const publicRecipeFiles = [
    "employee.json",
    "SKILL.md",
    "schemas/input.schema.json",
    "schemas/output.schema.json",
    "knowledge/README.md",
    "evals/cases.json",
  ]
  const publicRecipeContents = await Promise.all(
    publicRecipeFiles.map((file) => readFile(path.join(source, file), "utf8")),
  )
  const combinedRecipe = publicRecipeContents.join("\n")
  assert.doesNotMatch(
    combinedRecipe,
    /claude|qoder|qwen|codebuddy|codex|api[-_ ]?key|token|credential|secret|private index/i,
  )
  assert.doesNotMatch(combinedRecipe, /\/Users\/|[A-Z]:\\/)

  const skill = publicRecipeContents[1]!
  const knowledge = publicRecipeContents[4]!
  for (const content of [skill, knowledge]) {
    assert.match(content, /proposal\/intent|proposal/i)
    assert.match(content, /never execute|never executes/i)
  }

  const parent = await mkdtemp(path.join(os.tmpdir(), "employee-structured-"))
  const directory = path.join(parent, "change-proposal")
  await createEmployeePackage(directory, { recipe: "structured-action.v1" })
  const generated = await inspectEmployeePackage(directory)
  assert.equal(generated.manifest.name, "change-proposal")
  assert.deepEqual(generated.manifest.host.requiredCapabilities, [
    "structured_output",
  ])
  assert.equal((await evaluateEmployeePackage(directory)).code, "EVAL_PASSED")
})

test("checked-in minimal recipe is itself a valid package with nonempty cases", async () => {
  const recipe = path.join(
    root,
    "examples",
    "recipes",
    "minimal-answer.v1",
    "minimal-answer",
  )
  const inspection = await inspectEmployeePackage(recipe)
  const contract = JSON.parse(
    await readFile(path.join(recipe, "evals", "cases.json"), "utf8"),
  )
  assert.equal(inspection.manifest.name, "minimal-answer")
  assert.deepEqual(inspection.manifest.host.requiredCapabilities, [])
  assert.equal(contract.cases.length > 0, true)
})
