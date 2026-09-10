import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

const c8 = path.join(root, "node_modules/c8/bin/c8.js")
const domains = [
  "apps/**/*.ts", "connectors/**/*.ts", "packages/**/*.ts", "profiles/**/*.ts", "scripts/**/*.js",
  "dist/apps/**/*.js", "dist/connectors/**/*.js", "dist/packages/**/*.js", "dist/profiles/**/*.js",
]
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))

interface Location {
  start: { line: number; column: number }
  end: { line: number; column: number }
}
interface FileCoverage {
  statementMap: Record<string, Location>
  fnMap: Record<string, { loc: Location }>
  branchMap: Record<string, { locations: Location[] }>
  s: Record<string, number>
  f: Record<string, number>
  b: Record<string, number[]>
}

function environment(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  // Nested instrumentation is independent of the enclosing application suite.
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_V8_COVERAGE
  return env
}

function run(args: string[], env = environment()) {
  return spawnSync(process.execPath, args, {
    cwd: root, env, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
  })
}

async function capture(directory: string, files: string[], count: number) {
  await mkdir(directory, { recursive: true })
  const result = run([
    "--enable-source-maps", "--import", "tsx", "--test", "--test-concurrency=1", "--test-reporter=tap", ...files,
  ], { ...environment(), NODE_V8_COVERAGE: directory })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, new RegExp(`# pass ${count}\\b`))
  return Promise.all((await readdir(directory)).filter(file => file.endsWith(".json"))
    .map(file => readFile(path.join(directory, file), "utf8")))
}

async function report(directory: string, snapshots: string[], pair: string[], check = false) {
  const raw = path.join(directory, "raw")
  await mkdir(raw, { recursive: true })
  // Real immutable captures; rename only to control enumeration order.
  await Promise.all(snapshots.map((bytes, index) =>
    writeFile(path.join(raw, `coverage-${100 + index}-0-0.json`), bytes)))
  const configFile = path.join(directory, "c8.json")
  await writeFile(configFile, JSON.stringify({
    ...manifest.c8,
    include: pair.filter(file => manifest.c8.include.some((glob: string) => path.matchesGlob(file, glob))),
    reporter: ["json", "json-summary"],
    "temp-directory": raw,
    "reports-dir": directory,
    // Focused reports inspect accounting, not repository-wide percentages.
    // Negative controls enable the actual unchanged production gates.
    "check-coverage": check,
  }))
  const result = run([c8, "report", "--config", configFile])
  const summary = JSON.parse(await readFile(path.join(directory, "coverage-summary.json"), "utf8"))
  const coverage: Record<string, FileCoverage> = JSON.parse(
    await readFile(path.join(directory, "coverage-final.json"), "utf8"),
  )
  return { result, summary, coverage }
}

function coveredLocations(file: FileCoverage) {
  // Istanbul identifies functions/branches by source location, not V8's
  // generated function index/name. Coalesce duplicate TSX initializer locations.
  const locations = new Set<string>()
  const add = (kind: string, location: Location, hits: number) => {
    if (hits > 0) locations.add(`${kind}:${JSON.stringify(location)}`)
  }
  for (const [id, location] of Object.entries(file.statementMap)) add("line", location, file.s[id]!)
  for (const [id, fn] of Object.entries(file.fnMap)) add("function", fn.loc, file.f[id]!)
  for (const [id, branch] of Object.entries(file.branchMap)) {
    branch.locations.forEach((location, index) => add("branch", location, file.b[id]![index]!))
  }
  return locations
}

test("coverage retains every production domain, source-map pair and threshold", async () => {
  assert.equal(manifest.devDependencies.c8, "12.0.0")
  assert.deepEqual(manifest.c8.include, domains)
  assert.deepEqual(manifest.c8.exclude, [], "do not inherit hidden collector exclusions")
  assert.equal(manifest.c8["exclude-after-remap"], false)
  assert.equal(manifest.c8.all, false, "retain the existing loaded-only measurement boundary")
  assert.equal(manifest.c8["check-coverage"], true)
  assert.deepEqual([manifest.c8.lines, manifest.c8.branches, manifest.c8.functions], [85, 65, 80])
  assert.equal(manifest.scripts["test:coverage"], "c8 tsx --test --test-concurrency=1 tests/**/*.test.ts && node scripts/check-coverage-report.js")
  const expected: string[] = JSON.parse(await readFile(
    path.join(root, "tests/scripts/fixtures/coverage-source-universe.json"), "utf8",
  ))
  assert.equal(expected.length, 124, "the pre-repair mapping universe is immutable")
  const sources = new Set<string>()
  for (const entry of await readdir(path.join(root, "dist"), { recursive: true })) {
    if (!entry.endsWith(".js.map")) continue
    const built = path.join("dist", entry.slice(0, -4)).split(path.sep).join("/")
    const mapFile = path.join(root, "dist", entry)
    const map = JSON.parse(await readFile(mapFile, "utf8"))
    for (const source of map.sources as string[]) {
      const original = path.relative(root, path.resolve(path.dirname(mapFile), source)).split(path.sep).join("/")
      assert.ok(domains.some(glob => path.matchesGlob(built, glob)), `missing built domain: ${built}`)
      assert.ok(domains.some(glob => path.matchesGlob(original, glob)), `missing source domain: ${original}`)
      sources.add(original)
    }
  }
  for (const original of expected) {
    assert.ok(sources.has(original), `original source/build/map pair disappeared: ${original}`)
  }
})

