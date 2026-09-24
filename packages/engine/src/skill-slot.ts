/**
 * Skills context slot + composition evidence (#307 R2).
 *
 * Extends CONTEXT_SLOT_ORDER with `skills` at the end; the five existing
 * slots are not permuted. Cross-workspace reuse is forbidden.
 */

import { composeSkillUnits } from "../../core/src/skill-composer.js"
import type { EmployeePackageSkillRef } from "../../core/src/employee-package.js"

export interface SkillCompositionEvidence {
  workspaceId: string
  positionId: string
  units: Array<{ name: string; version: string; digest: string }>
  compositionDigest: string
}

const registries = new Map<string, Map<string, EmployeePackageSkillRef>>()

export function registerWorkspaceSkillUnit(
  workspaceId: string,
  unit: EmployeePackageSkillRef,
): void {
  let table = registries.get(workspaceId)
  if (!table) {
    table = new Map()
    registries.set(workspaceId, table)
  }
  table.set(`${unit.name}@${unit.version}`, unit)
}

export function composePositionSkills(input: {
  workspaceId: string
  positionId: string
  declarations: readonly EmployeePackageSkillRef[]
}): { text?: string; evidence: SkillCompositionEvidence } {
  const workspaceUnits = registries.get(input.workspaceId)
  const resolved = input.declarations.map((declaration) => {
    const fromRegistry = workspaceUnits?.get(
      `${declaration.name}@${declaration.version}`,
    )
    return fromRegistry ?? declaration
  })
  if (resolved.length === 0) {
    return {
      evidence: {
        workspaceId: input.workspaceId,
        positionId: input.positionId,
        units: [],
        compositionDigest: composeSkillUnits([]).digest,
      },
    }
  }
  const composed = composeSkillUnits(resolved)
  const units = [...resolved]
    .map((unit) => ({
      name: unit.name,
      version: unit.version,
      digest: unit.digest,
    }))
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.version.localeCompare(right.version),
    )
  return {
    text: composed.blocks.join("\n"),
    evidence: {
      workspaceId: input.workspaceId,
      positionId: input.positionId,
      units,
      compositionDigest: composed.digest,
    },
  }
}

/** Test seam: drop in-memory registries between cases. */
export function resetSkillRegistries(): void {
  registries.clear()
}
