/**
 * Usability-sugar tests for `turn run --question` (add-only, no schema change):
 *
 * - AC-Q1: `--question` auto-builds a v1alpha2 envelope whose
 *   `envelopeDigest` matches the canonical body under
 *   `computeEnvelopeDigest`, i.e. the sugar path produces something that
 *   the digest-strict `parseTurnEnvelope` accepts identically to a
 *   hand-crafted envelope.
 * - AC-Q2: Combining `--question` with `--stdin` (or `--input-file`) is
 *   rejected before any envelope work with the shared
 *   `engine.input_invalid` vocabulary. Mixing sugar and raw input
 *   sources must fail closed.
 * - AC-Q3: Omitting `--question` keeps the original CLI surface exactly:
 *   with no input source at all the dispatcher still throws
 *   `turn_run_accepts_one_input_source`; with `--input-file` it still
 *   consumes and runs the caller-provided envelope byte-for-byte.
 */

import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { buildQuestionEnvelope, turn } from "../../apps/cli/turn/index.js"
import {
  computeEnvelopeDigest,
  parseTurnEnvelope,
  TURN_ENVELOPE_VERSION,
} from "../../apps/cli/turn/envelope.js"
import { runTurn } from "../../apps/cli/turn/turn-run.js"
import { createDeterministicModelPort } from "../../packages/engine/src/index.js"
import {
  OSS_MAINTAINER_TEMPLATE,
  renderOrganizationFile,
} from "../../apps/cli/workspace/templates.js"
import { validateOrganizationDocument } from "../../apps/cli/org/budget.js"
import { deriveOrganizationPermissions } from "../../apps/cli/org/permissions.js"

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "turn-run-q-ws-"))
  const digests: Record<
    string,
    { name: string; version: string; digest: string }
  > = {}
  for (const role of OSS_MAINTAINER_TEMPLATE.roles) {
    digests[role.id] = {
      name: role.id,
      version: "0.1.0",
      digest: `sha256:${"a".repeat(64)}`,
    }
  }
  const organization = renderOrganizationFile(
    OSS_MAINTAINER_TEMPLATE,
    "oss-maintainer",
    workspace,
    digests,
    "2026-08-23T00:00:00.000Z",
  )
  await mkdir(workspace, { recursive: true })
  await writeFile(
    path.join(workspace, organization.portablePath),
    organization.content,
  )
  await mkdir(path.join(workspace, "positions"), { recursive: true })
  const validated = validateOrganizationDocument(
    JSON.parse(new TextDecoder().decode(organization.content)),
  )
  const permissions = deriveOrganizationPermissions(validated)
  await mkdir(path.join(workspace, ".digital-employee"), { recursive: true })
  await writeFile(
    path.join(workspace, ".digital-employee", "permissions.json"),
    `${JSON.stringify(permissions, null, 2)}\n`,
  )
  return workspace
}

test("AC-Q1: --question auto-builds a digest-valid v1alpha2 envelope", () => {
  const envelope = buildQuestionEnvelope({
    workspace: "/tmp/some/workspace",
    positionId: "repo-owner",
    question: "summarize the open issues",
  })

  // The envelope is a full v1alpha2 body plus a matching envelopeDigest.
  assert.equal(envelope.schemaVersion, TURN_ENVELOPE_VERSION)
  assert.equal(envelope.positionId, "repo-owner")
  assert.equal(envelope.workspaceRef, path.resolve("/tmp/some/workspace"))
  assert.deepEqual(envelope.input, { message: "summarize the open issues" })
  assert.deepEqual(envelope.budget, { maxIterations: 12 })
  assert.equal(typeof envelope.turnId, "string")
  assert.ok((envelope.turnId as string).length > 0)
  assert.equal(typeof envelope.envelopeDigest, "string")

  // Recomputing the digest over the body (minus envelopeDigest) must
  // match — the sugar path uses exactly the digest gate every consumer
  // already trusts, no side vocabulary.
  const { envelopeDigest, ...body } = envelope as Record<string, unknown> & {
    envelopeDigest: string
  }
  assert.equal(computeEnvelopeDigest(body), envelopeDigest)

  // A digest-strict re-parse must accept it byte-for-byte, exactly like a
  // hand-crafted envelope.
  const parsed = parseTurnEnvelope(envelope)
  assert.equal(parsed.schemaVersion, TURN_ENVELOPE_VERSION)
  assert.equal(parsed.positionId, "repo-owner")
  assert.deepEqual(parsed.input, { message: "summarize the open issues" })
  assert.deepEqual(parsed.budget, { maxIterations: 12 })
})

