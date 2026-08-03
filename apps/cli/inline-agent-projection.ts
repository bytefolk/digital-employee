import { constants } from "node:fs"
import type { BigIntStats } from "node:fs"
import { createHash } from "node:crypto"
import { lstat, open, realpath } from "node:fs/promises"
import path from "node:path"
import { TextDecoder } from "node:util"

import type { AgentHostRunRequest } from "../../packages/core/src/agent-host.js"

const MAX_PROJECTED_FILES = 128
const MAX_PROJECTED_FILE_BYTES = 128 * 1024
const MAX_PROJECTED_TOTAL_BYTES = 256 * 1024
const PORTABLE_EXACT_PATH =
  /^\.\/(?!.*\\)[^\u0000-\u001f\u007f*?[\]{}!]+$/

interface ProjectionFile {
  portablePath: string
  sourcePath: string
  device: bigint
  inode: bigint
  size: bigint
  ctimeNs: bigint
}

interface ProjectionInspection {
  sourceRoot: string
  rootDevice: bigint
  rootInode: bigint
  files: ProjectionFile[]
}

export interface InlineAgentAsset {
  path: string
  mediaType: "text/plain;charset=utf-8"
  byteLength: number
  sha256: string
  content: string
}

export class InlineAgentProjectionError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "InlineAgentProjectionError"
  }
}

function portableSegments(value: string): string[] {
  if (!PORTABLE_EXACT_PATH.test(value)) {
    throw new InlineAgentProjectionError("invalid_workspace_file")
  }
  const segments = value.slice(2).split("/")
  if (
    segments.length === 0 ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new InlineAgentProjectionError("invalid_workspace_file")
  }
  return segments
}

function validateReadGrant(value: string): void {
  const base = value.endsWith("/**") ? value.slice(0, -3) : value
  portableSegments(base)
  if (value !== base && !value.endsWith("/**")) {
    throw new InlineAgentProjectionError("unsupported_filesystem_grant")
  }
  if (value !== base && /[*?[\]{}!]/.test(base)) {
    throw new InlineAgentProjectionError("unsupported_filesystem_grant")
  }
}

function grantMatchesFile(grant: string, file: string): boolean {
  if (grant.endsWith("/**")) {
    return file.startsWith(grant.slice(0, -2))
  }
  return grant === file
}

function projectionIdentityMatches(
  stat: BigIntStats,
  file: ProjectionFile,
): boolean {
  return (
    stat.isFile() &&
    stat.dev === file.device &&
    stat.ino === file.inode &&
    stat.size === file.size &&
    stat.ctimeNs === file.ctimeNs
  )
}

async function inspectProjectionFiles(
  request: AgentHostRunRequest,
): Promise<ProjectionInspection> {
  const rootStat = await lstat(request.workingDirectory, { bigint: true })
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new InlineAgentProjectionError("working_directory_invalid")
  }
  const sourceRoot = await realpath(request.workingDirectory)
  const resolvedRootStat = await lstat(sourceRoot, { bigint: true })
  if (
    !resolvedRootStat.isDirectory() ||
    resolvedRootStat.dev !== rootStat.dev ||
    resolvedRootStat.ino !== rootStat.ino
  ) {
    throw new InlineAgentProjectionError("working_directory_changed")
  }
  for (const grant of request.policy.filesystem.read) validateReadGrant(grant)

  const requestedFiles = request.workspaceFiles ?? []
  if (requestedFiles.length > MAX_PROJECTED_FILES) {
    throw new InlineAgentProjectionError("projection_file_limit")
  }
  if (new Set(requestedFiles).size !== requestedFiles.length) {
    throw new InlineAgentProjectionError("duplicate_workspace_file")
  }

  const files: ProjectionFile[] = []
  let totalBytes = 0n
  for (const portablePath of requestedFiles) {
    const segments = portableSegments(portablePath)
    if (
      !request.policy.filesystem.read.some((grant) =>
        grantMatchesFile(grant, portablePath),
      )
    ) {
      continue
    }

    let current = sourceRoot
    for (const segment of segments) {
      current = path.join(current, segment)
      const stat = await lstat(current, { bigint: true })
      if (stat.isSymbolicLink()) {
        throw new InlineAgentProjectionError("projection_symlink_denied")
      }
    }
    const stat = await lstat(current, { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new InlineAgentProjectionError("projection_regular_file_required")
    }
    const canonicalFile = await realpath(current)
    if (canonicalFile !== current) {
      throw new InlineAgentProjectionError("projection_symlink_denied")
    }
    const canonicalStat = await lstat(canonicalFile, { bigint: true })
    if (
      canonicalStat.dev !== stat.dev ||
      canonicalStat.ino !== stat.ino ||
      canonicalStat.size !== stat.size ||
      canonicalStat.ctimeNs !== stat.ctimeNs
    ) {
      throw new InlineAgentProjectionError("projection_changed_during_read")
    }
    if (stat.size > BigInt(MAX_PROJECTED_FILE_BYTES)) {
      throw new InlineAgentProjectionError("projection_file_too_large")
    }
    totalBytes += stat.size
    if (totalBytes > BigInt(MAX_PROJECTED_TOTAL_BYTES)) {
      throw new InlineAgentProjectionError("projection_too_large")
    }
    files.push({
      portablePath,
      sourcePath: current,
      device: stat.dev,
      inode: stat.ino,
      size: stat.size,
      ctimeNs: stat.ctimeNs,
    })
  }
  return {
    sourceRoot,
    rootDevice: rootStat.dev,
    rootInode: rootStat.ino,
    files,
  }
}

