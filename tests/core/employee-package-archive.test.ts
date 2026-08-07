import assert from "node:assert/strict"
import test from "node:test"

import {
  ARCHIVE_FORMAT_VERSION,
  ARCHIVE_META_NAME,
  ArchiveError,
  InMemoryInstallStore,
  inspectArchive,
  installArchive,
  packArchive,
  rollbackArchive,
  upgradeArchive,
  verifyArchive,
} from "../../packages/core/src/employee-package-archive.js"
import {
  EMPLOYEE_PACKAGE_SCHEMA_VERSION,
  EMPLOYEE_PACKAGE_MANIFEST_NAME,
} from "../../packages/core/src/employee-package.js"
import { AGENT_HOST_PROTOCOL_VERSION } from "../../packages/core/src/agent-host.js"

// ---------------------------------------------------------------------------
// Helpers: synthetic employee packages
// ---------------------------------------------------------------------------

function makeManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: EMPLOYEE_PACKAGE_SCHEMA_VERSION,
    name: "test-employee",
    version: "1.0.0",
    description: "A synthetic test employee",
    license: "MIT",
    authors: ["Test Author"],
    host: {
      protocol: AGENT_HOST_PROTOCOL_VERSION,
      requiredCapabilities: ["tool_allowlist"],
    },
    entrypoints: {
      skill: "./skill.js",
      inputSchema: "./input.json",
      outputSchema: "./output.json",
    },
    policy: {
      mode: "read_only",
      network: "deny",
      filesystem: { read: [], write: [] },
      mcpTools: [],
    },
    assets: [],
    ...overrides,
  }
}

function makeFiles(manifest: Record<string, unknown>): Array<{ path: string; bytes: Uint8Array }> {
  const files: Array<{ path: string; bytes: Uint8Array }> = [
    { path: "./skill.js", bytes: Buffer.from("export default function() {}") },
    { path: "./input.json", bytes: Buffer.from("{}") },
    { path: "./output.json", bytes: Buffer.from("{}") },
  ]
  const assets = (manifest.assets as string[]) ?? []
  for (const asset of assets) {
    if (!files.some((f) => f.path === asset)) {
      files.push({ path: asset, bytes: Buffer.from(`asset:${asset}`) })
    }
  }
  return files
}

function makeSyntheticPackageA() {
  const manifest = makeManifest({ name: "synth-alpha", version: "1.0.0" })
  return { manifest, files: makeFiles(manifest) }
}

function makeSyntheticPackageB() {
  const manifest = makeManifest({
    name: "synth-beta",
    version: "2.0.0",
    assets: ["./readme.txt"],
  })
  const files = makeFiles(manifest)
  return { manifest, files }
}

// ---------------------------------------------------------------------------
// Pack tests
// ---------------------------------------------------------------------------

test("pack produces deterministic output for same input", () => {
  const { manifest, files } = makeSyntheticPackageA()
  const result1 = packArchive({ manifest, files, createdAt: "2024-01-01T00:00:00.000Z" })
  const result2 = packArchive({ manifest, files, createdAt: "2024-01-01T00:00:00.000Z" })
  assert.deepEqual(result1.archive, result2.archive)
  assert.equal(result1.meta.packageDigest, result2.meta.packageDigest)
  assert.equal(result1.meta.archiveDigest, result2.meta.archiveDigest)
})

test("pack produces different output when bytes differ", () => {
  const { manifest, files } = makeSyntheticPackageA()
  const result1 = packArchive({ manifest, files })
  const altFiles = files.map((f) =>
    f.path === "./skill.js"
      ? { ...f, bytes: Buffer.from("export default function() { /* v2 */ }") }
      : f,
  )
  const result2 = packArchive({ manifest, files: altFiles })
  assert.notEqual(result1.meta.packageDigest, result2.meta.packageDigest)
})

test("pack rejects undeclared files", () => {
  const { manifest, files } = makeSyntheticPackageA()
  files.push({ path: "./extra.txt", bytes: Buffer.from("extra") })
  assert.throws(
    () => packArchive({ manifest, files }),
    (err: unknown) => err instanceof ArchiveError && err.code === "archive_undeclared_file",
  )
})

test("pack rejects missing declared files", () => {
  const manifest = makeManifest({ assets: ["./missing.txt"] })
  const files = makeFiles(makeManifest()) // no missing.txt
  assert.throws(
    () => packArchive({ manifest, files }),
    (err: unknown) => err instanceof ArchiveError && err.code === "archive_missing_declared_file",
  )
})

