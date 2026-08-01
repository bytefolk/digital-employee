import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateRelease } from "../../scripts/release-check.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

const manifest = {
  name: "@fullstack-ai-infra/digital-employee",
  version: "0.1.0",
  publishConfig: { access: "public" },
  bin: { "digital-employee": "./apps/cli/bin.js" },
  files: ["apps", "packages"]
};
const coreManifest = { version: "0.1.0" };
const changelog = "# Changelog\n\n## [0.1.0] - 2026-08-01\n";

test("release check accepts aligned public release metadata", () => {
  assert.deepEqual(
    validateRelease({ manifest, coreManifest, changelog, tag: "v0.1.0" }),
    []
  );
});

test("release check rejects a mismatched tag and package versions", () => {
  const errors = validateRelease({
    manifest,
    coreManifest: { version: "0.0.9" },
    changelog,
    tag: "v0.2.0"
  });
  assert.deepEqual(errors, [
    "release tag v0.2.0 does not match package version v0.1.0",
    "core and root package versions must match"
  ]);
});

test("release check rejects private or incomplete packages", () => {
  const errors = validateRelease({
    manifest: {
      ...manifest,
      private: true,
      publishConfig: {},
      bin: {},
      files: ["packages"]
    },
    coreManifest,
    changelog: "# Changelog\n",
    tag: "v0.1.0"
  });
  assert.deepEqual(errors, [
    "root package must be publishable",
    "publishConfig.access must be public",
    "digital-employee CLI entry point is missing",
    "published files must include the application entry points",
    "CHANGELOG.md must contain a dated 0.1.0 release heading"
  ]);
});

test("release workflow has independently scoped jobs for all channels", async () => {
  const workflow = await readFile(
    path.join(repositoryRoot, ".github/workflows/release.yml"),
    "utf8"
  );
  assert.match(workflow, /^\s{2}github-release:$/m);
  assert.match(workflow, /^\s{2}npm:$/m);
  assert.match(workflow, /^\s{2}ghcr:$/m);
  assert.match(workflow, /npm publish --access public --provenance/);
  assert.match(workflow, /gh release (?:create|upload)/);
  assert.match(workflow, /docker push/);
});
