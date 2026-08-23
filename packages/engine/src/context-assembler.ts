import { createHash } from "node:crypto"

export const CONTEXT_ASSEMBLY_VERSION = "context-assembly.v1" as const

/**
 * Deterministic assembly order. The position bundle is the mandatory layer;
 * the memory-recall slot is the single seam for the memory plane and stays
 * empty until memory integration lands (its position is contractually fixed).
 */
export type ContextSlot =
  | "position_instructions"
  | "position_spec"
  | "turn_input"
  | "memory_recall"

export const CONTEXT_SLOT_ORDER: readonly ContextSlot[] = [
  "position_instructions",
  "position_spec",
  "turn_input",
  "memory_recall",
]

export interface ContextBlock {
  slot: ContextSlot
  text: string
  byteLength: number
  /** Bytes removed by deterministic window management; 0 when untouched. */
  truncatedBytes: number
}

export interface AssemblyManifestEntry {
  slot: ContextSlot
  byteLength: number
  truncatedBytes: number
}

export interface AssemblyManifest {
  schemaVersion: typeof CONTEXT_ASSEMBLY_VERSION
  positionId: string
  turnId: string
  order: readonly ContextSlot[]
  blocks: AssemblyManifestEntry[]
  /** sha256 over the canonical serialization of the assembled block texts. */
  digest: string
}

export interface AssembleContextInput {
  positionId: string
  turnId: string
  instructions?: string
  spec?: string
  turnInput: string
  /** Memory-plane recall lines; empty in the read-only skeleton. */
  memoryRecall?: readonly string[]
}

export interface ContextWindowLimits {
  maxBlockBytes?: number
  maxTotalBytes?: number
}

export interface AssembledContext {
  blocks: ContextBlock[]
  manifest: AssemblyManifest
}

function truncateToByteBudget(text: string, maxBytes: number): {
  kept: string
  truncatedBytes: number
} {
  const total = Buffer.byteLength(text, "utf8")
  if (total <= maxBytes) return { kept: text, truncatedBytes: 0 }
  const buffer = Buffer.from(text, "utf8")
  let end = maxBytes
  // Never split a multi-byte sequence: walk back to a UTF-8 boundary.
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1
  return {
    kept: buffer.subarray(0, end).toString("utf8"),
    truncatedBytes: total - end,
  }
}

/**
 * Deterministic context assembly: fixed slot order, byte-bounded blocks,
 * truncation leaves a trace (byte counts in the manifest), and the digest
 * covers the assembled texts so evidence can pin exactly what entered the
 * window.
 */
export function assembleContext(
  input: AssembleContextInput,
  limits: ContextWindowLimits = {},
): AssembledContext {
  if (typeof input.turnInput !== "string" || input.turnInput.length === 0) {
    throw new TypeError("turnInput must be a non-empty string")
  }
  const recall = input.memoryRecall ?? []
  const candidates: Array<{ slot: ContextSlot; text: string | undefined }> = [
    { slot: "position_instructions", text: input.instructions },
    { slot: "position_spec", text: input.spec },
    { slot: "turn_input", text: input.turnInput },
    { slot: "memory_recall", text: recall.length > 0 ? recall.join("\n") : undefined },
  ]

  const blocks: ContextBlock[] = []
  let remaining = limits.maxTotalBytes
  for (const slotOrder of CONTEXT_SLOT_ORDER) {
    const candidate = candidates.find((entry) => entry.slot === slotOrder)
    if (!candidate || candidate.text === undefined) continue
    let text = candidate.text
    let truncatedBytes = 0
    if (limits.maxBlockBytes !== undefined) {
      const blockCut = truncateToByteBudget(text, limits.maxBlockBytes)
      text = blockCut.kept
      truncatedBytes += blockCut.truncatedBytes
    }
    if (remaining !== undefined) {
      const totalCut = truncateToByteBudget(text, Math.max(0, remaining))
      text = totalCut.kept
      truncatedBytes += totalCut.truncatedBytes
      remaining -= Buffer.byteLength(text, "utf8")
    }
    if (text.length === 0 && truncatedBytes === 0) continue
    blocks.push({
      slot: slotOrder,
      text,
      byteLength: Buffer.byteLength(text, "utf8"),
      truncatedBytes,
    })
  }

  const canonical = JSON.stringify(
    blocks.map((block) => [block.slot, block.text]),
  )
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex")

  return {
    blocks,
    manifest: {
      schemaVersion: CONTEXT_ASSEMBLY_VERSION,
      positionId: input.positionId,
      turnId: input.turnId,
      order: CONTEXT_SLOT_ORDER,
      blocks: blocks.map((block) => ({
        slot: block.slot,
        byteLength: block.byteLength,
        truncatedBytes: block.truncatedBytes,
      })),
      digest,
    },
  }
}
