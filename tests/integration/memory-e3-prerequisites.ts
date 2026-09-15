import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"

export interface MemoryE3Configuration {
  baseUrl: string
  pinnedRevision: string
  artifactUrl: string
  artifactPath: string
  artifactSha256: string
}

// Opting in must never silently select a developer's existing mem service.
// Validation errors deliberately omit environment values and local paths.
export function memoryE3Configuration(env: NodeJS.ProcessEnv): MemoryE3Configuration {
  if (env.MEMORY_E3_DISPOSABLE !== "1") {
    throw new Error("MEMORY_E3_DISPOSABLE_REQUIRED")
  }
  const required = (name: string): string => {
    const value = env[name]
    if (!value) throw new Error(`${name}_REQUIRED`)
    return value
  }
  const baseUrl = required("MEMORY_E3_BASE_URL")
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(baseUrl)) {
    throw new Error("MEMORY_E3_LOOPBACK_URL_REQUIRED")
  }
  try {
    new URL(baseUrl)
  } catch {
    throw new Error("MEMORY_E3_LOOPBACK_URL_REQUIRED")
  }
  const pinnedRevision = required("MEM_HTTP_PINNED_REVISION")
  // This value is printed in the public receipt: accept only a release
  // version or full Git revision, never arbitrary environment text.
  if (!/^(?:[a-f0-9]{40}|v?[0-9]+\.[0-9]+\.[0-9]+(?:-rc\.[0-9]+)?)$/.test(pinnedRevision)) {
    throw new Error("MEMORY_E3_RELEASE_VERSION_REQUIRED")
  }
  const artifactUrl = required("MEMORY_E3_ARTIFACT_URL")
  if (!/^https:\/\/github\.com\/bytefolk\/mem\/releases\/download\/v[0-9]+\.[0-9]+\.[0-9]+(?:-rc\.[0-9]+)?\/memd-[A-Za-z0-9._-]+$/.test(artifactUrl)) {
    throw new Error("MEMORY_E3_RELEASE_SERVER_ARTIFACT_REQUIRED")
  }
  const artifactPath = required("MEMORY_E3_ARTIFACT_PATH")
  const artifactSha256 = required("MEMORY_E3_ARTIFACT_SHA256")
  if (!/^[a-f0-9]{64}$/.test(artifactSha256)) {
    throw new Error("MEMORY_E3_ARTIFACT_SHA256_INVALID")
  }
  return { baseUrl, pinnedRevision, artifactUrl, artifactPath, artifactSha256 }
}

export async function verifyMemoryE3Artifact(config: MemoryE3Configuration): Promise<void> {
  const hash = createHash("sha256")
  try {
    for await (const chunk of createReadStream(config.artifactPath)) hash.update(chunk)
  } catch {
    throw new Error("MEMORY_E3_ARTIFACT_UNREADABLE")
  }
  if (hash.digest("hex") !== config.artifactSha256) {
    throw new Error("MEMORY_E3_ARTIFACT_DIGEST_MISMATCH")
  }
}

export function verifyMemoryE3Version(body: Record<string, unknown>, expected: string): void {
  if (Object.keys(body).length !== 1 || typeof body.version !== "string") {
    throw new Error("MEMORY_CONTRACT_UNSUPPORTED")
  }
  if (body.version !== expected) throw new Error("MEMORY_REVISION_MISMATCH")
}