test("pack rejects files with secret patterns", () => {
  const manifest = makeManifest({ assets: ["./config/.env.local"] })
  const files = [
    ...makeFiles(makeManifest()),
    { path: "./config/.env.local", bytes: Buffer.from("SECRET=x") },
  ]
  assert.throws(
    () => packArchive({ manifest, files }),
    (err: unknown) => err instanceof ArchiveError && err.code === "archive_secret_detected",
  )
})

test("pack rejects path traversal", () => {
  const manifest = makeManifest()
  const files = [
    ...makeFiles(manifest),
    { path: "./../escape.txt", bytes: Buffer.from("bad") },
  ]
  assert.throws(
    () => packArchive({ manifest, files }),
    (err: unknown) =>
      err instanceof ArchiveError &&
      (err.code === "archive_invalid_path" || err.code === "archive_path_escape"),
  )
})

test("pack rejects duplicate files", () => {
  const { manifest, files } = makeSyntheticPackageA()
  files.push({ path: "./skill.js", bytes: Buffer.from("dup") })
  assert.throws(
    () => packArchive({ manifest, files }),
    (err: unknown) => err instanceof ArchiveError && err.code === "archive_duplicate_file",
  )
})

// ---------------------------------------------------------------------------
// Inspect tests
// ---------------------------------------------------------------------------

test("inspect returns metadata without executing code", () => {
  const { manifest, files } = makeSyntheticPackageA()
  const { archive, meta } = packArchive({ manifest, files })
  const result = inspectArchive(archive)
  assert.equal(result.meta.formatVersion, ARCHIVE_FORMAT_VERSION)
  assert.equal(result.meta.packageDigest, meta.packageDigest)
  assert.equal(result.manifest.name, "synth-alpha")
  assert.ok(result.files.includes("./skill.js"))
  assert.ok(result.totalBytes > 0)
})

test("inspect rejects corrupted archive", () => {
  assert.throws(
    () => inspectArchive(new Uint8Array([0, 0, 0, 0])),
    (err: unknown) => err instanceof ArchiveError,
  )
})

// ---------------------------------------------------------------------------
// Verify tests
// ---------------------------------------------------------------------------

test("verify passes for valid archive", () => {
  const { manifest, files } = makeSyntheticPackageA()
  const { archive } = packArchive({ manifest, files })
  const result = verifyArchive(archive)
  assert.equal(result.valid, true)
  assert.equal(result.errors.length, 0)
  assert.ok(result.packageDigest.startsWith("sha256:"))
  assert.ok(result.archiveDigest.startsWith("sha256:"))
})

test("verify detects tampered content", () => {
  const { manifest, files } = makeSyntheticPackageA()
  const { archive } = packArchive({ manifest, files })
  const tampered = new Uint8Array(archive)
  tampered[tampered.length - 2] ^= 0xff
  const result = verifyArchive(tampered)
  assert.equal(result.valid, false)
  assert.ok(result.errors.length > 0)
})

test("verify detects completely corrupt data", () => {
  const result = verifyArchive(new Uint8Array([1, 2, 3]))
  assert.equal(result.valid, false)
  assert.ok(result.errors.includes("archive_corrupt"))
})

// ---------------------------------------------------------------------------
// Install tests
// ---------------------------------------------------------------------------

test("install stores a valid archive", () => {
  const { manifest, files } = makeSyntheticPackageA()
  const { archive } = packArchive({ manifest, files })
  const store = new InMemoryInstallStore()
  const record = installArchive(archive, {
    store,
    installedAt: "2024-06-01T00:00:00.000Z",
  })
  assert.equal(record.employeeId, "synth-alpha")
  assert.equal(record.version, "1.0.0")
  assert.ok(record.packageDigest.startsWith("sha256:"))
  const current = store.getCurrent("synth-alpha")
  assert.ok(current)
  assert.equal(current!.version, "1.0.0")
})

test("install rejects tampered archive", () => {
  const { manifest, files } = makeSyntheticPackageA()
  const { archive } = packArchive({ manifest, files })
  const tampered = new Uint8Array(archive)
  tampered[tampered.length - 2] ^= 0xff
  const store = new InMemoryInstallStore()
  assert.throws(
    () => installArchive(tampered, { store }),
    (err: unknown) => err instanceof ArchiveError && err.code === "archive_install_verification_failed",
  )
})

// ---------------------------------------------------------------------------
// Upgrade tests
// ---------------------------------------------------------------------------