/**
 * Reads only manifest-selected, policy-allowed UTF-8 assets into a bounded
 * data-encoded bundle. Agent hosts receive this bundle as untrusted task data and are launched
 * with an empty native tool surface, so they never need filesystem access.
 */
export async function readInlineAgentAssets(
  request: AgentHostRunRequest,
  beforeOpen?: (sourcePath: string) => Promise<void>,
): Promise<InlineAgentAsset[]> {
  const inspection = await inspectProjectionFiles(request)
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const assets: InlineAgentAsset[] = []

  for (const file of inspection.files) {
    await beforeOpen?.(file.sourcePath)
    const handle = await open(
      file.sourcePath,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW || 0) |
        (constants.O_NONBLOCK || 0),
    )
    try {
      if ((await realpath(file.sourcePath)) !== file.sourcePath) {
        throw new InlineAgentProjectionError("projection_symlink_denied")
      }
      const before = await handle.stat({ bigint: true })
      if (!projectionIdentityMatches(before, file)) {
        throw new InlineAgentProjectionError("projection_changed_during_read")
      }
      // Read at most the inspected size plus one sentinel byte. `readFile()`
      // can otherwise allocate past the projection limit if a concurrently
      // modified regular file keeps growing after the initial stat.
      const expectedBytes = Number(file.size)
      const bounded = Buffer.alloc(expectedBytes + 1)
      let bytesRead = 0
      while (bytesRead < bounded.byteLength) {
        const result = await handle.read(
          bounded,
          bytesRead,
          bounded.byteLength - bytesRead,
          bytesRead,
        )
        if (result.bytesRead === 0) break
        bytesRead += result.bytesRead
      }
      const after = await handle.stat({ bigint: true })
      if (
        bytesRead !== expectedBytes ||
        (await realpath(file.sourcePath)) !== file.sourcePath ||
        !projectionIdentityMatches(after, file)
      ) {
        throw new InlineAgentProjectionError("projection_changed_during_read")
      }
      const bytes = bounded.subarray(0, expectedBytes)
      let content: string
      try {
        content = decoder.decode(bytes)
      } catch {
        throw new InlineAgentProjectionError("projection_utf8_required")
      }
      if (content.includes("\u0000")) {
        throw new InlineAgentProjectionError("projection_text_nul_denied")
      }
      assets.push({
        path: file.portablePath,
        mediaType: "text/plain;charset=utf-8",
        byteLength: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        content,
      })
    } finally {
      await handle.close()
    }
  }

  const finalRoot = await realpath(request.workingDirectory)
  const finalRootStat = await lstat(finalRoot, { bigint: true })
  if (
    finalRoot !== inspection.sourceRoot ||
    !finalRootStat.isDirectory() ||
    finalRootStat.dev !== inspection.rootDevice ||
    finalRootStat.ino !== inspection.rootInode
  ) {
    throw new InlineAgentProjectionError("working_directory_changed")
  }
  return assets
}
