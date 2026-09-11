/**
 * E3 black-box acceptance for the built-in engine's first workspace slice.
 *
 * This intentionally uses the credential-free deterministic model port. It
 * proves the product path that is safe to run in CI: the four materialized
 * oss-maintainer packages are validated, projected into the engine context,
 * executed through `turn run`, and leave digest-only evidence on disk. It is
 * not a qualification of a live Qoder/Claude installation.
 */

import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  computeEmployeePackageDirectoryDigest,
} from "../../apps/cli/employee-package.js"
import {
  deriveOrganizationPermissions,
} from "../../apps/cli/org/permissions.js"
import { validateOrganizationDocument } from "../../apps/cli/org/budget.js"
import { runTurn } from "../../apps/cli/turn/turn-run.js"
import {
  OSS_MAINTAINER_TEMPLATE,
  renderOrganizationFile,
  renderSkeletonFiles,
  workspaceRoleDirectorySegments,
} from "../../apps/cli/workspace/templates.js"
import {
  computeEnvelopeDigest,
  TURN_ENVELOPE_VERSION,
} from "../../apps/cli/turn/envelope.js"

const POSITIONS = OSS_MAINTAINER_TEMPLATE.roles.map((role) => role.id)

async function createMaterializedWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "built-in-engine-"))
  const skeleton = renderSkeletonFiles(
    OSS_MAINTAINER_TEMPLATE,
    "oss",
    "2026-09-05T00:00:00.000Z",
    "00000000-0000-4000-8000-000000000001",
  )
  for (const file of skeleton) {
    const destination = path.join(workspace, file.portablePath.slice(2))
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, file.content)
  }

  const digests: Record<string, { name: string; version: string; digest: string }> = {}
  for (const role of OSS_MAINTAINER_TEMPLATE.roles) {
    const directory = path.join(
      workspace,
      "positions",
      ...workspaceRoleDirectorySegments(OSS_MAINTAINER_TEMPLATE, role.id),
    )
    digests[role.id] = {
      name: role.id,
      version: "0.1.0",
      digest: await computeEmployeePackageDirectoryDigest(directory),
    }
  }
  const organization = renderOrganizationFile(
    OSS_MAINTAINER_TEMPLATE,
    "oss",
    workspace,
    digests,
    "2026-09-05T00:00:00.000Z",
  )
  const organizationPath = path.join(workspace, organization.portablePath)
  await writeFile(organizationPath, organization.content)
  const organizationDocument = validateOrganizationDocument(
    JSON.parse(await readFile(organizationPath, "utf8")),
  )
  const permissionsPath = path.join(
    workspace,
    ".digital-employee",
    "permissions.json",
  )
  await mkdir(path.dirname(permissionsPath), { recursive: true })
  await writeFile(
    permissionsPath,
    `${JSON.stringify(deriveOrganizationPermissions(organizationDocument), null, 2)}\n`,
  )
  return workspace
}

function envelope(workspace: string, positionId: string, turnId: string) {
  const body = {
    schemaVersion: TURN_ENVELOPE_VERSION,
    workspaceRef: workspace,
    positionId,
    turnId,
    input: { message: `run the ${positionId} acceptance task` },
    budget: { maxIterations: 2, maxContextBytes: 128 * 1024 },
  }
  return { ...body, envelopeDigest: computeEnvelopeDigest(body) }
}

test("E3: all four oss-maintainer packages execute through built-in engine", async (t) => {
  const workspace = await createMaterializedWorkspace()
  t.after(() => rm(workspace, { recursive: true, force: true }))

  for (const positionId of POSITIONS) {
    const turnId = `acceptance-${positionId}`
    const events: Array<Record<string, unknown>> = []
    const diagnostics: string[] = []
    let observedSlots: string[] = []
    let observedInstructions = ""

    const result = await runTurn({
      workspace,
      positionId,
      envelopeText: JSON.stringify(envelope(workspace, positionId, turnId)),
      model: {
        async complete(input) {
          observedSlots = input.blocks.map((block) => block.slot)
          observedInstructions = input.blocks
            .filter((block) => block.slot === "position_instructions")
            .map((block) => block.text)
            .join("\n")
          return { text: `completed ${positionId}` }
        },
      },
      writeEvent: (line) => events.push(JSON.parse(line)),
      writeDiagnostic: (line) => diagnostics.push(line),
    })

    assert.equal(result.exitCode, 0, diagnostics.join("\n"))
    assert.equal(result.terminalEmitted, true)
    assert.deepEqual(observedSlots, [
      "position_instructions",
      "position_spec",
      "turn_input",
    ])
    assert.match(observedInstructions, new RegExp(`name: ${positionId}`))
    assert.match(observedInstructions, /Package knowledge/)
    const terminals = events.filter(
      (event) => event.type === "run.completed" || event.type === "run.failed",
    )
    assert.equal(terminals.length, 1)
    assert.equal(terminals[0]!.type, "run.completed")

    const evidencePath = path.join(
      workspace,
      ".digital-employee",
      "evidence",
      positionId,
      `${turnId}.json`,
    )
    const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as Record<
      string,
      unknown
    >
    assert.equal(evidence.schemaVersion, "turn-evidence.v1")
    assert.equal(evidence.positionId, positionId)
    assert.equal(evidence.turnId, turnId)
    assert.deepEqual(evidence.terminal, {
      status: "completed",
      reason: "goal_met",
    })
    assert.equal(typeof evidence.inputDigest, "string")
    assert.equal(typeof evidence.outputDigest, "string")
    assert.equal(
      JSON.stringify(evidence).includes(`completed ${positionId}`),
      false,
    )
  }
})
