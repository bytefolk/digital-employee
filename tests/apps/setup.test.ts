import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { setup } from "../../apps/cli/setup.js"

test("setup in empty directory scaffolds an employee and reports status", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "setup-test-"))
  const result = await captureSetupOutput(dir)

  assert.equal(result.environment.supported, true)
  assert.equal(result.environment.nodeMajor >= 20, true)
  assert.equal(result.employee.found, true)
  assert.equal(result.employee.scaffolded, true)

  // Verify employee.json was actually created in the subdirectory
  const manifest = JSON.parse(
    await readFile(path.join(result.employee.directory, "employee.json"), "utf8"),
  )
  assert.equal(typeof manifest.name, "string")
})

test("setup with existing employee package does not re-scaffold", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "setup-existing-"))
  // Create a fake employee.json in the directory itself
  await writeFile(
    path.join(dir, "employee.json"),
    JSON.stringify({ name: "existing-employee", version: "0.1.0", schemaVersion: "1.0" }),
  )
  const result = await captureSetupOutput(dir)

  assert.equal(result.employee.found, true)
  assert.equal(result.employee.scaffolded, false)
  assert.equal(result.employee.name, "existing-employee")
})

test("setup reports node version information", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "setup-env-"))
  const result = await captureSetupOutput(dir)

  assert.equal(result.environment.nodeVersion, process.version)
  assert.equal(typeof result.environment.packageVersion, "string")
})

test("setup reports hosts array", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "setup-hosts-"))
  const result = await captureSetupOutput(dir)

  assert.ok(Array.isArray(result.hosts))
  assert.ok(result.hosts.length > 0)
  for (const host of result.hosts) {
    assert.equal(typeof host.id, "string")
    assert.equal(typeof host.displayName, "string")
    assert.equal(typeof host.available, "boolean")
  }
})

async function captureSetupOutput(dir: string): Promise<Record<string, any>> {
  const chunks: string[] = []
  const originalWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString())
    return true
  }) as typeof process.stdout.write

  try {
    await setup({ directory: dir, json: true })
  } finally {
    process.stdout.write = originalWrite
  }

  return JSON.parse(chunks.join(""))
}
