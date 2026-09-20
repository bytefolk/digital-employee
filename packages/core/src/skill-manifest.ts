// Skill manifest validation for skill-unit.v1 schema
// Implements #305: skill registration contract

import { createHash } from "crypto";

export const SKILL_MANIFEST_FILE = "skill.json";
export const SKILL_MANIFEST_VERSION = "skill-unit.v1";

export interface SkillManifest {
  schemaVersion: string;
  name: string;
  version: string;
  description: string;
  inputs: string[];
  outputs: string[];
  tools: string[];
  assets: string[];
  compositionRules?: {
    exclusiveWith?: string[];
  };
}

export class SkillManifestError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "SkillManifestError";
  }
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[a-z0-9.]+)?(\+[a-z0-9.]+)?$/;
const PORTABLE_PATH_PATTERN = /^[a-zA-Z0-9._-]+(\/[a-zA-Z0-9._-]+)*$/;

export function validateSkillManifest(data: unknown): SkillManifest {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new SkillManifestError("manifest must be an object", "invalid_manifest");
  }

  const obj = data as Record<string, unknown>;

  // Schema version check
  if (obj.schemaVersion !== SKILL_MANIFEST_VERSION) {
    throw new SkillManifestError(
      `unsupported schema version: ${obj.schemaVersion}`,
      "unsupported_schema"
    );
  }

  // Required fields
  const required = ["name", "version", "description", "inputs", "outputs", "tools", "assets"];
  for (const field of required) {
    if (!(field in obj)) {
      throw new SkillManifestError(`missing required field: ${field}`, "missing_field");
    }
  }

  // Name validation
  if (typeof obj.name !== "string" || !NAME_PATTERN.test(obj.name)) {
    throw new SkillManifestError(
      "name must be lowercase alphanumeric with hyphens, max 64 chars",
      "invalid_name"
    );
  }

  // Version validation
  if (typeof obj.version !== "string" || !VERSION_PATTERN.test(obj.version)) {
    throw new SkillManifestError("version must be valid semver", "invalid_version");
  }

  // Description validation
  if (typeof obj.description !== "string" || obj.description.trim() === "") {
    throw new SkillManifestError("description must be non-empty string", "invalid_description");
  }

  // Array fields validation
  const validateStringArray = (field: string, value: unknown): string[] => {
    if (!Array.isArray(value)) {
      throw new SkillManifestError(`${field} must be an array`, "invalid_field");
    }
    const items = value as unknown[];
    const result: string[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      if (typeof item !== "string") {
        throw new SkillManifestError(`${field} items must be strings`, "invalid_field");
      }
      if (seen.has(item)) {
        throw new SkillManifestError(`${field} must be unique`, "duplicate_item");
      }
      seen.add(item);
      result.push(item);
    }
    return result;
  };

  const inputs = validateStringArray("inputs", obj.inputs);
  const outputs = validateStringArray("outputs", obj.outputs);
  const tools = validateStringArray("tools", obj.tools);

  // Assets validation (portable paths)
  if (!Array.isArray(obj.assets)) {
    throw new SkillManifestError("assets must be an array", "invalid_field");
  }
  const assets: string[] = [];
  const seenAssets = new Set<string>();
  for (const asset of obj.assets) {
    if (typeof asset !== "string") {
      throw new SkillManifestError("assets items must be strings", "invalid_field");
    }
    if (!PORTABLE_PATH_PATTERN.test(asset)) {
      throw new SkillManifestError(
        `asset path must be portable (no backslashes, no parent traversal): ${asset}`,
        "invalid_asset_path"
      );
    }
    if (seenAssets.has(asset)) {
      throw new SkillManifestError("assets must be unique", "duplicate_item");
    }
    seenAssets.add(asset);
    assets.push(asset);
  }

  // Composition rules (optional)
  let compositionRules: SkillManifest["compositionRules"];
  if ("compositionRules" in obj) {
    const rules = obj.compositionRules;
    if (!rules || typeof rules !== "object" || Array.isArray(rules)) {
      throw new SkillManifestError("compositionRules must be an object", "invalid_field");
    }
    const rulesObj = rules as Record<string, unknown>;
    if ("exclusiveWith" in rulesObj) {
      const exclusiveWith = validateStringArray("compositionRules.exclusiveWith", rulesObj.exclusiveWith);
      for (const name of exclusiveWith) {
        if (!NAME_PATTERN.test(name)) {
          throw new SkillManifestError(
            `exclusiveWith name must match name pattern: ${name}`,
            "invalid_name"
          );
        }
      }
      compositionRules = { exclusiveWith };
    }
    // Reject unknown fields in compositionRules
    for (const key of Object.keys(rulesObj)) {
      if (key !== "exclusiveWith") {
        throw new SkillManifestError(`unknown field in compositionRules: ${key}`, "unknown_field");
      }
    }
  }

  // Reject unknown top-level fields
  const allowedKeys = new Set([...required, "compositionRules", "schemaVersion"]);
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.has(key)) {
      throw new SkillManifestError(`unknown field: ${key}`, "unknown_field");
    }
  }

  return {
    schemaVersion: SKILL_MANIFEST_VERSION,
    name: obj.name,
    version: obj.version,
    description: obj.description,
    inputs,
    outputs,
    tools,
    assets,
    compositionRules,
  };
}

export function computeSkillDigest(manifest: SkillManifest): string {
  const canonical = JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    inputs: manifest.inputs,
    outputs: manifest.outputs,
    tools: manifest.tools,
    assets: manifest.assets,
    compositionRules: manifest.compositionRules,
  });
  const hash = createHash("sha256").update(canonical).digest("hex");
  return `sha256:${hash}`;
}
