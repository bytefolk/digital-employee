import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  EMPLOYEE_PROFILE_SCHEMA_VERSION,
  RUNTIME_API_VERSION,
  runtimeVersionSatisfies,
  validateProfileManifest
} from "../../packages/core/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = path.join(root, "profiles", "answer-agent", "profile.json");

async function answerAgentManifest() {
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

test("employee-profile.v1 validates the shipped answer-agent contract", async () => {
  const manifest = validateProfileManifest(await answerAgentManifest());

  assert.equal(manifest.schemaVersion, EMPLOYEE_PROFILE_SCHEMA_VERSION);
  assert.equal(RUNTIME_API_VERSION, "1.0.0");
  assert.equal(manifest.name, "answer-agent");
  assert.equal(manifest.policy.readOnly, true);
  assert.deepEqual(manifest.permissions.write, {
    requested: false,
    tools: []
  });
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(JSON.stringify(manifest).includes("apiKey"), false);
});

test("profile manifests reject unknown fields and unsupported schema versions", async () => {
  const unknown = await answerAgentManifest();
  unknown.privateDeploymentId = "must-not-travel";
  assert.throws(
    () => validateProfileManifest(unknown),
    /profile_manifest_unknown_field:manifest.privateDeploymentId/
  );

  const unsupported = await answerAgentManifest();
  unsupported.schemaVersion = "employee-profile.v2";
  assert.throws(
    () => validateProfileManifest(unsupported),
    /unsupported_profile_manifest_schema:employee-profile.v2/
  );
});

test("profile runtime compatibility is an enforced half-open SemVer range", async () => {
  assert.equal(runtimeVersionSatisfies(">=1.0.0 <2.0.0", "1.9.9"), true);
  assert.equal(runtimeVersionSatisfies(">=1.0.0 <2.0.0", "2.0.0"), false);

  const incompatible = await answerAgentManifest();
  incompatible.compatibility.runtimeApi = ">=2.0.0 <3.0.0";
  assert.throws(
    () => validateProfileManifest(incompatible),
    /incompatible_profile_runtime_api:1.0.0/
  );
});
