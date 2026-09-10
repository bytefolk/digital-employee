import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

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
  delete env.COVERAGE_IMPORT_QUERY
  delete env.COVERAGE_IMPORT_TSX
  return env
}

function run(args: string[], env = environment()) {
  return spawnSync(process.execPath, args, {
    cwd: root, env, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
  })
}

async function capture(directory: string, files: string[], count: number, overrides: NodeJS.ProcessEnv = {}) {
  await mkdir(directory, { recursive: true })
  const result = run([
    "--enable-source-maps", "--import", "tsx", "--test", "--test-concurrency=1", "--test-reporter=tap", ...files,
  ], { ...environment(), ...overrides, NODE_V8_COVERAGE: directory, TMPDIR: directory })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, new RegExp(`# pass ${count}\\b`))
  assert.match(result.stdout, /# fail 0\b/)
  assert.match(result.stdout, /# skipped 0\b/)
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
  const temp = await mkdtemp(path.join(os.tmpdir(), "coverage-runners-"))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const sources = [
    "apps/cli/runner-executor.ts",
    "packages/core/src/runner-lease.ts",
    "packages/core/src/runner-replay-guard.ts",
  ]
  const builtFiles = sources.map(file => `dist/${file.replace(/\.ts$/, ".js")}`)
  const includes = [...sources, ...builtFiles]
  const expectedKeys = sources.map(file => path.join(root, file)).sort()
  const variants = [
    { name: "plain-node", query: "", tsx: "0" },
    { name: "plain-tsx", query: "", tsx: "1" },
    // Match host-runtime-exports.test.ts's cache-busting query shape without
    // making the experiment depend on a wall clock or coincident timestamps.
    { name: "query-a-tsx", query: "?test=1", tsx: "1" },
    { name: "query-b-tsx", query: "?test=2", tsx: "1" },
  ]
  const urls = (bytes: string): string[] => JSON.parse(bytes).result.map((entry: { url: string }) => entry.url)
  const select = (snapshots: string[], files: string[]) => {
    const expected = files.map(file => pathToFileURL(path.join(root, file)).href)
    for (const url of expected) assert.ok(snapshots.some(bytes => urls(bytes).includes(url)), `missing capture: ${url}`)
    return snapshots.filter(bytes => urls(bytes).some(url => expected.includes(url)))
  }
  const normalize = (current: Awaited<ReturnType<typeof report>>) => ({
    summary: current.summary,
    // Raw V8 hit counts and generated counter IDs are not source identities.
    locations: expectedKeys.map(file => [file, [...coveredLocations(current.coverage[file]!)].sort()]),
  })
  let reference: ReturnType<typeof normalize> | undefined
  // Recapture actual execution twice; replaying one capture twice cannot prove
  // repeatability of the collection step. No existing application test changes.
  for (let round = 1; round <= 2; round++) {
    const directory = path.join(temp, `round-${round}`)
    const source = select(await capture(path.join(directory, "source"), [
      "tests/apps/runner-executor.test.ts",
      "tests/core/runner-lease.test.ts",
      "tests/core/runner-replay-guard.test.ts",
    ], 22), sources)
    const alone = await report(path.join(directory, "alone"), source, includes)
    assert.equal(alone.result.status, 0, alone.result.stderr)
    assert.deepEqual(Object.keys(alone.coverage).sort(), expectedKeys)
    for (const variant of variants) {
      await t.test(`capture ${round}: ${variant.name}, all three runner files`, async subtest => {
        const currentDirectory = path.join(directory, variant.name)
        const built = select(await capture(path.join(currentDirectory, "capture"), [
          "tests/scripts/fixtures/coverage-compiled-import.test.mjs",
        ], 1, { COVERAGE_IMPORT_QUERY: variant.query, COVERAGE_IMPORT_TSX: variant.tsx }), builtFiles)
        const barrelUrl = pathToFileURL(path.join(root, "dist/apps/cli/host-runtime.js")).href + variant.query
        assert.ok(built.some(bytes => urls(bytes).includes(barrelUrl)), "the requested import URL must reach V8 coverage")
        const mixed = [...source, ...built]
        const orders = [mixed, [...mixed].reverse(), [...built, ...source]]
        for (const [index, snapshots] of orders.entries()) {
          const current = await report(path.join(currentDirectory, `order-${index}`), snapshots, includes)
          assert.equal(current.result.status, 0, current.result.stderr)
          assert.deepEqual(Object.keys(current.coverage).sort(), expectedKeys, "measure each original source exactly once")
          for (const file of expectedKeys) {
            const covered = coveredLocations(current.coverage[file]!)
            for (const location of coveredLocations(alone.coverage[file]!)) {
              assert.ok(covered.has(location), `${file}: an executed source location was erased: ${location}`)
            }
            assert.deepEqual(current.summary[file].lines, alone.summary[file].lines, `${file}: an unused import cannot erase line hits`)
          }
          const guard = path.join(root, sources[2]!)
          assert.ok(current.summary[guard].lines.pct >= 90, "existing guard tests must retain their real hits")
          const normalized = normalize(current)
          reference ??= normalized
          assert.deepEqual(normalized, reference, "metrics and positive source locations must match across capture rounds, orders and import URLs")
        }
        // Each affected file must independently reject an import-only capture;
        // an aggregate failure must not conceal an incorrectly passing file.
        for (const [index, file] of sources.entries()) {
          const uncovered = await report(path.join(currentDirectory, `uncovered-${index}`), built,
            [file, builtFiles[index]!], true)
          assert.deepEqual(Object.keys(uncovered.coverage), [path.join(root, file)])
          assert.notEqual(uncovered.result.status, 0, `${file}: mere import must not pass the real coverage gates`)
          assert.equal(uncovered.summary.total.functions.covered, 0, `${file}: import must execute no runner function`)
          for (const [metric, threshold] of [["lines", 85], ["branches", 65], ["functions", 80]] as const) {
            if (file === sources[0] && metric === "branches") {
              // V8 emits no block ranges for the uncalled executor functions.
              // c8 reports an empty branch denominator as 100%, not a failed
              // branch gate. Lines/functions must still reject this file;
              // lease and replay guard must still fail all three real gates.
              assert.deepEqual(uncovered.summary.total.branches, { total: 0, covered: 0, skipped: 0, pct: 100 })
              continue
            }
            assert.match(uncovered.result.stderr, new RegExp(`Coverage for ${metric} .*threshold \\(${threshold}%\\)`))
            assert.ok(uncovered.summary.total[metric].pct < threshold, `${file}: negative ${metric} control`)
          }
        }
        subtest.diagnostic("3 capture orders agree; 3 per-file import-only controls fail unchanged gates; executor has 0 measured branches")
      })
    }
  }
})
