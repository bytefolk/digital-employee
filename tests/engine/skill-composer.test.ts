import { describe, it, expect } from "vitest";
import {
  composeSkills,
  computeSkillUnitDigest,
  SkillCompositionError,
  type SkillUnit,
} from "../../packages/engine/src/skill-composer.js";
import { validateSkillManifest } from "../../packages/core/src/skill-manifest.js";

describe("skill-composer", () => {
  const createSkillUnit = (name: string, instructions: string, tools: string[] = []): SkillUnit => {
    const manifest = validateSkillManifest({
      schemaVersion: "skill-unit.v1",
      name,
      version: "1.0.0",
      description: `${name} skill`,
      inputs: [],
      outputs: [],
      tools,
      assets: [],
    });
    return {
      manifest,
      instructions,
      digest: computeSkillUnitDigest(manifest, instructions),
    };
  };

  it("composes skills deterministically", () => {
    const skillA = createSkillUnit("skill-a", "Instructions A");
    const skillB = createSkillUnit("skill-b", "Instructions B");
    const result = composeSkills({
      skills: [skillA, skillB],
      authorityScope: { tools: {} },
    });
    expect(result.composedInstructions).toContain("Instructions A");
    expect(result.composedInstructions).toContain("Instructions B");
    expect(result.compositionOrder).toEqual(["skill-a", "skill-b"]);
  });

  it("detects exclusiveWith conflicts", () => {
    const skillA = createSkillUnit("skill-a", "A");
    const skillB = createSkillUnit("skill-b", "B");
    skillA.manifest.compositionRules = { exclusiveWith: ["skill-b"] };

    expect(() =>
      composeSkills({
        skills: [skillA, skillB],
        authorityScope: { tools: {} },
      })
    ).toThrow(SkillCompositionError);
  });

  it("suppresses tools outside authority scope", () => {
    const skill = createSkillUnit("skill", "Instructions", ["read-file", "write-file", "delete-file"]);
    const result = composeSkills({
      skills: [skill],
      authorityScope: {
        tools: {
          allow: ["read-file", "write-file"],
        },
      },
    });
    expect(result.suppressedTools).toEqual(["delete-file"]);
  });

  it("handles empty skill list", () => {
    const result = composeSkills({
      skills: [],
      authorityScope: { tools: {} },
    });
    expect(result.composedInstructions).toBe("");
    expect(result.compositionOrder).toEqual([]);
  });
});
