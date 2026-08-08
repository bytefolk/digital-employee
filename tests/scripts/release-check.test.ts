import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  PACKAGE_SPECS,
  validateArchive,
  validatePackOutput
} from "../../scripts/release-pack-check.js";
import { validateRelease } from "../../scripts/release-check.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

const manifest = {
  name: "@fullstack-ai-infra/digital-employee",
  version: "0.1.0",
  repository: {
    type: "git",
    url: "git+https://github.com/fullstack-ai-infra/digital-employee.git"
  },
  publishConfig: { access: "public" },
  bin: { "digital-employee": "./dist/apps/cli/bin.js" },
  types: "./dist/packages/core/index.d.ts",
  exports: {
    ".": { import: "./dist/packages/core/index.js" },
    "./core": {
      types: "./dist/packages/core/index.d.ts",
      import: "./dist/packages/core/index.js"
    }
  },
  files: ["dist", "README.md", "LICENSE"]
};
const coreManifest = {
  name: "@fullstack-ai-infra/digital-employee-core",
  version: "0.1.0",
  repository: manifest.repository,
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

test("release check rejects core repository drift", () => {
  const errors = validateRelease({
    manifest,
    coreManifest: {
      ...coreManifest,
      repository: {
        type: "git",
        url: "git+https://github.com/example/fork.git"
      }
    },
    lockfile,
    changelog,
    tag: "v0.1.0"
  });
  assert.deepEqual(errors, ["core repository must match root repository"]);
});

test("release check rejects a missing root core fallback", () => {
  const errors = validateRelease({
    manifest: {
      ...manifest,
      exports: {
        ".": manifest.exports["."]
      }
    },
    coreManifest,
    lockfile,
    changelog,
    tag: "v0.1.0"
  });
  assert.deepEqual(errors, ["root /core fallback must use compiled output"]);
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

test("pack check accepts root and core package metadata", () => {
  const [rootSpec, coreSpec] = PACKAGE_SPECS;
  assert.deepEqual(rootSpec.requiredFiles, [
    "package.json",
    "dist/apps/cli/bin.js",
    "dist/packages/core/index.js",
    "dist/packages/core/index.d.ts",
    "locales/README.md",
    "locales/en.json",
    "locales/ja.json",
    "locales/zh-CN.json"
  ]);
  assert.deepEqual(rootSpec.allowedFiles, [
    "package.json",
    "LICENSE",
    "NOTICE",
    "locales/README.md",
    "locales/en.json",
    "locales/ja.json",
    "locales/zh-CN.json"
  ]);
  assert.deepEqual(validatePackOutput({
    label: "root",
    manifest,
    output: [{
      name: manifest.name,
      version: manifest.version,
      filename: "fullstack-ai-infra-digital-employee-0.1.0.tgz",
      files: [
        { path: "package.json" },
        { path: "dist/apps/cli/bin.js" },
        { path: "dist/packages/core/index.js" },
        { path: "dist/packages/core/index.d.ts" },
        { path: "locales/README.md" },
        { path: "locales/en.json" },
        { path: "locales/ja.json" },
        { path: "locales/zh-CN.json" }
      ]
    }],
    requiredFiles: rootSpec.requiredFiles,
    allowedFiles: rootSpec.allowedFiles,
    allowedPrefixes: rootSpec.allowedPrefixes,
    allowedPatterns: rootSpec.allowedPatterns
  }), []);

  assert.deepEqual(validatePackOutput({
    label: "core",
    manifest: coreManifest,
    output: [{
      name: coreManifest.name,
      version: coreManifest.version,
      filename: "fullstack-ai-infra-digital-employee-core-0.1.0.tgz",
      files: [
        { path: "package.json" },
        { path: "dist/index.js" },
        { path: "dist/index.d.ts" }
      ]
    }],
    requiredFiles: coreSpec.requiredFiles,
    allowedFiles: coreSpec.allowedFiles,
    allowedPrefixes: coreSpec.allowedPrefixes,
    allowedPatterns: coreSpec.allowedPatterns
  }), []);
});

test("pack check rejects mismatched identity and missing files", () => {
  assert.deepEqual(validatePackOutput({
    label: "core",
    manifest: coreManifest,
    output: [{
      name: manifest.name,
      version: "0.0.9",
      filename: "wrong.tgz",
      files: [{ path: "package.json" }]
    }],
    requiredFiles: ["package.json", "dist/index.js", "dist/index.d.ts"],
    allowedFiles: ["package.json"],
    allowedPrefixes: ["dist/"],
    allowedPatterns: []
  }), [
    "core npm pack name must match package.json",
    "core npm pack version must match package.json",
    "core npm pack filename is unexpected",
    "core npm pack is missing dist/index.js",
    "core npm pack is missing dist/index.d.ts"
  ]);
  assert.deepEqual(validatePackOutput({
    label: "core",
    manifest: coreManifest,
    output: [],
    requiredFiles: [],
    allowedFiles: [],
    allowedPrefixes: [],
    allowedPatterns: []
  }), ["core npm pack output must contain exactly one package"]);
});

test("pack check rejects unexpected source paths", () => {
  assert.deepEqual(validatePackOutput({
    label: "root",
    manifest,
    output: [{
      name: manifest.name,
      version: manifest.version,
      filename: "fullstack-ai-infra-digital-employee-0.1.0.tgz",
      files: [
        { path: "package.json" },
        { path: "dist/apps/cli/bin.js" },
        { path: "dist/packages/core/index.js" },
        { path: "dist/packages/core/index.d.ts" },
        { path: "packages/core/index.ts" }
      ]
    }],
    requiredFiles: [
      "package.json",
      "dist/apps/cli/bin.js",
      "dist/packages/core/index.js",
      "dist/packages/core/index.d.ts"
    ],
    allowedFiles: ["package.json", "LICENSE", "NOTICE"],
    allowedPrefixes: ["dist/"],
    allowedPatterns: [/^README[^/]*\.md$/]
  }), ["root npm pack includes unexpected packages/core/index.ts"]);
});

test("pack check verifies archive bytes against npm pack metadata", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "release-pack-check-"));
  const archive = Buffer.from("verified package archive");
  const filename = "fullstack-ai-infra-digital-employee-0.1.0.tgz";
  const pack = {
    size: archive.length,
    integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
    shasum: createHash("sha1").update(archive).digest("hex")
  };
  try {
    await writeFile(path.join(directory, filename), archive);
    assert.deepEqual(await validateArchive({
      label: "root",
      manifest,
      pack,
      packDestination: directory
    }), []);

    await writeFile(path.join(directory, filename), "tampered");
    assert.deepEqual(await validateArchive({
      label: "root",
      manifest,
      pack,
      packDestination: directory
    }), [
      "root npm pack archive size does not match pack JSON",
      "root npm pack archive integrity does not match pack JSON",
      "root npm pack archive shasum does not match pack JSON"
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release workflow reconciles immutable artifacts independently", async () => {
  const workflowText = await readFile(
    path.join(repositoryRoot, ".github/workflows/release.yml"),
    "utf8"
  );
  const workflow = YAML.parse(workflowText);
  assert.deepEqual(
    workflow.on.workflow_dispatch.inputs.target.options,
    ["all", "npm-root", "npm-core", "github-release", "ghcr"]
  );
  assert.equal(
    workflow.on.workflow_dispatch.inputs.release_tag.required,
    false
  );
  assert.deepEqual(workflow.concurrency, {
    group: "release-publish",
    queue: "max",
    "cancel-in-progress": false
  });
  assert.equal(workflow.jobs.prepare["runs-on"], "ubuntu-latest");
  assert.match(
    workflow.jobs.prepare.steps.at(-1).run,
    /GITHUB_REF_TYPE.*tag/
  );
  assert.match(
    workflow.jobs.prepare.steps.at(-1).run,
    /git merge-base --is-ancestor.*origin\/main/
  );
  assert.match(
    workflow.jobs.prepare.steps.at(-1).run,
    /release_sha.*GITHUB_SHA/
  );
  assert.match(
    workflow.jobs.prepare.steps.at(-1).run,
    /GITHUB_REF_PROTECTED.*true/
  );
  assert.match(
    workflow.jobs.prepare.steps.at(-1).run,
    /asset-backfill/
  );
  assert.match(
    workflow.jobs.prepare.steps.at(-1).run,
    /REQUESTED_TARGET.*github-release/
  );

  const verify = workflow.jobs.verify;
  assert.equal(verify.needs, "prepare");
  assert.equal(verify.steps[0].with.ref, "${{ needs.prepare.outputs.sha }}");
  assert.ok(verify.steps.some((step: { uses?: string }) =>
    step.uses === "actions/upload-artifact@v4"
  ));
  assert.match(workflowText, /Retain verified npm packages/);
  assert.match(workflowText, /sha256sum/);
  assert.match(
    workflowText,
    /import\('@fullstack-ai-infra\/digital-employee\/core'\)/
  );
  assert.match(
    workflowText,
    /import\('@fullstack-ai-infra\/digital-employee-core'\)/
  );

  const npmRoot = workflow.jobs["npm-root"];
  const npmCore = workflow.jobs["npm-core"];
  const npmJobs = [
    [npmRoot, "npm-root"],
    [npmCore, "npm-core"]
  ] as const;
  for (const [job, target] of npmJobs) {
    assert.equal(job.needs, "verify");
    assert.equal(
      job.if,
      `\${{ github.event_name == 'push' || inputs.target == 'all' || inputs.target == '${target}' }}`
    );
    assert.equal(job["runs-on"], "ubuntu-latest");
    assert.deepEqual(job.permissions, {
      contents: "read",
      "id-token": "write"
    });
    const checkout = job.steps.find((step: { uses?: string }) =>
      step.uses === "actions/checkout@v6"
    );
    assert.equal(checkout?.with.ref, "${{ needs.verify.outputs.sha }}");
    assert.ok(job.steps.some((step: { uses?: string }) =>
      step.uses === "actions/setup-node@v6"
    ));
    assert.ok(job.steps.some((step: { run?: string }) =>
      step.run === "npm install --global npm@11.18.0"
    ));
    assert.ok(job.steps.some((step: { run?: string }) =>
      step.run?.includes("NPM_CONFIG_USERCONFIG") &&
      step.run.includes("provenance=true")
    ));
    const download = job.steps.find((step: { uses?: string }) =>
      step.uses === "actions/download-artifact@v4"
    );
    assert.deepEqual(download?.with, {
      name: "${{ needs.verify.outputs.artifact }}",
      path: "${{ runner.temp }}/release-pack"
    });
    const tagGuardIndex = job.steps.findIndex(
      (step: { name?: string }) => step.name === "Revalidate immutable release tag"
    );
    assert.notEqual(tagGuardIndex, -1);
    assert.match(job.steps[tagGuardIndex].run, /git\/ref\/tags\/\$RELEASE_TAG/);
    assert.ok(tagGuardIndex < job.steps.length - 1);
    assert.equal(job.steps.at(-1).id, "publish");
    assert.match(job.steps.at(-1).run, /npm-publish-resilient\.js/);
  }

  const rootPublish = npmRoot.steps.at(-1).run;
  const corePublish = npmCore.steps.at(-1).run;
  assert.match(rootPublish, /--pack-json.*root-pack\.json/);
  assert.match(rootPublish, /--missing-package fail/);
  assert.match(corePublish, /--pack-json.*core-pack\.json/);
  assert.match(corePublish, /--missing-package bootstrap-soft/);
  assert.match(corePublish, /--bootstrap-marker/);
  assert.doesNotMatch(workflowText, /NPM_TOKEN|NODE_AUTH_TOKEN/);
  assert.doesNotMatch(workflowText, /continue-on-error/);
  assert.doesNotMatch(workflowText, /\|\| true/);
  assert.match(workflowText, /mkdir -p "\$pack_destination"/);
  assert.match(
    workflowText,
    /npm pack --json --pack-destination "\$pack_destination"/
  );
  assert.match(
    workflowText,
    /npm pack \.\/packages\/core --json --pack-destination "\$pack_destination"/
  );
  assert.doesNotMatch(workflowText, /npm pack[^\n]*--dry-run/);
  assert.doesNotMatch(workflowText, /npm --prefix packages\/core pack/);
  assert.match(workflowText, /release-pack-check\.js/);
  assert.match(workflowText, /npm run test:coverage/);
  assert.match(
    workflow.jobs["github-release"].steps.at(-1).run,
    /Existing release asset.*different bytes/
  );
  assert.equal(
    workflow.jobs["github-release"].steps.at(-1).env.GH_REPO,
    "${{ github.repository }}"
  );
  assert.match(
    workflow.jobs["github-release"].steps.at(-1).run,
    /git\/ref\/tags\/\$RELEASE_TAG/
  );
  assert.match(
    workflow.jobs["github-release"].steps.at(-1).run,
    /Historical asset backfill requires an existing GitHub Release/
  );
  assert.equal(
    workflow.jobs["github-release"].if,
    "${{ github.event_name == 'push' || inputs.target == 'all' || inputs.target == 'github-release' }}"
  );
  assert.deepEqual(
    workflow.jobs["github-release"].steps[0].with,
    {
      name: "${{ needs.verify.outputs.artifact }}",
      path: "${{ runner.temp }}/release-pack"
    }
  );
  assert.doesNotMatch(
    workflow.jobs["github-release"].steps.at(-1).run,
    /--clobber/
  );
  assert.match(
    workflow.jobs["github-release"].steps.at(-1).run,
    /gh release download[\s\S]*cmp -s/
  );
  assert.ok(workflow.jobs.ghcr);
  assert.match(workflowText, /packages=\( \*\.tgz \)/);
  assert.match(workflowText, /assets=\( \*\.tgz \*\.tgz\.sha256 \)/);
  assert.match(workflowText, /gh release (?:create|upload)/);
  const ghcrPublish = workflow.jobs.ghcr.steps.at(-1).run;
  assert.equal(
    workflow.jobs.ghcr.if,
    "${{ github.event_name == 'push' || inputs.target == 'all' || inputs.target == 'ghcr' }}"
  );
  assert.equal(
    workflow.jobs.ghcr.steps[0].with.ref,
    "${{ needs.verify.outputs.sha }}"
  );
  const ghcrTagGuardIndex = workflow.jobs.ghcr.steps.findIndex(
    (step: { name?: string }) => step.name === "Revalidate immutable release tag"
  );
  const ghcrLoginIndex = workflow.jobs.ghcr.steps.findIndex(
    (step: { name?: string }) => step.name === "Log in to GHCR"
  );
  assert.notEqual(ghcrTagGuardIndex, -1);
  assert.notEqual(ghcrLoginIndex, -1);
  assert.ok(ghcrTagGuardIndex < ghcrLoginIndex);
  assert.match(ghcrPublish, /validate_release_image/);
  assert.match(ghcrPublish, /Existing immutable GHCR tags resolve to different images/);
  assert.match(ghcrPublish, /compare_semver/);
  assert.match(ghcrPublish, /Keeping newer GHCR latest/);
  assert.match(ghcrPublish, /Repair mode leaves the moving latest tag unchanged/);
  const repairGuardIndex = ghcrPublish.indexOf(
    'if [[ "$RELEASE_MODE" != "push" ]]'
  );
  const latestPushIndex = ghcrPublish.indexOf('docker push "$latest_ref"');
  assert.notEqual(repairGuardIndex, -1);
  assert.notEqual(latestPushIndex, -1);
  assert.ok(repairGuardIndex < latestPushIndex);
  assert.doesNotMatch(ghcrPublish, /docker push "\$image:latest"/);
  assert.equal(workflow.jobs["release-status"].if, "${{ always() }}");
  assert.match(workflowText, /Standalone core requires one-time npm bootstrap/);
  assert.match(workflowText, /NPM_ROOT_COMPLETE.*true/);
  assert.match(workflowText, /NPM_CORE_OUTCOME.*bootstrap_required/);
  const releaseStatus = workflow.jobs["release-status"].steps.at(-1).run;
  assert.match(
    releaseStatus,
    /NPM_CORE_OUTCOME.*bootstrap_required[\s\S]*REQUESTED_TARGET.*npm-core/
  );
  assert.match(
    releaseStatus,
    /Explicit npm-core reconciliation is incomplete/
  );
});
