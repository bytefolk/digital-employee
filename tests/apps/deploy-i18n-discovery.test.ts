import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const dist = path.join(root, "dist")
const builtCli = path.join(dist, "apps", "cli", "bin.js")

function cliEnvironment(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env }
  delete environment.LANG
  delete environment.LC_ALL
  return {
    ...environment,
    HOME: home,
    PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
    ...extra,
  }
}

function runBin(
  entry: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd,
    env: environment,
    encoding: "utf8",
    input: "",
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  })
}

/**
 * Copy the built dist/ tree into a temporary install-shaped layout so a
 * synthetic locale can be dropped into dist/locales without touching the
 * repository. This mirrors the shipped package: locales are discovered
 * relative to the built tree, not registered in TypeScript.
 */
async function copiedBuiltCli(
  t: test.TestContext,
  label: string,
): Promise<{ bin: string; localesDir: string; home: string }> {
  assert.ok(existsSync(builtCli), "built CLI missing: run `npm run build` before this suite")
  const temporary = await mkdtemp(path.join(os.tmpdir(), `i18n-discovery-${label}-`))
  t.after(async () => rm(temporary, { recursive: true, force: true }))
  const copiedDist = path.join(temporary, "dist")
  await cp(dist, copiedDist, { recursive: true })
  await symlink(path.join(root, "node_modules"), path.join(copiedDist, "node_modules"), "dir")
  const home = path.join(temporary, "home")
  await mkdir(home)
  return {
    bin: path.join(copiedDist, "apps", "cli", "bin.js"),
    localesDir: path.join(copiedDist, "locales"),
    home,
  }
}

test("AC-001: a JSON-only synthetic locale is discovered and rendered by the built CLI", async (t) => {
  const { bin, localesDir, home } = await copiedBuiltCli(t, "synthetic")
  const reference = JSON.parse(
    await readFile(path.join(localesDir, "en.json"), "utf8"),
  ) as Record<string, string>
  const synthetic: Record<string, string> = { "locale.display_name": "Synthetic Fixture" }
  for (const [key, value] of Object.entries(reference)) {
    if (key === "locale.display_name") continue
    synthetic[key] = `XX·${value}`
  }
  await writeFile(
    path.join(localesDir, "xx-XX.json"),
    `${JSON.stringify(synthetic, null, 2)}\n`,
    "utf8",
  )
  const result = runBin(bin, ["deploy", "--help", "--locale", "xx-XX"], cliEnvironment(home), home)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, "")
  assert.match(result.stdout, /xx-XX/, "discovered locale must appear in the supported list")
  assert.match(result.stdout, /XX·/, "deploy help must render from the synthetic catalog")
  assert.match(result.stdout, /Synthetic Fixture|xx-XX/)
})

test("AC-002: a malformed catalog falls back to English with an observable warning", async (t) => {
  const { bin, localesDir, home } = await copiedBuiltCli(t, "malformed")
  await writeFile(path.join(localesDir, "yy.json"), "{ not valid json", "utf8")
  const result = runBin(
    bin,
    ["deploy", "--help"],
    cliEnvironment(home, { LANG: "yy_YY.UTF-8" }),
    home,
  )
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /\[i18n\] failed to parse yy\.json/)
  assert.match(result.stdout, /digital-employee deploy \[package-path\]/)
  assert.doesNotMatch(result.stdout, /XX·/)
})

test("AC-002: a non-object catalog root falls back to English without crashing", async (t) => {
  const { bin, localesDir, home } = await copiedBuiltCli(t, "non-object")
  await writeFile(path.join(localesDir, "zz.json"), "null", "utf8")
  const result = runBin(
    bin,
    ["deploy", "--help"],
    cliEnvironment(home, { LANG: "zz_ZZ.UTF-8" }),
    home,
  )
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /\[i18n\] failed to parse zz\.json/)
  assert.match(result.stdout, /digital-employee deploy \[package-path\]/)
})

test("AC-002: an explicitly unsupported --locale stays fail-closed with a nonzero exit", async (t) => {
  const { bin, home } = await copiedBuiltCli(t, "unsupported")
  const result = runBin(bin, ["deploy", "--help", "--locale", "qq-QQ"], cliEnvironment(home), home)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /locale/)
})
