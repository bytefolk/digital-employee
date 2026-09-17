import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const c8Bin = path.join(root, "node_modules", "c8", "bin", "c8.js")

async function writeFixture(directory: string): Promise<{ source: string; built: string }> {
  const sourceDir = path.join(directory, "src")
  const builtDir = path.join(directory, "dist")
  await mkdir(sourceDir, { recursive: true })
  await mkdir(builtDir, { recursive: true })
  const source = path.join(sourceDir, "hire.ts")
  const built = path.join(builtDir, "hire.js")
  const sourceMap = path.join(builtDir, "hire.js.map")
  const sourceText = [
    "export function covered(value: number): number {",
    "  return value + 1",
    "}",
    "export function uncovered(value: number): number {",
    "  if (value > 0) return value",
    "  return 0",
    "}",
    "",
  ].join("\n")
  await writeFile(source, sourceText)
  const builtText = [
    "export function covered(value) {",
    "  return value + 1",
    "}",
    "export function uncovered(value) {",
    "  if (value > 0) return value",
    "  return 0",
    "}",
    "//# sourceMappingURL=hire.js.map",
    "",
  ].join("\n")
  await writeFile(built, builtText)
  await writeFile(
    sourceMap,
    JSON.stringify({
      version: 3,
      file: "hire.js",
      sourceRoot: "",
      sources: ["../src/hire.ts"],
      names: [],
      mappings: "AAAA,OAAO,SAAS,OAAO,KAAK;IAC1B,OAAO,KAAK,GAAG,CAAC;AACnB;AACA,OAAO,SAAS,SAAS,KAAK;IAC5B,IAAI,KAAK,GAAG,CAAC,EAAE,OAAO,KAAK;IACzB,OAAO,CAAC;AACT",
    }),
  )
  const testFile = path.join(directory, "hire.test.mjs")
  await writeFile(
    testFile,
    "import { covered } from './dist/hire.js'\n" +
      "if (covered(1) !== 2) throw new Error('covered')\n",
  )
  return { source, built }
}

function collect(directory: string, include: string[]): Record<string, unknown> {
  const temp = path.join(directory, `c8-${include.join("-").replaceAll(/[^a-z./]/gi, "")}`)
  const result = spawnSync(
    process.execPath,
    [
      c8Bin,
      "--reporter=json",
      `--reports-dir=${temp}`,
      ...include.flatMap((pattern) => ["--include", pattern]),
      "--exclude",
      "node_modules/**",
      process.execPath,
      path.join(directory, "hire.test.mjs"),
    ],
    { cwd: directory, encoding: "utf8", timeout: 20_000 },
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(readFileSync(path.join(temp, "coverage-final.json"), "utf8")) as Record<
    string,
    unknown
  >
}

function summary(report: Record<string, unknown>): { files: string[]; lines: number } {
  const files = Object.keys(report).sort()
  let covered = 0
  let total = 0
  for (const file of files) {
    const entry = report[file] as { s?: Record<string, number> }
    for (const hits of Object.values(entry.s ?? {})) {
      total += 1
      if (hits > 0) covered += 1
    }
  }
  return { files, lines: total === 0 ? 0 : Math.round((covered / total) * 10000) / 100 }
}

test("#261 tsx and c8 pins are exact", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
    devDependencies: Record<string, string>
  }
  assert.equal(manifest.devDependencies.tsx, "4.23.13")
  assert.equal(manifest.devDependencies.c8, "12.0.0")
})

test("#261 mixed source/built capture order is invariant and keeps original source", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "coverage-accounting-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const paths = await writeFixture(directory)
  const sourceThenBuilt = collect(directory, ["src/**/*.ts", "dist/**/*.js"])
  const builtThenSource = collect(directory, ["dist/**/*.js", "src/**/*.ts"])
  const first = summary(sourceThenBuilt)
  const second = summary(builtThenSource)
  assert.deepEqual(first.files, second.files)
  assert.equal(first.lines, second.lines)
  const mapped = first.files.some((file) => file.endsWith(`${path.sep}src${path.sep}hire.ts`) || file.endsWith("/src/hire.ts"))
  const builtRow = first.files.filter((file) => file.endsWith(`${path.sep}dist${path.sep}hire.js`) || file.endsWith("/dist/hire.js"))
  assert.equal(mapped, true)
  assert.equal(builtRow.length <= 1, true)
  assert.ok(paths.source)
})

test("#261 a genuinely unexecuted control fails coverage thresholds", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "coverage-uncovered-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFixture(directory)
  const result = spawnSync(
    process.execPath,
    [
      c8Bin,
      "--check-coverage",
      "--lines=90",
      "--functions=90",
      "--include",
      "src/**/*.ts",
      "--include",
      "dist/**/*.js",
      "--exclude",
      "node_modules/**",
      process.execPath,
      path.join(directory, "hire.test.mjs"),
    ],
    { cwd: directory, encoding: "utf8", timeout: 20_000 },
  )
  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /ERROR: (Coverage|Functions|Lines)/)
})
