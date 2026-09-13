import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"

test("compiled host-runtime imports without executing a runner task, lease or replay claim", () => {
  const query = process.env.COVERAGE_IMPORT_QUERY ?? ""
  assert.ok(["", "?test=1", "?test=2"].includes(query))
  const result = spawnSync(process.execPath, [
    ...(process.env.COVERAGE_IMPORT_TSX === "1" ? ["--import", "tsx"] : []),
    "--enable-source-maps", "--input-type=module", "-e",
    `await import(${JSON.stringify(`./dist/apps/cli/host-runtime.js${query}`)})`,
  ], { cwd: process.cwd(), encoding: "utf8", timeout: 10_000 })
  assert.equal(result.status, 0, result.stderr)
})
