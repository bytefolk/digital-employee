/**
 * Tests for the file-backed Runner device key store and key-pair factory.
 */

import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { CoreError } from "../../packages/core/src/contracts.js"
import { deriveDeviceKeyId } from "../../packages/core/src/runner-device.js"
import type { DeviceKeyRecord } from "../../packages/core/src/runner-device.js"
import {
  FileDeviceKeyStore,
  createDeviceKeyPair,
} from "../../packages/core/src/runner-file-device-key-store.js"

async function tmpDir(t: test.TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "device-key-store-"))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

function record(keyId: string, overrides?: Partial<DeviceKeyRecord>): DeviceKeyRecord {
  return {
    keyId,
    status: "active",
    activeSince: "2026-08-04T00:00:00.000Z",
    ...overrides,
  }
}

test("createDeviceKeyPair derives keyId from the public key", () => {
  const pair = createDeviceKeyPair()
  assert.ok(pair.keyId.startsWith("device:"))
  assert.equal(pair.keyId, deriveDeviceKeyId(pair.publicKey))
  assert.match(pair.publicKeySpki, /BEGIN PUBLIC KEY/)
})

test("saveKeyPair/loadPrivateKey round-trip preserves key material", async (t) => {
  const dir = await tmpDir(t)
  const store = new FileDeviceKeyStore(dir)
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")

  await store.saveKeyPair("device:test-1", privateKey, publicKey)

  const loaded = await store.loadPrivateKey("device:test-1")
  assert.ok(loaded)
  assert.equal(
    loaded.export({ type: "pkcs8", format: "pem" }).toString(),
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  )
})

test("loadPrivateKey returns null when key is missing", async (t) => {
  const dir = await tmpDir(t)
  const store = new FileDeviceKeyStore(dir)
  assert.equal(await store.loadPrivateKey("device:missing"), null)
})

test("saveKey/loadActiveKey/loadKey/loadHistory round-trip", async (t) => {
  const dir = await tmpDir(t)
  const store = new FileDeviceKeyStore(dir)

  await store.saveKey(record("device:a"))
  await store.saveKey(record("device:b"))

  const active = await store.loadActiveKey()
  assert.equal(active?.keyId, "device:b")

  const loaded = await store.loadKey("device:a")
  assert.equal(loaded?.keyId, "device:a")
  assert.equal(await store.loadKey("device:missing"), null)

  const history = await store.loadHistory()
  assert.deepEqual(
    history.map((r) => r.keyId).sort(),
    ["device:a", "device:b"],
  )
})

test("revoked record is never returned as active", async (t) => {
  const dir = await tmpDir(t)
  const store = new FileDeviceKeyStore(dir)
  await store.saveKey(
    record("device:revoked", { status: "revoked", revokedAt: "2026-08-04T00:01:00.000Z" }),
  )
  assert.equal(await store.loadActiveKey(), null)
})

test("deletePrivateKey removes material and tolerates missing keys", async (t) => {
  const dir = await tmpDir(t)
  const store = new FileDeviceKeyStore(dir)
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  await store.saveKeyPair("device:gone", privateKey, publicKey)

  await store.deletePrivateKey("device:gone")
  assert.equal(await store.loadPrivateKey("device:gone"), null)
  // Deleting again must not throw
  await store.deletePrivateKey("device:gone")
})

test("key material and records persist across store instances", async (t) => {
  const dir = await tmpDir(t)
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const first = new FileDeviceKeyStore(dir)
  await first.saveKeyPair("device:persist", privateKey, publicKey)
  await first.saveKey(record("device:persist"))

  const second = new FileDeviceKeyStore(dir)
  assert.equal((await second.loadActiveKey())?.keyId, "device:persist")
  assert.ok(await second.loadPrivateKey("device:persist"))
})

test("private key files and state are written 0600 (POSIX)", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX file modes only")
    return
  }
  const dir = await tmpDir(t)
  const store = new FileDeviceKeyStore(dir)
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  await store.saveKeyPair("device:modes", privateKey, publicKey)
  await store.saveKey(record("device:modes"))

  const keyMode = (await stat(path.join(dir, "keys", "device:modes.pem"))).mode & 0o777
  const stateMode = (await stat(path.join(dir, "keys.json"))).mode & 0o777
  assert.equal(keyMode, 0o600)
  assert.equal(stateMode, 0o600)
  // The private key file is real PEM, not a placeholder
  assert.match(await readFile(path.join(dir, "keys", "device:modes.pem"), "utf8"), /BEGIN PRIVATE KEY/)
})

test("invalid keyId is rejected for all key material paths", async (t) => {
  const dir = await tmpDir(t)
  const store = new FileDeviceKeyStore(dir)
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")

  for (const op of [
    () => store.loadPrivateKey("../evil"),
    () => store.saveKeyPair("../evil", privateKey, publicKey),
    () => store.deletePrivateKey("../evil"),
  ]) {
    await assert.rejects(op, (err: unknown) => {
      assert.ok(err instanceof CoreError)
      assert.equal(err.code, "DEVICE_KEY_STORE_INVALID_KEY_ID")
      return true
    })
  }
})

test("corrupted state file is rejected", async (t) => {
  const dir = await tmpDir(t)
  const store = new FileDeviceKeyStore(dir)
  const statePath = path.join(dir, "keys.json")
  await store.saveKey(record("device:seed"))
  await writeFile(statePath, "{not json", "utf8")

  await assert.rejects(store.loadActiveKey(), (err: unknown) => {
    assert.ok(err instanceof CoreError)
    assert.equal(err.code, "DEVICE_KEY_STORE_CORRUPTED")
    return true
  })
})
