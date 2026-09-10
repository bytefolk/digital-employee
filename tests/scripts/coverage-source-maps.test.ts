import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

test("coverage maps the built CLI exercised by subprocess tests back to TypeScript", {
  // Node 20 has no --test-coverage-include option. CI's coverage lane uses
  // Node 22; keep the ordinary Node 20 application tests independently active.
  skip: Number(process.versions.node.split(".")[0]) < 22,
}, async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
  const includes = [...manifest.scripts["test:coverage"].matchAll(/--test-coverage-include='([^']+)'/g)]
    .map((match) => `--test-coverage-include=${match[1]}`)
  assert.ok(includes.length > 0, "coverage must keep an explicit source boundary")
  const env = { ...process.env }
  // This is a separate test-runner invocation, not a worker of this runner.
  delete env.NODE_TEST_CONTEXT
  delete env.NODE_V8_COVERAGE
  const result = spawnSync(process.execPath, [
    "--enable-source-maps", "--import", "tsx", "--test",
    "--experimental-test-coverage", "--test-reporter=tap", ...includes,
    "tests/apps/hire-cli.test.ts",
  ], { cwd: root, env, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
  assert.equal(result.status, 0, result.stderr)
  // These existing black-box tests execute dist/apps/cli/hire.js. Node filters
  // coverage URLs before mapping them, so a TypeScript-only include list loses
  // every executed range from that child despite all its assertions passing.
  const hireCoverage = result.stdout.match(/#\s+hire\.ts\s+\|\s+([\d.]+)\s+\|/)
  assert.ok(hireCoverage, "built hire command is missing from source coverage")
  assert.ok(Number(hireCoverage[1]) >= 90, "the exercised hire paths must be counted")
  assert.doesNotMatch(result.stdout, /#\s+hire\.js\s+\|/, "do not double-count built and source files")
})
