import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rename, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  InlineAgentProjectionError,
  readInlineAgentAssets,
} from "../../apps/cli/inline-agent-projection.js"
import type { AgentHostRunRequest } from "../../packages/core/src/agent-host.js"

function request(
  directory: string,
  workspaceFiles: string[],
  read: string[] = ["./knowledge/**"],
): AgentHostRunRequest {
  return {
    runId: "projection-run",
    employeeId: "projection-employee",
    workingDirectory: directory,
    workspaceFiles,
    prompt: "fixture",
    policy: {
      tools: { default: "deny", allow: [] },
      filesystem: { read, write: [] },
      network: { mode: "deny" },
      approval: { mode: "never" },
    },
  }
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "employee-inline-assets-"))
  await Promise.all([
    mkdir(path.join(root, "knowledge")),
    mkdir(path.join(root, "evals")),
  ])
  await Promise.all([
    writeFile(path.join(root, "knowledge", "guide.md"), "approved guide"),
    writeFile(path.join(root, "evals", "cases.json"), "private eval"),
  ])
  return root
}

test("inline projection reads only explicit assets inside read grants", async () => {
  const root = await fixtureRoot()
  const assets = await readInlineAgentAssets(
    request(root, ["./knowledge/guide.md", "./evals/cases.json"]),
  )

  assert.deepEqual(assets, [
    {
      path: "./knowledge/guide.md",
      mediaType: "text/plain;charset=utf-8",
      byteLength: Buffer.byteLength("approved guide"),
      sha256: createHash("sha256").update("approved guide").digest("hex"),
      content: "approved guide",
    },
  ])
})

test("inline projection rejects symlinks and non-UTF-8 assets", async (t) => {
  if (process.platform === "win32") return t.skip("symlink fixture is POSIX-only")
  const root = await fixtureRoot()
  await symlink(
    path.join(root, "evals", "cases.json"),
    path.join(root, "knowledge", "escape.md"),
  )

  await assert.rejects(
    readInlineAgentAssets(request(root, ["./knowledge/escape.md"])),
    (error: unknown) =>
      error instanceof InlineAgentProjectionError &&
      error.code === "projection_symlink_denied",
  )

  await writeFile(
    path.join(root, "knowledge", "binary.dat"),
    Buffer.from([0xc3, 0x28]),
  )
  await assert.rejects(
    readInlineAgentAssets(request(root, ["./knowledge/binary.dat"])),
    (error: unknown) =>
      error instanceof InlineAgentProjectionError &&
      error.code === "projection_utf8_required",
  )

  await writeFile(path.join(root, "knowledge", "nul.txt"), "before\u0000after")
  await assert.rejects(
    readInlineAgentAssets(request(root, ["./knowledge/nul.txt"])),
    (error: unknown) =>
      error instanceof InlineAgentProjectionError &&
      error.code === "projection_text_nul_denied",
  )
})

test("inline projection detects a selected file changing before it is read", async () => {
  const root = await fixtureRoot()
  const selected = path.join(root, "knowledge", "guide.md")

  await assert.rejects(
    readInlineAgentAssets(
      request(root, ["./knowledge/guide.md"]),
      async () => writeFile(selected, "changed guide"),
    ),
    (error: unknown) =>
      error instanceof InlineAgentProjectionError &&
      error.code === "projection_changed_during_read",
  )
})

test("inline projection rejects an ancestor directory replaced by a symlink", async (t) => {
  if (process.platform === "win32") return t.skip("symlink fixture is POSIX-only")
  const root = await fixtureRoot()
  const knowledge = path.join(root, "knowledge")
  const original = path.join(root, "knowledge-original")
  const outside = await mkdtemp(path.join(os.tmpdir(), "employee-inline-outside-"))
  await writeFile(path.join(outside, "guide.md"), "outside guide")

  await assert.rejects(
    readInlineAgentAssets(
      request(root, ["./knowledge/guide.md"]),
      async () => {
        await rename(knowledge, original)
        await symlink(outside, knowledge)
      },
    ),
    (error: unknown) =>
      error instanceof InlineAgentProjectionError &&
      error.code === "projection_symlink_denied",
  )
})

test("inline projection rejects unsupported wildcard grants", async () => {
  const root = await fixtureRoot()
  await assert.rejects(
    readInlineAgentAssets(
      request(root, ["./knowledge/guide.md"], ["./knowledge/*.md"]),
    ),
    (error: unknown) =>
      error instanceof InlineAgentProjectionError &&
      error.code === "invalid_workspace_file",
  )
})

test("inline projection enforces duplicate and byte limits before launch", async () => {
  const root = await fixtureRoot()

  await assert.rejects(
    readInlineAgentAssets(
      request(root, ["./knowledge/guide.md", "./knowledge/guide.md"]),
    ),
    (error: unknown) =>
      error instanceof InlineAgentProjectionError &&
      error.code === "duplicate_workspace_file",
  )

  await writeFile(
    path.join(root, "knowledge", "oversized.txt"),
    Buffer.alloc(128 * 1024 + 1, 0x61),
  )
  await assert.rejects(
    readInlineAgentAssets(request(root, ["./knowledge/oversized.txt"])),
    (error: unknown) =>
      error instanceof InlineAgentProjectionError &&
      error.code === "projection_file_too_large",
  )
})
