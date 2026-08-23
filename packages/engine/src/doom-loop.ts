import { createHash } from "node:crypto"

/**
 * Deterministic, model-free doom-loop detection.
 *
 * Two signal families, both counted on output digests:
 *  - repetition: the same output repeated N times consecutively;
 *  - oscillation: an A -> B -> A -> B cycle sustained for M full cycles.
 * Continuously changing output never trips either counter (the exemption is
 * structural: any new digest resets the repetition run and extends the
 * oscillation candidate window).
 */

export type DoomLoopSignal = "none" | "repetition" | "oscillation"

export interface DoomLoopConfig {
  repetitionThreshold: number
  oscillationCycles: number
  windowSize: number
}

export const DEFAULT_DOOM_LOOP_CONFIG: DoomLoopConfig = {
  repetitionThreshold: 3,
  oscillationCycles: 2,
  windowSize: 16,
}

export function digestOutput(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

export class DoomLoopDetector {
  readonly config: DoomLoopConfig
  #history: string[] = []

  constructor(config: Partial<DoomLoopConfig> = {}) {
    this.config = { ...DEFAULT_DOOM_LOOP_CONFIG, ...config }
    if (
      !Number.isInteger(this.config.repetitionThreshold) ||
      this.config.repetitionThreshold < 2
    ) {
      throw new TypeError("repetitionThreshold must be an integer >= 2")
    }
    if (
      !Number.isInteger(this.config.oscillationCycles) ||
      this.config.oscillationCycles < 1
    ) {
      throw new TypeError("oscillationCycles must be an integer >= 1")
    }
  }

  /** Observe one model output; returns the triggered signal, if any. */
  observe(text: string): DoomLoopSignal {
    const digest = digestOutput(text)
    this.#history.push(digest)
    if (this.#history.length > this.config.windowSize) {
      this.#history.shift()
    }
    if (this.repetitionCount() >= this.config.repetitionThreshold) {
      return "repetition"
    }
    if (this.oscillationCycles() >= this.config.oscillationCycles) {
      return "oscillation"
    }
    return "none"
  }

  repetitionCount(): number {
    if (this.#history.length === 0) return 0
    const last = this.#history[this.#history.length - 1]
    let count = 0
    for (let index = this.#history.length - 1; index >= 0; index -= 1) {
      if (this.#history[index] !== last) break
      count += 1
    }
    return count
  }

  /**
   * Full A-B-A-B cycles at the tail of the window. Two distinct digests
   * alternating produce one cycle per completed A-B-A-B span.
   */
  oscillationCycles(): number {
    const history = this.#history
    if (history.length < 4) return 0
    const a = history[history.length - 2]
    const b = history[history.length - 1]
    if (a === b) return 0
    let slots = 0
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const expected = (history.length - 1 - index) % 2 === 0 ? b : a
      if (history[index] !== expected) break
      slots += 1
    }
    return Math.floor(slots / 4)
  }

  reset(): void {
    this.#history = []
  }
}
