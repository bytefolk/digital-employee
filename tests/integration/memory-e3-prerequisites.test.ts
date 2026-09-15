import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"

import {
  memoryE3Configuration,
  verifyMemoryE3Artifact,
  verifyMemoryE3Version,
} from "./memory-e3-prerequisites.js"

// Synthetic metadata tests only; these never claim a server or release exists.
const valid = {
  MEMORY_E3_DISPOSABLE: "1",
  MEMORY_E3_BASE_URL: "http://127.0.0.1:18080",
  MEM_HTTP_PINNED_REVISION: "0.1.2",
  MEMORY_E3_ARTIFACT_URL: "https://github.com/bytefolk/mem/releases/download/v0.1.2/memd-linux-amd64",
  MEMORY_E3_ARTIFACT_PATH: "unused-synthetic-artifact",
  MEMORY_E3_ARTIFACT_SHA256: "a".repeat(64),
}

test("live lane requires explicit isolation and every release input without echoing values", () => {
  for (const name of Object.keys(valid)) {
    const env: NodeJS.ProcessEnv = { ...valid }
    delete env[name]
    assert.throws(() => memoryE3Configuration(env), { message: `${name}_REQUIRED` })
  }
  assert.equal(memoryE3Configuration(valid).pinnedRevision, "0.1.2")
})

test("live lane rejects remote, credential-bearing and invalid endpoint forms", () => {
  for (const baseUrl of [
    "https://mem.example.com", "http://localhost:8080", "http://127.0.0.1:65536",
    "http://127.0.0.1:8080/path", "http://127.0.0.1:8080?token=sentinel",
    "http://sentinel@127.0.0.1:8080", "http://127.0.0.1:0",
  ]) {
    assert.throws(
      () => memoryE3Configuration({ ...valid, MEMORY_E3_BASE_URL: baseUrl }),
      { message: "MEMORY_E3_LOOPBACK_URL_REQUIRED" },
    )
  }
})

test("live lane rejects MCP clients, source archives and unversioned artifacts", () => {
  for (const url of [
    valid.MEMORY_E3_ARTIFACT_URL.replace("memd-", "mem-mcp-"),
    valid.MEMORY_E3_ARTIFACT_URL.replace("/v0.1.2/", "/latest/"),
    "https://github.com/bytefolk/mem/archive/refs/tags/v0.1.1.tar.gz",
    `${valid.MEMORY_E3_ARTIFACT_URL}?token=sentinel`,
  ]) {
    assert.throws(
      () => memoryE3Configuration({ ...valid, MEMORY_E3_ARTIFACT_URL: url }),
      { message: "MEMORY_E3_RELEASE_SERVER_ARTIFACT_REQUIRED" },
    )
  }
  for (const revision of ["dev", "unexpected-environment-value"]) {
    assert.throws(
      () => memoryE3Configuration({ ...valid, MEM_HTTP_PINNED_REVISION: revision }),
      { message: "MEMORY_E3_RELEASE_VERSION_REQUIRED" },
    )
  }
  for (const revision of ["a".repeat(40), "v0.1.2-rc.1"]) {
    assert.equal(memoryE3Configuration({ ...valid, MEM_HTTP_PINNED_REVISION: revision }).pinnedRevision,
      revision)
  }
  assert.throws(
    () => memoryE3Configuration({ ...valid, MEMORY_E3_ARTIFACT_SHA256: "invalid" }),
    { message: "MEMORY_E3_ARTIFACT_SHA256_INVALID" },
  )
})

test("live lane verifies actual artifact bytes and rejects a digest mismatch", async (t) => {
  await mkdir(".cache", { recursive: true })
  const directory = await mkdtemp(path.resolve(".cache/memory-artifact-test-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const artifactPath = path.join(directory, "synthetic")
  await writeFile(artifactPath, "synthetic artifact, not a mem server")
  const config = {
    ...memoryE3Configuration(valid),
    artifactPath,
    artifactSha256: createHash("sha256").update("synthetic artifact, not a mem server").digest("hex"),
  }
  await verifyMemoryE3Artifact(config)
  await assert.rejects(verifyMemoryE3Artifact({ ...config, artifactSha256: "b".repeat(64) }),
    { message: "MEMORY_E3_ARTIFACT_DIGEST_MISMATCH" })
  await assert.rejects(verifyMemoryE3Artifact({ ...config, artifactPath: path.join(directory, "missing") }),
    { message: "MEMORY_E3_ARTIFACT_UNREADABLE" })
})

test("live lane checks the adapter's exact version contract before provisioning", () => {
  verifyMemoryE3Version({ version: "0.1.2" }, "0.1.2")
  assert.throws(() => verifyMemoryE3Version({ version: "0.1.1" }, "0.1.2"),
    { message: "MEMORY_REVISION_MISMATCH" })
  for (const body of [{ version: "0.1.2", git_revision: "candidate" }, { version: 12 }, {}]) {
    assert.throws(() => verifyMemoryE3Version(body, "0.1.2"),
      { message: "MEMORY_CONTRACT_UNSUPPORTED" })
  }
})
