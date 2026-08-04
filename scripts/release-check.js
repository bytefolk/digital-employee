#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STABLE_SEMVER = /^\d+\.\d+\.\d+$/;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function validateRelease({
  manifest,
  coreManifest,
  lockfile,
  changelog,
  tag
}) {
  const errors = [];
  const version = String(manifest.version || "");

  if (!STABLE_SEMVER.test(version)) {
    errors.push("package version must be a stable x.y.z version");
  }
  if (tag && tag !== `v${version}`) {
    errors.push(`release tag ${tag} does not match package version v${version}`);
  }
  if (manifest.private === true) {
    errors.push("root package must be publishable");
  }
  if (manifest.publishConfig?.access !== "public") {
    errors.push("publishConfig.access must be public");
  }
  if (manifest.bin?.["digital-employee"] !== "./dist/apps/cli/bin.js") {
    errors.push("digital-employee CLI entry point is missing");
  }
  if (manifest.types !== "./dist/packages/core/index.d.ts") {
    errors.push("root package types must use compiled declarations");
  }
  if (manifest.exports?.["."]?.import !== "./dist/packages/core/index.js") {
    errors.push("root package export must use compiled runtime output");
  }
  if (!Array.isArray(manifest.files) || !manifest.files.includes("dist")) {
    errors.push("published files must include compiled distribution artifacts");
  }
  if (["apps", "packages", "connectors", "profiles"].some((entry) =>
    manifest.files?.includes(entry)
  )) {
    errors.push("published files must not include duplicate TypeScript source trees");
  }
  if (coreManifest.version !== version) {
    errors.push("core and root package versions must match");
  }
  if (coreManifest.private === true) {
    errors.push("core package must be publishable");
  }
  if (coreManifest.publishConfig?.access !== "public") {
    errors.push("core publishConfig.access must be public");
  }
  if (
    coreManifest.main !== "./dist/index.js" ||
    coreManifest.types !== "./dist/index.d.ts" ||
    coreManifest.exports?.["."]?.import !== "./dist/index.js"
  ) {
    errors.push("core package entry points must use compiled output");
  }
  if (!Array.isArray(coreManifest.files) || !coreManifest.files.includes("dist")) {
    errors.push("core package must publish compiled distribution artifacts");
  }
  if (lockfile?.version !== version) {
    errors.push("package-lock version must match package version");
  }
  if (lockfile?.packages?.[""]?.version !== version) {
    errors.push("package-lock workspace root version must match package version");
  }
  if (lockfile?.packages?.["packages/core"]?.version !== version) {
    errors.push("package-lock core version must match package version");
  }

  const heading = new RegExp(
    `^## \\[${escapeRegExp(version)}\\] - \\d{4}-\\d{2}-\\d{2}$`,
    "m"
  );
  if (!heading.test(changelog)) {
    errors.push(`CHANGELOG.md must contain a dated ${version} release heading`);
  }

  return errors;
}

async function main() {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
  );
  const tagIndex = process.argv.indexOf("--tag");
  const tag = tagIndex === -1 ? undefined : process.argv[tagIndex + 1];
  if (tagIndex !== -1 && !tag) throw new TypeError("--tag requires a value");

  const [manifestText, coreManifestText, lockfileText, changelog] = await Promise.all([
    readFile(path.join(repositoryRoot, "package.json"), "utf8"),
    readFile(path.join(repositoryRoot, "packages/core/package.json"), "utf8"),
    readFile(path.join(repositoryRoot, "package-lock.json"), "utf8"),
    readFile(path.join(repositoryRoot, "CHANGELOG.md"), "utf8")
  ]);
  const errors = validateRelease({
    manifest: JSON.parse(manifestText),
    coreManifest: JSON.parse(coreManifestText),
    lockfile: JSON.parse(lockfileText),
    changelog,
    tag
  });
  if (errors.length) {
    process.stderr.write(
      `release-check failed:\n${errors.map((error) => `- ${error}`).join("\n")}\n`
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`release-check passed for ${tag || "package metadata"}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`release-check: ${error?.message || "unexpected_error"}\n`);
    process.exitCode = 2;
  });
}
