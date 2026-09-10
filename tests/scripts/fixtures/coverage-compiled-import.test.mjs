import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"

test("compiled host-runtime imports without executing a replay claim", () => {
  const result = spawnSync(process.execPath, [
    "--enable-source-maps", "--input-type=module", "-e",
    "await import('./dist/apps/cli/host-runtime.js')",
  ], { cwd: process.cwd(), encoding: "utf8", timeout: 10_000 })
  assert.equal(result.status, 0, result.stderr)
})
