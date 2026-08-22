/**
 * Lightweight i18n key-value loader for the deploy command.
 * No framework dependency — just JSON locale files.
 *
 * ## Adding a new language
 *
 * 1. Create a new file `locales/{lang}.json` (e.g. `locales/ja.json`)
 *    using the same flat key-value structure as `locales/en.json`.
 * 2. That's it! The locale will be auto-discovered and shown in the
 *    language selection prompt. No code changes required.
 *
 * The locale code should follow BCP 47 (e.g. "en", "zh-CN", "ja", "pt-BR").
 * Missing keys automatically fall back to the English value.
 */

import { readFileSync, readdirSync } from "node:fs"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** Any locale code available in the locales/ directory. */
export type SupportedLocale = string

const LOCALES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../locales",
)

let currentLocale: SupportedLocale = "en"
let messages: Record<string, string> = {}
let fallbackMessages: Record<string, string> = {}

/**
 * Discover all available locales by scanning the locales/ directory.
 * Returns an array of locale codes (e.g. ["en", "ja", "zh-CN"]).
 */
export function getAvailableLocales(): string[] {
  if (!existsSync(LOCALES_DIR)) return ["en"]
  return readdirSync(LOCALES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort()
}

/**
 * Get locale display metadata. Each locale file may contain a
 * special key "locale.display_name" for the human-readable label.
 * Falls back to the locale code itself.
 */
export function getLocaleDisplayName(locale: string): string {
  const file = path.join(LOCALES_DIR, `${locale}.json`)
  if (!existsSync(file)) return locale
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>
    return data["locale.display_name"] ?? locale
  } catch {
    return locale
  }
}

/**
 * Detect locale from environment (LANG, LC_ALL).
 * Matches against available locales with prefix matching.
 * Falls back to "en" if no match is found.
 */
export function detectSystemLocale(): SupportedLocale {
  const raw = process.env.LC_ALL || process.env.LANG || ""
  const normalized = raw.toLowerCase().split(".")[0].replace("_", "-")

  const available = getAvailableLocales()

  // Exact match first (e.g. "zh-cn" matches "zh-CN")
  const exact = available.find((l) => l.toLowerCase() === normalized)
  if (exact) return exact

  // Prefix match (e.g. "zh" matches "zh-CN")
  const prefix = available.find((l) => normalized.startsWith(l.toLowerCase().split("-")[0]))
  if (prefix && prefix !== "en") return prefix

  return "en"
}

/**
 * Return the canonical set of keys from the English reference catalog.
 */
export function getReferenceKeys(): string[] {
  const enFile = path.join(LOCALES_DIR, "en.json")
  if (!existsSync(enFile)) return []
  const data = JSON.parse(readFileSync(enFile, "utf8")) as Record<string, unknown>
  return Object.keys(data)
}

/**
 * Validate a locale catalog against the English reference.
 * Returns an array of error messages (empty if valid).
 *
 * Checks:
 * - All required keys are present
 * - All values are non-empty strings
 * - JSON is well-formed (caller should catch parse errors before calling)
 */
export function validateCatalog(
  catalog: Record<string, unknown>,
  localeCode: string,
): string[] {
  const errors: string[] = []
  const reference = getReferenceKeys()

  for (const key of reference) {
    if (!(key in catalog)) {
      errors.push(`${localeCode}: missing key "${key}"`)
    } else if (typeof catalog[key] !== "string") {
      errors.push(`${localeCode}: key "${key}" must be a string, got ${typeof catalog[key]}`)
    } else if ((catalog[key] as string).trim() === "") {
      errors.push(`${localeCode}: key "${key}" must not be empty`)
    }
  }

  return errors
}

/**
 * Load a locale file and set as current.
 * Missing keys fall back to the English locale.
 * Malformed catalogs fall back to English with a validation warning.
 */
export function setLocale(locale: SupportedLocale): void {
  // Always load English as fallback
  const enFile = path.join(LOCALES_DIR, "en.json")
  if (existsSync(enFile)) {
    fallbackMessages = JSON.parse(readFileSync(enFile, "utf8")) as Record<string, string>
  }

  const file = path.join(LOCALES_DIR, `${locale}.json`)
  if (!existsSync(file)) {
    messages = { ...fallbackMessages }
    currentLocale = "en"
    return
  }

  let raw: string
  try {
    raw = readFileSync(file, "utf8")
  } catch {
    messages = { ...fallbackMessages }
    currentLocale = "en"
    return
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    parsed = null as unknown as Record<string, unknown>
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    process.stderr.write(
      `[i18n] failed to parse ${locale}.json; falling back to English\n`,
    )
    messages = { ...fallbackMessages }
    currentLocale = "en"
    return
  }

  const validationErrors = validateCatalog(parsed, locale)
  if (validationErrors.length > 0) {
    // Log the first few errors to stderr but do not crash —
    // missing keys already fall back to English gracefully.
    for (let i = 0; i < Math.min(validationErrors.length, 3); i++) {
      process.stderr.write(`[i18n] ${validationErrors[i]}\n`)
    }
  }

  messages = parsed as Record<string, string>
  currentLocale = locale
}

/**
 * Report whether a message key exists in the current or English fallback
 * catalog. Use this before rendering optional keys: t() falls back to the
 * key itself, so existence cannot be detected through t().
 */
export function hasMessage(key: string): boolean {
  return key in messages || key in fallbackMessages
}

/**
 * Get a translated message by key.
 * Supports {placeholder} interpolation.
 * Falls back to English value, then to the key itself.
 */
export function t(key: string, vars?: Record<string, string>): string {
  let msg = messages[key] ?? fallbackMessages[key] ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      msg = msg.replaceAll(`{${k}}`, v)
    }
  }
  return msg
}

export function getLocale(): SupportedLocale {
  return currentLocale
}