test(
  "AC-Q1: --question envelope drives runTurn to a trusted terminal",
  async () => {
    const workspace = await createWorkspace()
    const envelope = buildQuestionEnvelope({
      workspace,
      positionId: "repo-owner",
      question: "list the top open issues",
    })
    const events: Array<Record<string, unknown>> = []
    const diagnostics: string[] = []
    const result = await runTurn({
      workspace,
      positionId: "repo-owner",
      envelopeText: JSON.stringify(envelope),
      model: createDeterministicModelPort(["all issues summarized"]),
      writeEvent: (line) => events.push(JSON.parse(line)),
      writeDiagnostic: (line) => diagnostics.push(line),
    })
    // Zero digest/envelope diagnostics: the sugar envelope must survive
    // the same gates as a hand-crafted one, no special-case allowlist.
    assert.equal(
      result.exitCode,
      0,
      `unexpected diagnostics: ${diagnostics.join("\n")}`,
    )
    assert.equal(result.terminalEmitted, true)
    const terminal = events.find((event) => event.type === "run.completed")
    assert.ok(terminal, "expected exactly one run.completed terminal")
  },
)

test(
  "AC-Q2: --question is mutually exclusive with --stdin and --input-file",
  async () => {
    // Combined --question + --stdin
    await assert.rejects(
      turn({
        subcommand: "run",
        args: ["/tmp/does-not-need-to-exist"],
        position: "repo-owner",
        stdin: true,
        question: "hello",
      }),
      (error: unknown) =>
        error instanceof TypeError &&
        error.message.startsWith("engine.input_invalid"),
      "combining --question with --stdin must surface as engine.input_invalid",
    )

    // Combined --question + --input-file (path never opened because the
    // guard fails first — that is the whole point of failing closed
    // before any consumption).
    await assert.rejects(
      turn({
        subcommand: "run",
        args: ["/tmp/does-not-need-to-exist"],
        position: "repo-owner",
        inputFile: "/tmp/nope.json",
        question: "hello",
      }),
      (error: unknown) =>
        error instanceof TypeError &&
        error.message.startsWith("engine.input_invalid"),
      "combining --question with --input-file must surface as engine.input_invalid",
    )
  },
)

test(
  "AC-Q3: omitting --question keeps the original no-input-source failure",
  async () => {
    await assert.rejects(
      turn({
        subcommand: "run",
        args: ["/tmp/does-not-need-to-exist"],
        position: "repo-owner",
      }),
      (error: unknown) =>
        error instanceof TypeError &&
        error.message === "turn_run_accepts_one_input_source",
      "omitting all input sources must still throw the pre-existing error",
    )
  },
)

test(
  "AC-Q3: --input-file without --question still consumes the caller envelope byte-for-byte",
  async () => {
    const workspace = await createWorkspace()
    const body: Record<string, unknown> = {
      schemaVersion: TURN_ENVELOPE_VERSION,
      workspaceRef: workspace,
      positionId: "repo-owner",
      turnId: "turn-legacy-1",
      input: "raw envelope path stays sealed",
      budget: { maxIterations: 2 },
    }
    const sealed = { ...body, envelopeDigest: computeEnvelopeDigest(body) }
    const envelopePath = path.join(workspace, "envelope.json")
    await writeFile(envelopePath, JSON.stringify(sealed))

    // Route the deterministic port through the environment allowlist so
    // this exercise still flows through the same resolveModelPort gate
    // production consumers hit.
    const previousModel = process.env.DIGITAL_EMPLOYEE_ENGINE_MODEL
    const previousScript = process.env.DIGITAL_EMPLOYEE_ENGINE_MODEL_SCRIPT
    process.env.DIGITAL_EMPLOYEE_ENGINE_MODEL = "deterministic"
    process.env.DIGITAL_EMPLOYEE_ENGINE_MODEL_SCRIPT = JSON.stringify([
      "raw envelope executed",
    ])
    const previousExitCode = process.exitCode
    // Silence the engine NDJSON stream for the duration of this call:
    // the test asserts on process.exitCode and does not need to inspect
    // events, and letting them leak would clutter the test runner output.
    const originalWrite = process.stdout.write.bind(process.stdout)
    ;(process.stdout as unknown as { write: (chunk: unknown) => boolean }).write =
      () => true
    try {
      await turn({
        subcommand: "run",
        args: [workspace],
        position: "repo-owner",
        inputFile: envelopePath,
      })
      assert.equal(process.exitCode, 0, "raw --input-file path must still exit 0")
    } finally {
      ;(
        process.stdout as unknown as { write: typeof originalWrite }
      ).write = originalWrite
      process.exitCode = previousExitCode
      if (previousModel === undefined) {
        delete process.env.DIGITAL_EMPLOYEE_ENGINE_MODEL
      } else {
        process.env.DIGITAL_EMPLOYEE_ENGINE_MODEL = previousModel
      }
      if (previousScript === undefined) {
        delete process.env.DIGITAL_EMPLOYEE_ENGINE_MODEL_SCRIPT
      } else {
        process.env.DIGITAL_EMPLOYEE_ENGINE_MODEL_SCRIPT = previousScript
      }
    }
  },
)