test("upgrade installs new version and keeps old version for rollback", () => {
  const store = new InMemoryInstallStore()

  const pkgA = makeSyntheticPackageA()
  const { archive: archiveV1 } = packArchive(pkgA)
  installArchive(archiveV1, { store, installedAt: "2024-01-01T00:00:00.000Z" })

  const manifestV2 = makeManifest({ name: "synth-alpha", version: "2.0.0" })
  const filesV2 = makeFiles(manifestV2).map((f) =>
    f.path === "./skill.js"
      ? { ...f, bytes: Buffer.from("export default function() { /* v2 */ }") }
      : f,
  )
  const { archive: archiveV2 } = packArchive({ manifest: manifestV2, files: filesV2 })
  const record = upgradeArchive(archiveV2, { store, installedAt: "2024-02-01T00:00:00.000Z" })

  assert.equal(record.version, "2.0.0")
  const current = store.getCurrent("synth-alpha")
  assert.equal(current!.version, "2.0.0")

  const v1 = store.get("synth-alpha", "1.0.0")
  assert.ok(v1)
})

test("upgrade rejects same digest", () => {
  const store = new InMemoryInstallStore()
  const pkgA = makeSyntheticPackageA()
  const { archive } = packArchive(pkgA)
  installArchive(archive, { store })
  assert.throws(
    () => upgradeArchive(archive, { store }),
    (err: unknown) => err instanceof ArchiveError && err.code === "archive_upgrade_same_digest",
  )
})

// ---------------------------------------------------------------------------
// Rollback tests
// ---------------------------------------------------------------------------

test("rollback reverts to a previously installed version", () => {
  const store = new InMemoryInstallStore()

  const pkgA = makeSyntheticPackageA()
  const { archive: archiveV1 } = packArchive(pkgA)
  installArchive(archiveV1, { store, installedAt: "2024-01-01T00:00:00.000Z" })

  const manifestV2 = makeManifest({ name: "synth-alpha", version: "2.0.0" })
  const filesV2 = makeFiles(manifestV2).map((f) =>
    f.path === "./skill.js"
      ? { ...f, bytes: Buffer.from("export default function() { /* v2 */ }") }
      : f,
  )
  const { archive: archiveV2 } = packArchive({ manifest: manifestV2, files: filesV2 })
  upgradeArchive(archiveV2, { store })

  const rolled = rollbackArchive("synth-alpha", { store, targetVersion: "1.0.0" })
  assert.equal(rolled.version, "1.0.0")
  const current = store.getCurrent("synth-alpha")
  assert.equal(current!.version, "1.0.0")
})

test("rollback rejects non-existent target version", () => {
  const store = new InMemoryInstallStore()
  assert.throws(
    () => rollbackArchive("synth-alpha", { store, targetVersion: "9.9.9" }),
    (err: unknown) => err instanceof ArchiveError && err.code === "archive_rollback_target_not_found",
  )
})

test("rollback rejects rollback to already-current version", () => {
  const store = new InMemoryInstallStore()
  const pkgA = makeSyntheticPackageA()
  const { archive } = packArchive(pkgA)
  installArchive(archive, { store })
  assert.throws(
    () => rollbackArchive("synth-alpha", { store, targetVersion: "1.0.0" }),
    (err: unknown) => err instanceof ArchiveError && err.code === "archive_rollback_already_current",
  )
})

// ---------------------------------------------------------------------------
// Full lifecycle: two synthetic packages, all six operations
// ---------------------------------------------------------------------------

test("full offline lifecycle for synthetic package A (synth-alpha)", () => {
  const store = new InMemoryInstallStore()
  const { manifest, files } = makeSyntheticPackageA()

  // 1. Pack
  const packed = packArchive({ manifest, files })
  assert.ok(packed.archive.length > 0)

  // 2. Inspect
  const inspected = inspectArchive(packed.archive)
  assert.equal(inspected.manifest.name, "synth-alpha")

  // 3. Verify
  const verified = verifyArchive(packed.archive)
  assert.equal(verified.valid, true)

  // 4. Install
  const installed = installArchive(packed.archive, { store })
  assert.equal(installed.employeeId, "synth-alpha")

  // 5. Upgrade
  const manifestV2 = makeManifest({ name: "synth-alpha", version: "1.1.0" })
  const filesV2 = makeFiles(manifestV2).map((f) =>
    f.path === "./skill.js"
      ? { ...f, bytes: Buffer.from("// upgraded") }
      : f,
  )
  const packedV2 = packArchive({ manifest: manifestV2, files: filesV2 })
  const upgraded = upgradeArchive(packedV2.archive, { store })
  assert.equal(upgraded.version, "1.1.0")

  // 6. Rollback
  const rolledBack = rollbackArchive("synth-alpha", { store, targetVersion: "1.0.0" })
  assert.equal(rolledBack.version, "1.0.0")
  assert.equal(store.getCurrent("synth-alpha")!.version, "1.0.0")
})

