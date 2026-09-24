import { createHash } from "node:crypto"

import type { EmployeePackageSkillRef } from "./employee-package.js"

export interface SkillComposition {
  blocks: string[]
  digest: string
}

function canonicalRefs(
  declarations: readonly EmployeePackageSkillRef[],
): Array<{ name: string; version: string; digest: string }> {
  return [...declarations]
    .map((entry) => ({
      name: entry.name,
      version: entry.version,
      digest: entry.digest,
    }))
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.version.localeCompare(right.version),
    )
}

/**
 * Pure skill composer (#306 R2). Same declarations → same digest.
 * Duplicate `name` fails closed. Empty input is handled by
 * `resolveSkillPromptSurface`, not by inventing prose here.
 */
export function composeSkillUnits(
  declarations: readonly EmployeePackageSkillRef[],
): SkillComposition {
  const names = new Set<string>()
  for (const entry of declarations) {
    if (names.has(entry.name)) {
      throw new TypeError("skill_composer_duplicate_name")
    }
    names.add(entry.name)
  }
  const ordered = canonicalRefs(declarations)
  const blocks = ordered.map((entry) => `${entry.name}@${entry.version}\n${entry.digest}`)
  const digest = `sha256:${createHash("sha256")
    .update(JSON.stringify(ordered), "utf8")
    .update("\n", "utf8")
    .update(blocks.join("\n"), "utf8")
    .digest("hex")}`
  return { blocks, digest }
}

/**
 * Declaration-free packages keep the current `entrypoints.skill` prose
 * byte-identical. Present declarations use the composed blocks.
 */
export function resolveSkillPromptSurface(
  declarations: readonly EmployeePackageSkillRef[] | undefined,
  legacyProse: string,
): string {
  if (!declarations || declarations.length === 0) return legacyProse
  return composeSkillUnits(declarations).blocks.join("\n")
}
