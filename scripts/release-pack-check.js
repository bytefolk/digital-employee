#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_SPECS = [
  {
    label: "root",
    manifestPath: "package.json",
    requiredFiles: [
      "package.json",
      "dist/apps/cli/bin.js",
      "dist/packages/core/index.js",
      "dist/packages/core/index.d.ts"
    ],
    allowedFiles: ["package.json", "LICENSE", "NOTICE"],
    allowedPrefixes: ["dist/"],
    allowedPatterns: [/^README[^/]*\.md$/]
  },
  {
    label: "core",
    manifestPath: "packages/core/package.json",
    requiredFiles: ["package.json", "dist/index.js", "dist/index.d.ts"],
    allowedFiles: ["package.json"],
    allowedPrefixes: ["dist/"],
    allowedPatterns: []
  }
];

function expectedFilename(manifest) {
  const packageSlug = String(manifest.name || "")
    .replace(/^@/, "")
    .replaceAll("/", "-");
  return `${packageSlug}-${manifest.version}.tgz`;
}

export function validatePackOutput({
  label,
  manifest,
  output,
  requiredFiles,
  allowedFiles,
  allowedPrefixes,
  allowedPatterns
}) {
  if (!Array.isArray(output) || output.length !== 1) {
    return [`${label} npm pack output must contain exactly one package`];
  }

  const errors = [];
  const [pack] = output;
  if (pack?.name !== manifest.name) {
    errors.push(`${label} npm pack name must match package.json`);
  }
  if (pack?.version !== manifest.version) {
    errors.push(`${label} npm pack version must match package.json`);
  }
  if (pack?.filename !== expectedFilename(manifest)) {
    errors.push(`${label} npm pack filename is unexpected`);
  }

  if (!Array.isArray(pack?.files) || pack.files.some((file) =>
    typeof file?.path !== "string"
  )) {
    errors.push(`${label} npm pack files must contain path entries`);
    return errors;
  }

  const packedFiles = new Set(pack.files.map((file) => file.path));
  for (const requiredFile of requiredFiles) {
    if (!packedFiles.has(requiredFile)) {
      errors.push(`${label} npm pack is missing ${requiredFile}`);
    }
  }
  for (const packedFile of packedFiles) {
    const allowed = allowedFiles.includes(packedFile) ||
      allowedPrefixes.some((prefix) => packedFile.startsWith(prefix)) ||
      allowedPatterns.some((pattern) => pattern.test(packedFile));
    if (!allowed) {
      errors.push(`${label} npm pack includes unexpected ${packedFile}`);
    }
  }
  return errors;
}

async function validateArchive({ label, manifest, packDestination }) {
  try {
    const archive = await stat(
      path.join(packDestination, expectedFilename(manifest))
    );
    if (archive.isFile() && archive.size > 0) return [];
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return [`${label} npm pack archive is missing or empty`];
}

async function main() {
  const [packDestination, ...outputPaths] = process.argv.slice(2);
  if (!packDestination || outputPaths.length !== PACKAGE_SPECS.length) {
    throw new TypeError(
      "usage: release-pack-check.js <pack-directory> <root-pack.json> <core-pack.json>"
    );
  }

  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
  );
  const errors = [];
  for (const [index, spec] of PACKAGE_SPECS.entries()) {
    const [manifestText, outputText] = await Promise.all([
      readFile(path.join(repositoryRoot, spec.manifestPath), "utf8"),
      readFile(outputPaths[index], "utf8")
    ]);
    const manifest = JSON.parse(manifestText);
    const output = JSON.parse(outputText);
    errors.push(...validatePackOutput({
      label: spec.label,
      manifest,
      output,
      requiredFiles: spec.requiredFiles,
      allowedFiles: spec.allowedFiles,
      allowedPrefixes: spec.allowedPrefixes,
      allowedPatterns: spec.allowedPatterns
    }));
    errors.push(...await validateArchive({
      label: spec.label,
      manifest,
      packDestination
    }));
  }

  if (errors.length) {
    process.stderr.write(
      `release-pack-check failed:\n${errors.map((error) => `- ${error}`).join("\n")}\n`
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write("release-pack-check passed for root and core packages\n");
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `release-pack-check: ${error?.message || "unexpected_error"}\n`
    );
    process.exitCode = 2;
  });
}