test("full offline lifecycle for synthetic package B (synth-beta)", () => {
  const store = new InMemoryInstallStore()
  const { manifest, files } = makeSyntheticPackageB()

  // 1. Pack
  const packed = packArchive({ manifest, files })
  assert.ok(packed.archive.length > 0)

  // 2. Inspect
  const inspected = inspectArchive(packed.archive)
  assert.equal(inspected.manifest.name, "synth-beta")
  assert.ok(inspected.files.includes("./readme.txt"))

  // 3. Verify
  const verified = verifyArchive(packed.archive)
  assert.equal(verified.valid, true)

  // 4. Install
  const installed = installArchive(packed.archive, { store })
  assert.equal(installed.employeeId, "synth-beta")

  // 5. Upgrade
  const manifestV3 = makeManifest({
    name: "synth-beta",
    version: "3.0.0",
    assets: ["./readme.txt"],
  })
  const filesV3 = makeFiles(manifestV3).map((f) =>
    f.path === "./skill.js"
      ? { ...f, bytes: Buffer.from("// v3") }
      : f,
  )
  const packedV3 = packArchive({ manifest: manifestV3, files: filesV3 })
  const upgraded = upgradeArchive(packedV3.archive, { store })
  assert.equal(upgraded.version, "3.0.0")

  // 6. Rollback
  const rolledBack = rollbackArchive("synth-beta", { store, targetVersion: "2.0.0" })
  assert.equal(rolledBack.version, "2.0.0")
  assert.equal(store.getCurrent("synth-beta")!.version, "2.0.0")
})

// ---------------------------------------------------------------------------
// Runner resolves by immutable identity/version/digest
// ---------------------------------------------------------------------------

test("Runner resolves installed release by immutable identity/version/digest", () => {
  const store = new InMemoryInstallStore()
  const { manifest, files } = makeSyntheticPackageA()
  const { archive } = packArchive({ manifest, files })
  const record = installArchive(archive, { store })

  const byId = store.getCurrent("synth-alpha")
  assert.ok(byId)
  assert.equal(byId!.employeeId, "synth-alpha")

  const byVersion = store.get("synth-alpha", "1.0.0")
  assert.ok(byVersion)
  assert.equal(byVersion!.packageDigest, record.packageDigest)

  assert.ok(record.packageDigest.startsWith("sha256:"))
  assert.ok(record.archiveDigest.startsWith("sha256:"))
})

// ---------------------------------------------------------------------------
// Security: symlinks / path escapes rejected
// ---------------------------------------------------------------------------

test("archive rejects paths with backslashes", () => {
  const manifest = makeManifest()
  const files: Array<{ path: string; bytes: Uint8Array }> = [
    ...makeFiles(manifest),
    { path: "./dir\\file.txt", bytes: Buffer.from("x") },
  ]
  assert.throws(
    () => packArchive({ manifest, files }),
    (err: unknown) => err instanceof ArchiveError && err.code === "archive_invalid_path",
  )
})

test("archive rejects control characters in paths", () => {
  const manifest = makeManifest()
  const files: Array<{ path: string; bytes: Uint8Array }> = [
    ...makeFiles(manifest),
    { path: "./file\x01.txt", bytes: Buffer.from("x") },
  ]
  assert.throws(
    () => packArchive({ manifest, files }),
    (err: unknown) => err instanceof ArchiveError && err.code === "archive_invalid_path",
  )
})

// ---------------------------------------------------------------------------
// Platform-independent: entry order does not affect digest
// ---------------------------------------------------------------------------

test("file order does not affect archive digest", () => {
  const { manifest, files } = makeSyntheticPackageA()
  const result1 = packArchive({ manifest, files })
  const result2 = packArchive({ manifest, files: [...files].reverse() })
  assert.equal(result1.meta.packageDigest, result2.meta.packageDigest)
  assert.equal(result1.meta.archiveDigest, result2.meta.archiveDigest)
  assert.deepEqual(result1.archive, result2.archive)
})
