import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { createRuntime, runtimeHealth } from "../../apps/cli/runtime.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const cli = path.join(root, "apps", "cli", "bin.ts")
const fakeGitFixture = path.join(root, "tests", "git", "fixtures", "fake-git.mjs")

interface CliRun {
  status: number | null
  stdout: string
  stderr: string
}

function runCli(args: string[], environment: NodeJS.ProcessEnv): CliRun {
  const result = spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: environment,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }
}

interface CliFixtureContext {
  root: string
  cacheDir: string
  configPath: string
  binDir: string
  recordPath: string
  baseEnv: NodeJS.ProcessEnv
}

async function withCliFixture(
  fn: (context: CliFixtureContext) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "digital-employee-cli-git-"))
  const binDir = path.join(directory, "bin")
  await mkdir(binDir, { recursive: true })
  const gitPath = path.join(binDir, "git")
  await writeFile(gitPath, await readFile(fakeGitFixture, "utf8"), { mode: 0o755 })
  await chmod(gitPath, 0o755)
  const cacheDir = path.join(directory, "cache")
  const recordPath = path.join(directory, "git-record.jsonl")
  const configPath = path.join(directory, "config.json")
  try {
    await writeConfig(configPath, { cacheDir })
    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      GIT_TEST_RECORD: recordPath,
      DIGITAL_EMPLOYEE_SUPPRESS_LEGACY_WARNING: "1",
    }
    await fn({ root: directory, cacheDir, configPath, binDir, recordPath, baseEnv })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function writeConfig(
  configPath: string,
  source: { cacheDir: string; maxStaleMs?: number; omitBound?: boolean },
): Promise<void> {
  const config = {
    employee: { id: "cli-git-lkg", profile: "answer-agent" },
    runtime: { readOnly: true, topK: 3, minScore: 0.03 },
    model: { provider: "extractive" },
    sources: [
      {
        id: "git-docs",
        type: "git",
        remote: "https://example.test/public-docs.git",
        ref: "main",
        cacheDir: source.cacheDir,
        policy: "prefer_last_known_good",
        ...(source.omitBound
          ? {}
          : { maxStaleMs: source.maxStaleMs ?? 600_000 }),
      },
    ],
  }
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
}

test("AC-007: sync --json reports fresh, then degraded with exit 2 on remote failure", async () => {
  await withCliFixture(async (context) => {
    const fresh = runCli(
      ["legacy", "sync", "--json", "-c", context.configPath],
      context.baseEnv,
    )
    assert.equal(fresh.status, 0, fresh.stderr)
    const freshJson = JSON.parse(fresh.stdout) as {
      status: string
      documentCount: number
      sources: { id: string; type: string; status: string }[]
    }
    assert.equal(freshJson.status, "ready")
    assert.equal(freshJson.documentCount, 3)
    assert.deepEqual(freshJson.sources, [
      { id: "git-docs", type: "git", status: "fresh" },
    ])
    assert.ok(!fresh.stdout.includes(context.cacheDir))
    assert.ok(!fresh.stdout.includes("public-docs"))
    assert.ok(!fresh.stderr.includes("fatal"))

    const degradedEnv = { ...context.baseEnv, GIT_TEST_FAIL_EXIT: "73" }
    const degraded = runCli(
      ["legacy", "sync", "--json", "-c", context.configPath],
      degradedEnv,
    )
    assert.equal(degraded.status, 2, degraded.stderr)
    const degradedJson = JSON.parse(degraded.stdout) as {
      status: string
      documentCount: number
      sources: { id: string; type: string; status: string }[]
    }
    assert.equal(degradedJson.status, "degraded")
    assert.equal(degradedJson.documentCount, 3)
    assert.deepEqual(degradedJson.sources, [
      { id: "git-docs", type: "git", status: "degraded" },
    ])
    assert.match(degraded.stderr, /is degraded/)
    assert.ok(!degraded.stderr.includes("Ready"))
    assert.ok(!degraded.stderr.includes(context.cacheDir))
    assert.ok(!degraded.stderr.includes("fatal"))
  })
})

test("AC-007: text sync prints Degraded and exits 2, never Ready", async () => {
  await withCliFixture(async (context) => {
    const fresh = runCli(["legacy", "sync", "-c", context.configPath], context.baseEnv)
    assert.equal(fresh.status, 0, fresh.stderr)
    assert.match(fresh.stdout, /^Ready:/)

    const degradedEnv = { ...context.baseEnv, GIT_TEST_FAIL_EXIT: "73" }
    const degraded = runCli(
      ["legacy", "sync", "-c", context.configPath],
      degradedEnv,
    )
    assert.equal(degraded.status, 2, degraded.stderr)
    assert.match(degraded.stdout, /^Degraded:/)
    assert.ok(!degraded.stdout.includes("Ready"))
  })
})

test("AC-007: runtime status and HTTP health report degraded, never ready", async () => {
  await withCliFixture(async (context) => {
    const originalPath = process.env.PATH
    const originalFail = process.env.GIT_TEST_FAIL_EXIT
    try {
      process.env.PATH = `${context.binDir}${path.delimiter}${originalPath ?? ""}`
      delete process.env.GIT_TEST_FAIL_EXIT
      const runtime = await createRuntime(context.configPath)
      assert.deepEqual(runtime.sourceStatuses, [
        { id: "git-docs", type: "git", status: "fresh" },
      ])
      const freshHealth = JSON.stringify(runtimeHealth(runtime))
      assert.ok(!freshHealth.includes(context.cacheDir))

      process.env.GIT_TEST_FAIL_EXIT = "73"
      const degradedRuntime = await createRuntime(context.configPath)
      assert.deepEqual(degradedRuntime.sourceStatuses, [
        { id: "git-docs", type: "git", status: "degraded" },
      ])
      const health = runtimeHealth(degradedRuntime) as {
        status: string
        employee: string
        documents: number
        sources: { id: string; type: string; status: string }[]
      }
      assert.equal(health.status, "ok")
      assert.equal(health.employee, "cli-git-lkg")
      assert.equal(health.documents, 3)
      assert.equal(health.sources[0].status, "degraded")
      const healthText = JSON.stringify(health)
      assert.ok(!healthText.includes("Ready"))
      assert.ok(!healthText.includes("ready"))
      assert.ok(!healthText.includes(context.cacheDir))
      assert.ok(!healthText.includes("public-docs"))
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      if (originalFail === undefined) delete process.env.GIT_TEST_FAIL_EXIT
      else process.env.GIT_TEST_FAIL_EXIT = originalFail
    }
  })
})

test("AC-001/AC-007: out-of-bounds or missing LKG bounds fail at configuration", async () => {
  await withCliFixture(async (context) => {
    const outOfBounds = path.join(context.root, "config-out-of-bounds.json")
    await writeConfig(outOfBounds, { cacheDir: context.cacheDir, maxStaleMs: 999 })
    const rejected = runCli(
      ["legacy", "sync", "--json", "-c", outOfBounds],
      context.baseEnv,
    )
    assert.equal(rejected.status, 1)
    assert.match(rejected.stderr, /git_source_lkg_max_stale_ms_out_of_bounds/)
    assert.ok(!rejected.stdout.includes("Ready"))

    const missingBound = path.join(context.root, "config-missing-bound.json")
    await writeConfig(missingBound, { cacheDir: context.cacheDir, omitBound: true })
    const missing = runCli(
      ["legacy", "sync", "--json", "-c", missingBound],
      context.baseEnv,
    )
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /git_source_lkg_max_stale_ms_out_of_bounds:missing/)
  })
})
