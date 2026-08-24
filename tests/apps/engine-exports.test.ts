import assert from "node:assert/strict"
import { access, readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"

test("root package ./engine export resolves to the built portable delegation API", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
    exports: Record<string, { import: string; types: string }>
  }
  const target = manifest.exports["./engine"]!
  await access(path.resolve(target.import))
  await access(path.resolve(target.types))
  const engine = await import(path.resolve(target.import))
  for (const symbol of [
    "executeDelegation",
    "parseDelegationEnvelope",
    "parseExistingDelegationHistory",
    "validateDelegationAdmission",
    "createRequestedTaskRecord",
  ]) {
    assert.equal(typeof engine[symbol], "function")
  }
})
