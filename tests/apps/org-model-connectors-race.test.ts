import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { createEmployeePackage } from "../../apps/cli/employee-package.js"
import { createBuiltInRegistry } from "../../apps/cli/registry.js"
import {
  POSITION_CONNECTORS_FILE,
  readPositionDeclaration,
  type ScannedPosition,
} from "../../apps/cli/org/model.js"

function declaration(rootEnv: string): string {
  return `${JSON.stringify({
    schemaVersion: "position-connectors.v1",
    channels: [{ id: "console" }],
    sources: [{ id: "filesystem", env: { rootEnv } }],
  })}\n`
}

test("connector declaration replacement during read fails closed", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "org-connectors-race-"))
  t.after(() => rm(temporary, { recursive: true, force: true }))

  const positionDirectory = path.join(temporary, "position")
  await createEmployeePackage(positionDirectory, { name: "position" })
  await writeFile(
    path.join(positionDirectory, "budget.json"),
    `${JSON.stringify({
      perTask: { tokens: 1, iterations: 1 },
      perDay: { tokens: 1, iterations: 1 },
    })}\n`,
  )
  const connectorsPath = path.join(positionDirectory, POSITION_CONNECTORS_FILE)
  const displacedPath = path.join(temporary, "opened-connectors.json")
  const originalBytes = declaration("ORIGINAL_ROOT")
  const replacementBytes = declaration("REPLACED_ROOT")
  await writeFile(connectorsPath, originalBytes)
  await writeFile(displacedPath, replacementBytes)

  const position: ScannedPosition = {
    id: "position",
    directory: positionDirectory,
    reportTo: null,
    segments: ["position"],
    depth: 1,
  }
  const registry = await createBuiltInRegistry()

  await assert.rejects(
    () =>
      readPositionDeclaration(position, registry, {
        async beforeRead(filePath) {
          await rename(filePath, `${filePath}.opened`)
          await writeFile(filePath, replacementBytes)
        },
      }),
    /position_connectors_invalid:position/,
  )

  assert.deepEqual(
    (await readdir(positionDirectory)).filter((entry) => entry.includes("connectors")),
    ["connectors.json", "connectors.json.opened"],
  )
  assert.deepEqual(await readFile(`${connectorsPath}.opened`, "utf8"), originalBytes)
  assert.deepEqual(await readFile(connectorsPath, "utf8"), replacementBytes)
})
