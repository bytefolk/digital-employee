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
  bin: { "digital-employee": "./dist/apps/cli/bin.js" },
  types: "./dist/packages/core/index.d.ts",
  exports: {
    ".": { import: "./dist/packages/core/index.js" }
  },
  files: ["dist", "README.md", "LICENSE"]
};
const coreManifest = {
  version: "0.1.0",
  publishConfig: { access: "public" },
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
  exports: { ".": { import: "./dist/index.js" } },
  files: ["dist"]
};
const lockfile = {
  version: "0.1.0",
  packages: {
    "": { version: "0.1.0" },
    "packages/core": { version: "0.1.0" }
  }
};
const changelog = "# Changelog\n\n## [0.1.0] - 2026-08-01\n";

test("release check accepts aligned public release metadata", () => {
  assert.deepEqual(
    validateRelease({
      manifest,
      coreManifest,
      lockfile,
      changelog,
      tag: "v0.1.0"
    }),
    []
  );
});

test("release check rejects a mismatched tag and package versions", () => {
  const errors = validateRelease({
    manifest,
    coreManifest: { ...coreManifest, version: "0.0.9" },
    lockfile,
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
    coreManifest: {
      ...coreManifest,
      private: true,
      publishConfig: {}
    },
    lockfile,
    changelog: "# Changelog\n",
    tag: "v0.1.0"
  });
  assert.deepEqual(errors, [
    "root package must be publishable",
    "publishConfig.access must be public",
    "digital-employee CLI entry point is missing",
    "published files must include compiled distribution artifacts",
    "published files must not include duplicate TypeScript source trees",
    "core package must be publishable",
    "core publishConfig.access must be public",
    "CHANGELOG.md must contain a dated 0.1.0 release heading"
  ]);
});

test("release check rejects package-lock version drift", () => {
  const errors = validateRelease({
    manifest,
    coreManifest,
    lockfile: {
      version: "0.0.9",
      packages: {
        "": { version: "0.0.9" },
        "packages/core": { version: "0.0.9" }
      }
    },
    changelog,
    tag: "v0.1.0"
  });
  assert.deepEqual(errors, [
    "package-lock version must match package version",
    "package-lock workspace root version must match package version",
    "package-lock core version must match package version"
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
  assert.match(workflow, /^\s{6}id-token: write$/m);
  assert.match(workflow, /npm install --global npm@11\.18\.0/);
  assert.match(workflow, /npm run test:coverage/);
  assert.match(workflow, /npm --prefix packages\/core pack --dry-run/);
  assert.match(workflow, /npm publish \.\/packages\/core --access public/);
  assert.match(workflow, /npm publish --access public/);
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN/);
  assert.match(workflow, /actions\/checkout@v6/);
  assert.match(workflow, /actions\/setup-node@v6/);
  assert.match(workflow, /gh release (?:create|upload)/);
  assert.match(workflow, /docker push/);
});
