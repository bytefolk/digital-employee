import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PACKAGE_SPECS } from "../../scripts/release-pack-check.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

async function readRepositoryFile(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

async function readManifest(relativePath: string): Promise<Record<string, any>> {
  return JSON.parse(await readRepositoryFile(relativePath)) as Record<string, any>;
}

// The release lane publishes exactly the two archives named in PACKAGE_SPECS.
// Every assertion below is derived from the manifests and the workflow text, so
// a future package rename updates this test by changing the files it reads.
const PUBLISH_LANE_FILES = [
  ".github/workflows/release.yml",
  ".github/workflows/ci.yml"
];

test("engine workspace package is source-only and cannot be published", async () => {
  const engine = await readManifest("packages/engine/package.json");

  assert.equal(
    engine.private,
    true,
    "packages/engine/package.json must declare private: true so npm refuses to publish it"
  );
  assert.equal(
    engine.publishConfig,
    undefined,
    "packages/engine/package.json must not carry a publishConfig; it has no publish target"
  );
});

test("root and core packages remain publishable after the engine boundary", async () => {
  const [root, core] = await Promise.all([
    readManifest("package.json"),
    readManifest("packages/core/package.json")
  ]);

  for (const [label, manifest] of [
    ["root", root],
    ["core", core]
  ] as const) {
    assert.notEqual(
      manifest.private,
      true,
      `${label} package must stay publishable; only the engine is source-only`
    );
    assert.equal(
      manifest.publishConfig?.access,
      "public",
      `${label} package must keep publishConfig.access = public`
    );
  }

  assert.notEqual(
    root.name,
    (await readManifest("packages/engine/package.json")).name,
    "the engine must not share its identity with the published root package"
  );
});

test("release lane names exactly two publish targets and never reaches the engine", async () => {
  assert.equal(
    PACKAGE_SPECS.length,
    2,
    "the release lane must verify exactly a root and a core archive"
  );
  assert.deepEqual(
    PACKAGE_SPECS.map((spec: { label: string }) => spec.label).sort(),
    ["core", "root"],
    "PACKAGE_SPECS must stay limited to the two published packages"
  );

  const engine = await readManifest("packages/engine/package.json");
  const engineName = String(engine.name);

  for (const relativePath of PUBLISH_LANE_FILES) {
    const workflow = await readRepositoryFile(relativePath);
    assert.ok(
      !workflow.includes("packages/engine"),
      `${relativePath} must not pack, publish, or repair the engine workspace path`
    );
    assert.ok(
      !workflow.includes(engineName),
      `${relativePath} must not name the engine package ${engineName}`
    );
  }

  const releaseWorkflow = await readRepositoryFile(".github/workflows/release.yml");
  const expectedNames = releaseWorkflow
    .split("\n")
    .filter((line) => line.includes("--expected-name"));
  assert.equal(
    expectedNames.length,
    2,
    "release.yml must assert an expected package name for exactly the two publish jobs"
  );
  for (const line of expectedNames) {
    assert.ok(
      !line.includes(engineName),
      `a release publish job must not target the engine package: ${line.trim()}`
    );
  }
});
