/**
 * Injection-shape screen for recalled durable memory (roleweave #351,
 * parent #327): recalled memory is untrusted data. A poisoned record must
 * never be executed as an instruction — records whose content *shape* looks
 * like a tool call, a system prompt, a role-confusion directive, an
 * approval grant, or a credential are omitted from the assembled context
 * with the stable reason `injection_shape`.
 *
 * The screen is deterministic, side-effect free, and byte-bounded: it only
 * inspects the recalled text, never executes it, and never contacts the
 * network. Omitted records stay observable through digest-only evidence
 * (see TurnEvidenceMemoryOmission); the raw text never enters evidence.
 */

export const MEMORY_OMISSION_REASON = "injection_shape" as const

export type MemoryInjectionShape =
  | "tool_call_shape"
  | "system_prompt_shape"
  | "role_confusion_shape"
  | "approval_grant_shape"
  | "credential_shape"

/** Shapes a recalled record may be omitted for (name revisable, #351 REQ-002). */
export type MemoryOmissionReason = typeof MEMORY_OMISSION_REASON

export interface MemoryOmissionFinding {
  reason: MemoryOmissionReason
  shape: MemoryInjectionShape
}

/** Hard cap on the text length the screen will inspect, in UTF-16 code units. */
const MAX_SCREENED_LENGTH = 16 * 1024

const ROLE_CONFUSION_PATTERNS: readonly RegExp[] = [
  /\byou\s+are\s+now\s+(?:an?\s+)?\w+/i,
  /\bignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|rules?|directives?|prompts?|constraints?)\b/i,
  /\bdisregard\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|rules?|directives?|prompts?|constraints?)\b/i,
  /\bnew\s+(?:operating\s+|system\s+)?instructions?\s*:/i,
  /\bfrom\s+now\s+on,?\s+you\s+(?:must|should|will|are)\b/i,
  /\byour\s+new\s+(?:role|instructions?|system\s+prompt)\b/i,
]

const SYSTEM_PROMPT_PATTERNS: readonly RegExp[] = [
  /^\s*(?:system|developer)\s*(?:prompt|message)?\s*:/i,
  /\bsystem\s+prompt\s*:/i,
  /\[system\]/i,
  /<[|]?system[|]?>/i,
  /^#{1,3}\s*(?:system|developer)\b/im,
]

const APPROVAL_GRANT_PATTERNS: readonly RegExp[] = [
  /\bapproval\s+(?:is\s+)?(?:granted|approved|authorized)\b/i,
  /\b(?:permission|access|authorization)\s+(?:is\s+)?granted\b/i,
  /\bgrant(?:s|ed|ing)?\s+(?:you\s+)?(?:full\s+|unrestricted\s+)?(?:access|permission|tool(?:s)?\b|approval)/i,
  /\byou\s+(?:now\s+)?have\s+(?:been\s+)?(?:granted|given|approved)\s+(?:full\s+|unrestricted\s+)?(?:access|permission|approval)/i,
  /\btool\s+(?:access|permission)\s+(?:is\s+)?(?:granted|approved|enabled)\b/i,
]

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /AKIA[0-9A-Z]{16}/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN\s+[A-Z ]*PRIVATE KEY-----/,
  /Bearer\s+[A-Za-z0-9._+/-]{24,}/,
  /\b(?:api[_-]?key|secret|token|password|passwd|credential|access[_-]?key)\b\s*[:=]\s*["']?[A-Za-z0-9._+/-]{16,}/i,
]

/** Keys whose presence marks a JSON object as a tool-call shape. */
const TOOL_CALL_MARKER_KEYS: ReadonlySet<string> = new Set([
  "tool_calls",
  "tool_use",
  "tool_use_id",
  "tool_call_id",
  "function_call",
  "toolCall",
  "tool_call",
])

/** Minimal pair (tool name + arguments/input) that marks a JSON tool call. */
const TOOL_CALL_NAME_INPUT_KEYS: readonly (readonly [string, string])[] = [
  ["name", "arguments"],
  ["name", "input"],
  ["name", "parameters"],
  ["tool", "input"],
]

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

function looksLikeToolCallJson(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return false
  }
  const candidates: unknown[] = Array.isArray(parsed) ? parsed : [parsed]
  return candidates.some((candidate) => {
    if (!isPlainObject(candidate)) return false
    for (const key of Object.keys(candidate)) {
      if (TOOL_CALL_MARKER_KEYS.has(key)) return true
    }
    // Nested OpenAI-style: { role: "assistant", tool_calls: [...] }
    const nested = candidate as Record<string, unknown>
    if (isPlainObject(nested["function"]) || isPlainObject(nested["tool"])) {
      const inner = (nested["function"] ?? nested["tool"]) as Record<string, unknown>
      if (typeof inner["name"] === "string" && inner["arguments"] !== undefined) {
        return true
      }
    }
    for (const [nameKey, inputKey] of TOOL_CALL_NAME_INPUT_KEYS) {
      if (
        typeof nested[nameKey] === "string" &&
        nested[inputKey] !== undefined
      ) {
        return true
      }
    }
    return false
  })
}

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text))
}

/**
 * Classify one recalled memory text. Returns the injection shape that
 * disqualifies the record from the assembled context, or undefined when
 * the text passes the screen and may be admitted as quoted untrusted data.
 *
 * Evaluation order is part of the contract (deterministic, stable reason
 * per record): tool-call JSON, then system prompt, then role confusion,
 * then approval grant, then credential shape.
 */
export function detectMemoryInjectionShape(
  text: string,
): MemoryInjectionShape | undefined {
  if (typeof text !== "string" || text.length === 0) return undefined
  const bounded = text.length > MAX_SCREENED_LENGTH
    ? text.slice(0, MAX_SCREENED_LENGTH)
    : text
  if (looksLikeToolCallJson(bounded)) return "tool_call_shape"
  if (matchesAny(bounded, SYSTEM_PROMPT_PATTERNS)) return "system_prompt_shape"
  if (matchesAny(bounded, ROLE_CONFUSION_PATTERNS)) return "role_confusion_shape"
  if (matchesAny(bounded, APPROVAL_GRANT_PATTERNS)) return "approval_grant_shape"
  if (matchesAny(bounded, CREDENTIAL_PATTERNS)) return "credential_shape"
  return undefined
}

/**
 * Split recalled texts into admitted lines and digest-free omission
 * findings. Pure: callers keep the original items so evidence can record
 * locators and digests without this module knowing the item shape.
 */
export function screenMemoryTexts(
  texts: readonly string[],
): {
  admitted: string[]
  omissions: MemoryOmissionFinding[]
} {
  const admitted: string[] = []
  const omissions: MemoryOmissionFinding[] = []
  for (const text of texts) {
    const shape = detectMemoryInjectionShape(text)
    if (shape === undefined) {
      admitted.push(text)
    } else {
      omissions.push({ reason: MEMORY_OMISSION_REASON, shape })
    }
  }
  return { admitted, omissions }
}
