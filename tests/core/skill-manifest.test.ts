import { describe, it, expect } from "vitest";
import {
  validateSkillManifest,
  computeSkillDigest,
  SkillManifestError,
  SKILL_MANIFEST_VERSION,
} from "../../packages/core/src/skill-manifest.js";

describe("skill-manifest", () => {
  const validManifest = {
    schemaVersion: SKILL_MANIFEST_VERSION,
    name: "code-review",
    version: "1.0.0",
    description: "Code review skill",
    inputs: ["source-code"],
    outputs: ["review-comments"],
    tools: ["read-file", "write-file"],
    assets: ["templates/review.md"],
  };

  it("accepts a well-formed manifest", () => {
    const result = validateSkillManifest(validManifest);
    expect(result.name).toBe("code-review");
    expect(result.tools).toEqual(["read-file", "write-file"]);
  });

  it("rejects unknown schema version", () => {
    expect(() =>
      validateSkillManifest({ ...validManifest, schemaVersion: "unknown" })
    ).toThrow(SkillManifestError);
  });

  it("rejects missing required fields", () => {
    const { name, ...rest } = validManifest;
    expect(() => validateSkillManifest(rest)).toThrow(SkillManifestError);
  });

  it("rejects invalid name pattern", () => {
    expect(() =>
      validateSkillManifest({ ...validManifest, name: "Invalid-Name" })
    ).toThrow(SkillManifestError);
  });

  it("rejects duplicate tools", () => {
    expect(() =>
      validateSkillManifest({ ...validManifest, tools: ["read-file", "read-file"] })
    ).toThrow(SkillManifestError);
  });

  it("rejects unknown fields", () => {
    expect(() =>
      validateSkillManifest({ ...validManifest, unknown: "field" })
    ).toThrow(SkillManifestError);
  });

  it("computes deterministic digest", () => {
    const manifest = validateSkillManifest(validManifest);
    const digest1 = computeSkillDigest(manifest);
    const digest2 = computeSkillDigest(manifest);
    expect(digest1).toBe(digest2);
    expect(digest1).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("accepts compositionRules.exclusiveWith", () => {
    const manifest = validateSkillManifest({
      ...validManifest,
      compositionRules: { exclusiveWith: ["auto-merge"] },
    });
    expect(manifest.compositionRules?.exclusiveWith).toEqual(["auto-merge"]);
  });
});
