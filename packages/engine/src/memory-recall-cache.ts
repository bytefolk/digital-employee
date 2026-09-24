import type {
  MemoryPort,
  MemoryRecall,
  MemoryRecallRequest,
} from "../../core/src/memory-port.js"

export const MEMORY_RECALL_CACHE_TTL_MS = 30_000

export function memoryRecallCacheKey(
  adapterIdentity: string,
  request: MemoryRecallRequest,
): string {
  return [
    adapterIdentity,
    request.workspaceInstanceId,
    request.sessionId,
    request.positionId,
    request.principal,
    request.memoryScope,
    request.mode,
    request.limit === undefined ? "" : String(request.limit),
  ].join("\0")
}

export function memoryRecallWitness(recall: MemoryRecall): string {
  return recall.items
    .map((item) => `${item.memoryId}:${item.stateVersion}:${item.digest}`)
    .sort()
    .join("|")
}

export interface MemoryRecallCacheResult {
  recall: MemoryRecall
  cacheHit: boolean
  cacheAgeMs: number
}

/**
 * Default-disabled in-process MemoryPort.recall cache (#303).
 * Entries never cross position/session/scope keys and expire after 30s.
 */
export class InProcessMemoryRecallCache {
  readonly ttlMs: number
  readonly #now: () => number
  readonly #entries = new Map<
    string,
    { recall: MemoryRecall; storedAt: number; witness: string }
  >()

  constructor(
    options: {
      ttlMs?: number
      now?: () => number
    } = {},
  ) {
    this.ttlMs = options.ttlMs ?? MEMORY_RECALL_CACHE_TTL_MS
    this.#now = options.now ?? Date.now
  }

  invalidate(): void {
    this.#entries.clear()
  }

  async recall(
    port: MemoryPort,
    request: MemoryRecallRequest,
    adapterIdentity: string,
  ): Promise<MemoryRecallCacheResult> {
    const key = memoryRecallCacheKey(adapterIdentity, request)
    const now = this.#now()
    const hit = this.#entries.get(key)
    if (hit && now - hit.storedAt < this.ttlMs) {
      return {
        recall: hit.recall,
        cacheHit: true,
        cacheAgeMs: now - hit.storedAt,
      }
    }
    const recall = await port.recall(request)
    this.#entries.set(key, {
      recall,
      storedAt: now,
      witness: memoryRecallWitness(recall),
    })
    return { recall, cacheHit: false, cacheAgeMs: 0 }
  }
}
