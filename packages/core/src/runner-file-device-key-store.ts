/**
 * File-based Runner device key store.
 *
 * Layout:
 *   <dir>/keys.json          key records (0600)
 *   <dir>/keys/<keyId>.pem   Ed25519 private key, PKCS8 PEM (0600)
 *
 * Writes are atomic (tmp + rename). Directories are created 0700. The private
 * key never leaves this directory; the public SPKI is what enrollment sends.
 */

import {
  createPrivateKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto"
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises"
import path from "node:path"

import { CoreError } from "./contracts.js"
import type {
  DeviceKeyRecord,
  RunnerDeviceKeyStorePort,
} from "./runner-device.js"
import {
  RUNNER_DEVICE_MAX_HISTORY,
  deriveDeviceKeyId,
} from "./runner-device.js"

interface FileKeyStoreState {
  version: "runner-file-device-key-store.v1"
  records: DeviceKeyRecord[]
}

const STORE_VERSION = "runner-file-device-key-store.v1" as const

async function readJson(file: string): Promise<unknown | null> {
  try {
    const raw = await readFile(file, "utf8")
    return JSON.parse(raw) as unknown
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

async function atomicWrite(file: string, content: string, mode: number): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, content, { mode, flag: "wx" })
  try {
    await rename(tmp, file)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/**
 * File-backed device key store. All paths are derived inside the store
 * directory; the caller supplies only the directory.
 */
export class FileDeviceKeyStore implements RunnerDeviceKeyStorePort {
  readonly #directory: string

  constructor(directory: string) {
    if (!directory || typeof directory !== "string") {
      throw new CoreError("DEVICE_KEY_STORE_INVALID_PATH", "device key store directory required", {
        retryable: false,
      })
    }
    this.#directory = path.resolve(directory)
  }

  async #ensureDirectories(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 })
    await mkdir(path.join(this.#directory, "keys"), { recursive: true, mode: 0o700 })
  }

  async #loadState(): Promise<FileKeyStoreState> {
    await this.#ensureDirectories()
    const statePath = path.join(this.#directory, "keys.json")
    let raw: unknown | null
    try {
      raw = await readJson(statePath)
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new CoreError("DEVICE_KEY_STORE_CORRUPTED", "device key store state is corrupted", {
          retryable: false,
        })
      }
      throw error
    }
    if (raw === null) {
      return { version: STORE_VERSION, records: [] }
    }
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      (raw as { version?: unknown }).version !== STORE_VERSION ||
      !Array.isArray((raw as { records?: unknown }).records)
    ) {
      throw new CoreError("DEVICE_KEY_STORE_CORRUPTED", "device key store state is corrupted", {
        retryable: false,
      })
    }
    return raw as FileKeyStoreState
  }

  async #saveState(state: FileKeyStoreState): Promise<void> {
    await this.#ensureDirectories()
    const bounded: FileKeyStoreState = {
      version: STORE_VERSION,
      records: state.records.slice(-RUNNER_DEVICE_MAX_HISTORY),
    }
    await atomicWrite(
      path.join(this.#directory, "keys.json"),
      `${JSON.stringify(bounded, null, 2)}\n`,
      0o600,
    )
  }

  async loadActiveKey(): Promise<DeviceKeyRecord | null> {
    const state = await this.#loadState()
    const active = [...state.records]
      .reverse()
      .find((record) => record.status === "active")
    return active ? { ...active } : null
  }

  async loadKey(keyId: string): Promise<DeviceKeyRecord | null> {
    const state = await this.#loadState()
    const record = state.records.find((entry) => entry.keyId === keyId)
    return record ? { ...record } : null
  }

  async loadHistory(): Promise<DeviceKeyRecord[]> {
    const state = await this.#loadState()
    return state.records.map((record) => ({ ...record }))
  }

  async saveKey(record: DeviceKeyRecord): Promise<void> {
    const state = await this.#loadState()
    const index = state.records.findIndex((entry) => entry.keyId === record.keyId)
    if (index >= 0) {
      state.records[index] = { ...record }
    } else {
      state.records.push({ ...record })
    }
    await this.#saveState(state)
  }

  async loadPrivateKey(keyId: string): Promise<KeyObject | null> {
    const keyPath = path.join(this.#directory, "keys", `${this.#safeName(keyId)}.pem`)
    try {
      const pem = await readFile(keyPath, "utf8")
      return createPrivateKey(pem)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw new CoreError("DEVICE_KEY_STORE_FAILED", "failed to read device private key", {
        retryable: false,
      })
    }
  }

  async saveKeyPair(keyId: string, privateKey: KeyObject, _publicKey: KeyObject): Promise<void> {
    await this.#ensureDirectories()
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    const keyPath = path.join(this.#directory, "keys", `${this.#safeName(keyId)}.pem`)
    await atomicWrite(keyPath, pem, 0o600)
    // Belt-and-braces: some platforms honour the tmp file mode, not the rename target.
    await chmod(keyPath, 0o600)
  }

  async deletePrivateKey(keyId: string): Promise<void> {
    const keyPath = path.join(this.#directory, "keys", `${this.#safeName(keyId)}.pem`)
    await unlink(keyPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
  }

  #safeName(keyId: string): string {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(keyId)) {
      throw new CoreError("DEVICE_KEY_STORE_INVALID_KEY_ID", "invalid device keyId", {
        retryable: false,
      })
    }
    return keyId
  }
}

/**
 * Generates a fresh Ed25519 device key pair for enrollment.
 */
export function createDeviceKeyPair(): {
  keyId: string
  privateKey: KeyObject
  publicKey: KeyObject
  publicKeySpki: string
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const spki = publicKey.export({ type: "spki", format: "pem" }).toString()
  return {
    keyId: deriveDeviceKeyId(publicKey),
    privateKey,
    publicKey,
    publicKeySpki: spki,
  }
}
