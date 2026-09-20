// Deterministic skill composition
// Implements #306: deterministic composer

import { createHash } from "crypto";
import type { SkillManifest } from "./skill-manifest";

export interface SkillUnit {
  manifest: SkillManifest;
  instructions: string;
  digest: string;
}

export interface SkillCompositionInput {
  skills: SkillUnit[];
  authorityScope: {
    tools: {
      allow?: string[];
      deny?: string[];
    };
  };
}

export interface SkillCompositionResult {
  composedInstructions: string;
  compositionOrder: string[];
  digests: string[];
  suppressedTools: string[];
}

export class SkillCompositionError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "SkillCompositionError";
  }
}

export function composeSkills(input: SkillCompositionInput): SkillCompositionResult {
  const { skills, authorityScope } = input;

  if (skills.length === 0) {
    return {
      composedInstructions: "",
      compositionOrder: [],
      digests: [],
      suppressedTools: [],
    };
  }

  // Check for exclusiveWith conflicts
  for (let i = 0; i < skills.length; i++) {
    const skillA = skills[i];
    const exclusiveWith = skillA.manifest.compositionRules?.exclusiveWith ?? [];
    for (let j = i + 1; j < skills.length; j++) {
      const skillB = skills[j];
      if (exclusiveWith.includes(skillB.manifest.name)) {
        const pair = [skillA.manifest.name, skillB.manifest.name].sort();
        throw new SkillCompositionError(
          `skills ${pair[0]} and ${pair[1]} are mutually exclusive`,
          `skill_composition_conflict:${pair[0]}:${pair[1]}`
        );
      }
    }
  }

  // Compose instructions in declared order
  const instructions = skills.map((s) => s.instructions).join("\n\n---\n\n");

  // Track composition order and digests
  const compositionOrder = skills.map((s) => s.manifest.name);
  const digests = skills.map((s) => s.digest);

  // Authority non-escalation: suppress tools outside authority scope
  const allowList = new Set(authorityScope.tools.allow ?? []);
  const denyList = new Set(authorityScope.tools.deny ?? []);
  const suppressedTools = new Set<string>();

  for (const skill of skills) {
    for (const tool of skill.manifest.tools) {
      // Tool is suppressed if:
      // 1. It's in the deny list, OR
      // 2. Allow list is non-empty and tool is not in it
      if (denyList.has(tool) || (allowList.size > 0 && !allowList.has(tool))) {
        suppressedTools.add(tool);
      }
    }
  }

  return {
    composedInstructions: instructions,
    compositionOrder,
    digests,
    suppressedTools: Array.from(suppressedTools).sort(),
  };
}

export function computeSkillUnitDigest(manifest: SkillManifest, instructions: string): string {
  const canonical = JSON.stringify({
    manifest: {
      name: manifest.name,
      version: manifest.version,
      inputs: manifest.inputs,
      outputs: manifest.outputs,
      tools: manifest.tools,
      assets: manifest.assets,
      compositionRules: manifest.compositionRules,
    },
    instructions,
  });
  const hash = createHash("sha256").update(canonical).digest("hex");
  return `sha256:${hash}`;
}