test("coverage maps the built CLI exercised by subprocess tests back to TypeScript", async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "coverage-hire-"))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const snapshots = await capture(path.join(temp, "capture"), ["tests/apps/hire-cli.test.ts"], 3)
  const sourceOnly = await report(path.join(temp, "source-only"), snapshots, ["apps/cli/hire.ts"])
  assert.equal(sourceOnly.result.status, 0, sourceOnly.result.stderr)
  assert.deepEqual(Object.keys(sourceOnly.coverage), [], "the original source-only filter loses built CLI execution")
  const { result, summary, coverage } = await report(path.join(temp, "report"), snapshots, [
    "apps/cli/hire.ts", "dist/apps/cli/hire.js",
  ])
  assert.equal(result.status, 0, result.stderr)
  const files = Object.keys(coverage)
  assert.equal(files.length, 1)
  assert.ok(files[0]!.endsWith("/apps/cli/hire.ts"), "do not double-count source and built files")
  assert.ok(summary.total.lines.pct >= 90, "existing black-box CLI execution must be counted")
  const measured = run(["scripts/check-coverage-report.js", path.join(temp, "report/coverage-summary.json")])
  assert.equal(measured.status, 0, measured.stderr)
})

test("empty, missing or nonfinite coverage fails closed instead of passing numeric gates", async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "coverage-empty-"))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const empty = await report(temp, [], ["apps/cli/hire.ts"], true)
  assert.deepEqual(Object.keys(empty.coverage), [])
  const rejected = run(["scripts/check-coverage-report.js", path.join(temp, "coverage-summary.json")])
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /no measured files/)
  const missing = run(["scripts/check-coverage-report.js", path.join(temp, "missing.json")])
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /ENOENT/)
  for (const metric of ["lines", "branches", "functions"]) {
    for (const pct of [null, "Unknown", "Infinity"]) {
      const total = Object.fromEntries(["lines", "branches", "functions"].map(name =>
        [name, { total: 1, covered: 1, pct: name === metric ? pct : 100 }]))
      const invalid = path.join(temp, "invalid.json")
      await writeFile(invalid, JSON.stringify({ total, "apps/cli/hire.ts": {} }))
      const nonfinite = run(["scripts/check-coverage-report.js", invalid])
      assert.notEqual(nonfinite.status, 0)
      assert.match(nonfinite.stderr, new RegExp(`no measured ${metric}`))
    }
  }
})

test("mixed source/build captures are order-invariant without erasing hits or accepting uncovered code", async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "coverage-guard-"))
  t.after(() => rm(temp, { recursive: true, force: true }))
  // Nine existing application tests are unchanged. The additional import
  // executes no claim: it must not erase their hits or pad application coverage.
  const snapshots = await capture(path.join(temp, "capture"), [
    "tests/core/runner-replay-guard.test.ts",
    "tests/scripts/fixtures/coverage-compiled-import.test.mjs",
  ], 10)
  const source = snapshots.find(bytes => JSON.parse(bytes).result.some(
    (entry: { url: string }) => entry.url.endsWith("/packages/core/src/runner-replay-guard.ts"),
  ))
  const built = snapshots.find(bytes => JSON.parse(bytes).result.some(
    (entry: { url: string }) => entry.url.endsWith("/dist/packages/core/src/runner-replay-guard.js"),
  ))
  assert.ok(source && built, "both independently generated coverage shapes must be captured")
  const pair = ["packages/core/src/runner-replay-guard.ts", "dist/packages/core/src/runner-replay-guard.js"]
  const alone = await report(path.join(temp, "alone"), [source], pair)
  const forward = await report(path.join(temp, "forward"), [source, built], pair)
  const reverse = await report(path.join(temp, "reverse"), [built, source], pair)
  for (const current of [alone, forward, reverse]) assert.equal(current.result.status, 0, current.result.stderr)
  assert.deepEqual(forward.summary, reverse.summary, "all metrics must be independent of snapshot order")
  assert.deepEqual(forward.summary.total.lines, alone.summary.total.lines, "an unused import cannot erase line hits")
  assert.ok(forward.summary.total.lines.pct >= 90, "nine existing guard tests must retain their real hits")
  assert.equal(Object.keys(forward.coverage).length, 1, "do not count the built file again")
  const original = Object.values(alone.coverage)[0]!
  for (const current of [forward, reverse]) {
    const covered = coveredLocations(Object.values(current.coverage)[0]!)
    for (const location of coveredLocations(original)) {
      assert.ok(covered.has(location), `an executed source location was erased: ${location}`)
    }
  }
  const uncovered = await report(path.join(temp, "uncovered"), [built], pair, true)
  assert.notEqual(uncovered.result.status, 0, "mere import must not pass the real coverage gates")
  for (const [metric, threshold] of [["lines", 85], ["branches", 65], ["functions", 80]] as const) {
    assert.match(uncovered.result.stderr, new RegExp(`Coverage for ${metric} .*threshold \\(${threshold}%\\)`))
    assert.ok(uncovered.summary.total[metric].pct < threshold)
  }
})
