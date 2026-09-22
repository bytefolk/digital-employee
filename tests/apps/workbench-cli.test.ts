import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"

const builtCli = new URL("../../dist/apps/cli/bin.js", import.meta.url)

function run(args: string[]) {
  return spawnSync(process.execPath, [builtCli.pathname, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  })
}

test("#331 AC-004: installed CLI help exposes the bounded Workbench launch path", () => {
  const result = run(["--help"])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /digital-employee workbench \[workspace\]/)
})

test("#331 AC-003: Workbench CLI rejects a non-loopback bind before listening", () => {
  const result = run(["workbench", ".", "--host", "0.0.0.0", "--port", "0"])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /workbench_loopback_required/)
})

test("#331 AC-003: Workbench CLI accepts only one workspace", () => {
  const result = run(["workbench", ".", "../other"])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /workbench_accepts_one_workspace/)
})
