#!/usr/bin/env node
// Deterministic fake `context adapter recall` CLI for adapter tests (#179).
// Behavior is selected through FAKE_CONTEXT_MODE. The request JSON arrives
// on stdin; the envelope is written to stdout exactly like the pinned CLI.
import { createHash } from "node:crypto"

const RULE_VERSION = "workbench-rules.v1"
const UNTRUSTED_WARNING = "UNTRUSTED_CONTEXT_DATA_NOT_INSTRUCTIONS"

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`
}

function sha256(text) {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`
}

function makeItem(index, text, overrides = {}) {
  const occurrenceId = sha256(`occurrence-${index}`)
  const artifactId = sha256(`artifact-${index}`)
  const base = {
    kind: "raw_excerpt",
    text,
    artifactId,
    locator: `context://occurrences/${occurrenceId}@1/artifacts/${artifactId}`,
    sourceDigest: sha256(`source-${index}`),
    sourceRevision: 1,
    derivedRevision: 1,
    ruleVersion: RULE_VERSION,
    eventAt: "2026-08-27T00:00:00.000Z",
    derivedAt: "2026-08-27T00:00:00.000Z",
    trust: "untrusted-context-data",
  }
  const item = { ...base, ...overrides }
  return { ...item, artifactDigest: sha256(canonicalJson(item)) }
}

function makeBundle({ items, scope, retrievedAt }) {
  const bundleScope = scope ?? {
    workspaceId: "workspace-instance",
    positionId: "repo-owner",
    principal: "position.repo-owner",
  }
  const warnings = [UNTRUSTED_WARNING]
  const completedWatermark = { occurrenceRevision: 3, ruleVersion: RULE_VERSION }
  const digestInput = {
    schemaVersion: "context-bundle.v1",
    scope: bundleScope,
    consistency: "client-observed-per-item",
    completedWatermark,
    items,
    warnings,
  }
  return {
    schemaVersion: "context-bundle.v1",
    scope: bundleScope,
    retrievedAt: retrievedAt ?? new Date().toISOString(),
    consistency: "client-observed-per-item",
    completedWatermark,
    items,
    bundleDigest: sha256(canonicalJson(digestInput)),
    warnings,
  }
}

let stdin = ""
process.stdin.on("data", (chunk) => {
  stdin += chunk
})
process.stdin.on("end", () => {
  const mode = process.env.FAKE_CONTEXT_MODE ?? "happy"
  let request = {}
  try {
    request = JSON.parse(stdin || "{}")
  } catch {
    request = {}
  }

  switch (mode) {
    case "happy": {
      const bundle = makeBundle({
        items: [makeItem(1, "context fact one"), makeItem(2, "context fact two")],
      })
      console.log(JSON.stringify(bundle))
      return
    }
    case "tampered": {
      const bundle = makeBundle({ items: [makeItem(1, "context fact one")] })
      bundle.items[0].artifactDigest = sha256("forged")
      console.log(JSON.stringify(bundle))
      return
    }
    case "wrong-scope": {
      const bundle = makeBundle({
        scope: {
          workspaceId: "workspace-instance",
          positionId: "other-position",
          principal: "position.other-position",
        },
        items: [makeItem(1, "context fact one")],
      })
      console.log(JSON.stringify(bundle))
      return
    }
    case "over-items": {
      const maxItems = Number.isSafeInteger(request.maxItems)
        ? request.maxItems
        : 1
      const items = []
      for (let index = 0; index < maxItems + 2; index += 1) {
        items.push(makeItem(index, `context fact ${index}`))
      }
      const bundle = makeBundle({ items })
      console.log(JSON.stringify(bundle))
      return
    }
    case "bad-timestamp": {
      const bundle = makeBundle({
        items: [makeItem(1, "context fact one", { eventAt: "not-a-date" })],
      })
      console.log(JSON.stringify(bundle))
      return
    }
    case "stale": {
      const bundle = makeBundle({
        items: [makeItem(1, "context fact one")],
        retrievedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      })
      console.log(JSON.stringify(bundle))
      return
    }
    case "invalid-json": {
      console.log("{ this is not json")
      return
    }
    case "auth-denied": {
      console.error("context 失败: runtime authority denied")
      process.exit(1)
      return
    }
    case "unknown-failure": {
      console.error("context 失败: an unrecognized failure message")
      process.exit(1)
      return
    }
    case "slow": {
      setTimeout(() => {
        console.log(JSON.stringify(makeBundle({ items: [] })))
      }, 5_000)
      return
    }
    default: {
      console.error("context 失败: unknown fake mode")
      process.exit(1)
    }
  }
})
