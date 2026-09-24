/**
 * Bounded model↔tool iteration helpers (#302 R2).
 *
 * Calls execute only inside the projected allowlist. Advertised surface may
 * only narrow that set. tool.* events are never a trusted terminal.
 */

import { createHash } from "node:crypto"

import type { EngineEvent } from "./contracts.js"

export const TOOL_OUT_OF_ALLOWLIST_CODE = "tool_out_of_allowlist"
export const TOOL_ADVERTISED_NARROWED_CODE = "tool_advertised_narrowed"

export interface ToolCallRequest {
  toolCallId: string
  toolName: string
  args?: unknown
}

export function effectiveToolAllowlist(input: {
  projected: readonly string[]
  advertised?: readonly string[]
}): { allow: string[]; narrowed: boolean } {
  const projected = [...new Set(input.projected)]
  if (!input.advertised) return { allow: projected, narrowed: false }
  const advertised = new Set(input.advertised)
  const allow = projected.filter((name) => advertised.has(name))
  return { allow, narrowed: allow.length !== projected.length }
}

function digestOutput(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(value ?? null), "utf8")
    .digest("hex")}`
}

export async function* executeToolCalls(input: {
  runId: string
  now?: () => Date
  calls: readonly ToolCallRequest[]
  projectedAllowlist: readonly string[]
  advertisedTools?: readonly string[]
  invoke: (call: ToolCallRequest) => Promise<unknown>
}): AsyncGenerator<EngineEvent> {
  const now = input.now ?? (() => new Date())
  const stamp = () => now().toISOString()
  const { allow, narrowed } = effectiveToolAllowlist({
    projected: input.projectedAllowlist,
    advertised: input.advertisedTools,
  })
  const allowSet = new Set(allow)

  for (const call of input.calls) {
    const base = {
      runId: input.runId,
      timestamp: stamp(),
      toolCallId: call.toolCallId,
      toolName: call.toolName,
    }
    if (!allowSet.has(call.toolName)) {
      yield {
        ...base,
        type: "tool.failed",
        code: narrowed && input.projectedAllowlist.includes(call.toolName)
          ? TOOL_ADVERTISED_NARROWED_CODE
          : TOOL_OUT_OF_ALLOWLIST_CODE,
      }
      continue
    }
    yield { ...base, type: "tool.requested" }
    yield { ...base, type: "tool.started" }
    try {
      const output = await input.invoke(call)
      yield {
        ...base,
        type: "tool.completed",
        outputDigest: digestOutput(output),
      }
    } catch {
      yield {
        ...base,
        type: "tool.failed",
        code: "tool_invoke_failed",
      }
    }
  }
}
