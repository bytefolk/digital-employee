/**
 * Lightweight i18n key-value loader for the deploy command.
 * No framework dependency — just JSON locale files.
 */

import { readFileSync } from "node:fs"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export type SupportedLocale = "en" | "zh-CN"

const LOCALES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../locales",
)

let currentLocale: SupportedLocale = "en"
let messages: Record<string, string> = {}

/**
 * Detect locale from environment (LANG, LC_ALL).
 * Returns "zh-CN" for any zh* locale, "en" otherwise.
 */
export function detectSystemLocale(): SupportedLocale {
  const raw = process.env.LC_ALL || process.env.LANG || ""
  return raw.toLowerCase().startsWith("zh") ? "zh-CN" : "en"
}

/**
 * Load a locale file and set as current.
 */
export function setLocale(locale: SupportedLocale): void {
  const file = path.join(LOCALES_DIR, `${locale}.json`)
  if (!existsSync(file)) {
    // Fallback to English
    const fallback = path.join(LOCALES_DIR, "en.json")
    messages = JSON.parse(readFileSync(fallback, "utf8")) as Record<string, string>
    currentLocale = "en"
    return
  }
  messages = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>
  currentLocale = locale
}

/**
 * Get a translated message by key.
 * Supports {placeholder} interpolation.
 */
export function t(key: string, vars?: Record<string, string>): string {
  let msg = messages[key] ?? key
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
