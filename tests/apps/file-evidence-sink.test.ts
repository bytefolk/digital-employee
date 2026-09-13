import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  createFileEvidenceSink,
  FileEvidenceSinkError,
} from "../../apps/cli/turn/file-evidence-sink.js"
import type { TurnEvidenceRecord } from "../../packages/engine/src/turn-evidence.js"

function digest(seed: string): string {
  return createHash("sha256").update(seed, "utf8").digest("hex")
}

function record(overrides: Partial<TurnEvidenceRecord> = {}): TurnEvidenceRecord {
  return {
    schemaVersion: "turn-evidence.v1",
    evidenceId: "evidence-1",
    workspaceRef: "/tmp/workspace",
    positionId: "repo-owner",
    turnId: "turn-1",
    runId: "run-1",
    engineVersion: "0.1.0",
    inputDigest: digest("input"),
    outputDigest: digest("output"),
    budget: {
      turn: { iterationsUsed: 1, tokensUsed: 2, maxIterations: 4, maxTokens: 8 },
    },
    terminal: { status: "completed", reason: "completed" },
    assemblyManifestDigest: digest("assembly"),
    timeBounds: {
      startedAt: "2026-09-05T00:00:00.000Z",
      completedAt: "2026-09-05T00:00:01.000Z",
    },
    ...overrides,
  }
}

async function mode(filePath: string): Promise<number> {
  return (await lstat(filePath)).mode & 0o777
}

function sinkError(error: unknown): FileEvidenceSinkError {
  assert.equal(error instanceof FileEvidenceSinkError, true)
  return error as FileEvidenceSinkError
}

test("writes a digest-only record atomically below the selected root", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "file-evidence-sink-"))
  const root = path.join(parent, "evidence")
  const sink = createFileEvidenceSink(root)

  await sink.write(record())

  const filePath = path.join(root, "repo-owner", "turn-1.json")
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), record())
  assert.equal(await mode(root), 0o700)
  assert.equal(await mode(path.join(root, "repo-owner")), 0o700)
  assert.equal(await mode(filePath), 0o600)
  await rm(parent, { recursive: true, force: true })
})

test("does not change permissions on existing ancestors outside the evidence root", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "file-evidence-ancestor-"))
  await chmod(parent, 0o755)
  const root = path.join(parent, "evidence")

  await createFileEvidenceSink(root).write(record())

  assert.equal(await mode(parent), 0o755)
  assert.equal(await mode(root), 0o700)
  await rm(parent, { recursive: true, force: true })
})

test("same turn is idempotent, but different evidence cannot overwrite it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "file-evidence-duplicate-"))
  const sink = createFileEvidenceSink(root)
  const first = record()
  await sink.write(first)
  const filePath = path.join(root, "repo-owner", "turn-1.json")
  const before = await readFile(filePath, "utf8")

  await sink.write({ ...first })
  assert.equal(await readFile(filePath, "utf8"), before)
  await assert.rejects(
    () => sink.write(record({ outputDigest: digest("different") })),
    (error: unknown) => sinkError(error).code === "file_evidence_turn_duplicate",
  )
  assert.equal(await readFile(filePath, "utf8"), before)
  await rm(root, { recursive: true, force: true })
})

test("rejects a symlinked root, position directory, or target", async (t) => {
  if (process.platform === "win32") return t.skip("symlink fixture is POSIX-only")
  const parent = await mkdtemp(path.join(os.tmpdir(), "file-evidence-symlink-"))
  const outside = path.join(parent, "outside")
  await mkdir(outside)

  const rootLink = path.join(parent, "root-link")
  await symlink(outside, rootLink, "dir")
  await assert.rejects(
    () => createFileEvidenceSink(rootLink).write(record()),
    (error: unknown) => sinkError(error).code === "file_evidence_root_symlink",
  )

  const root = path.join(parent, "root")
  await mkdir(root)
  const positionLink = path.join(root, "repo-owner")
  await symlink(outside, positionLink, "dir")
  await assert.rejects(
    () => createFileEvidenceSink(root).write(record()),
    (error: unknown) => sinkError(error).code === "file_evidence_position_symlink",
  )
  await rm(positionLink)

  const sink = createFileEvidenceSink(root)
  const target = path.join(root, "repo-owner", "turn-1.json")
  await mkdir(path.dirname(target))
  await symlink(path.join(outside, "target.json"), target, "file")
  await assert.rejects(
    () => sink.write(record()),
    (error: unknown) => sinkError(error).code === "file_evidence_target_symlink",
  )
  assert.equal(await lstat(path.join(outside, "target.json")).then(() => true).catch(() => false), false)
  await rm(parent, { recursive: true, force: true })
})

test("rejects traversal, separators, controls, and unbounded ids before writing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "file-evidence-path-"))
  const sink = createFileEvidenceSink(root)
  const badIds = ["", ".", "..", "../escape", "nested/turn", "nested\\turn", "bad\u0000id", "x".repeat(201)]
  for (const positionId of badIds) {
    await assert.rejects(
      () => sink.write(record({ positionId })),
      (error: unknown) =>
        sinkError(error).code === "file_evidence_position_invalid",
    )
  }
  for (const turnId of badIds) {
    await assert.rejects(
      () => sink.write(record({ turnId })),
      (error: unknown) => sinkError(error).code === "file_evidence_turn_invalid",
    )
  }
  assert.deepEqual(await readdir(root), [])
  await rm(root, { recursive: true, force: true })
})

test("existing non-regular targets fail closed without replacement", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "file-evidence-target-"))
  const position = path.join(root, "repo-owner")
  await mkdir(position)
  const target = path.join(position, "turn-1.json")
  await mkdir(target)

  const sink = createFileEvidenceSink(root)
  await assert.rejects(
    () => sink.write(record()),
    (error: unknown) => sinkError(error).code === "file_evidence_target_not_regular",
  )
  await chmod(root, 0o755)
  await assert.rejects(
    () => sink.write(record()),
    (error: unknown) => sinkError(error).code === "file_evidence_target_not_regular",
  )
  assert.equal(await mode(root), 0o700)
  await rm(root, { recursive: true, force: true })
})
