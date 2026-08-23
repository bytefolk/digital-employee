import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

/**
 * Structural fail-closed assertion for the read-only engine core.
 *
 * The engine's absence of a tool surface is a fact of construction, not a
 * configuration: the package must contain no process spawning, no network
 * stack, and no filesystem access outside the explicitly-scoped reference
 * ports (none exist in the skeleton slice). This scan makes that guarantee
 * machine-checked and regression-proof.
 */

const ENGINE_SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../packages/engine/src",
)

const FORBIDDEN_IMPORT_SPECS = [
  "node:child_process",
  "node:net",
  "node:http",
  "node:http2",
  "node:https",
  "node:tls",
  "node:dgram",
  "node:worker_threads",
  "node:fs",
  "node:fs/promises",
  "child_process",
  "net",
  "http",
  "https",
] as const

const FORBIDDEN_USAGE_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "global fetch", pattern: /\bfetch\s*\(/ },
  { name: "WebSocket", pattern: /\bWebSocket\b/ },
  { name: "XMLHttpRequest", pattern: /\bXMLHttpRequest\b/ },
  { name: "process.env credential surface", pattern: /\bprocess\.env\b/ },
  { name: "dynamic import of arbitrary modules", pattern: /\bimport\s*\(/ },
]

/** Node built-ins the engine core may use (hashing for digests only). */
const ALLOWED_NODE_SPECS = new Set(["node:crypto"])

function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(full))
    } else if (entry.name.endsWith(".ts")) {
      files.push(full)
    }
  }
  return files
}

function importSpecifiers(source: string): string[] {
  const specs: string[] = []
  const staticPattern = /(?:import|export)[^;]*?from\s*["']([^"']+)["']/g
  const sideEffectPattern = /^\s*import\s*["']([^"']+)["']/gm
  for (const match of source.matchAll(staticPattern)) specs.push(match[1]!)
  for (const match of source.matchAll(sideEffectPattern)) specs.push(match[1]!)
  return specs
}

test("engine source contains no forbidden module imports", () => {
  const files = listSourceFiles(ENGINE_SRC)
  assert.ok(files.length > 0, "engine source files must exist")
  const violations: string[] = []
  for (const file of files) {
    const source = readFileSync(file, "utf8")
    for (const spec of importSpecifiers(source)) {
      if (FORBIDDEN_IMPORT_SPECS.includes(spec as never)) {
        violations.push(`${path.relative(ENGINE_SRC, file)}: imports ${spec}`)
      }
      if (spec.startsWith("node:") && !ALLOWED_NODE_SPECS.has(spec)) {
        violations.push(
          `${path.relative(ENGINE_SRC, file)}: unlisted node builtin ${spec}`,
        )
      }
    }
  }
  assert.deepEqual(violations, [])
})

test("engine source contains no network or process usage", () => {
  const files = listSourceFiles(ENGINE_SRC)
  const violations: string[] = []
  for (const file of files) {
    const source = readFileSync(file, "utf8")
    for (const { name, pattern } of FORBIDDEN_USAGE_PATTERNS) {
      if (pattern.test(source)) {
        violations.push(`${path.relative(ENGINE_SRC, file)}: ${name}`)
      }
    }
  }
  assert.deepEqual(violations, [])
})
