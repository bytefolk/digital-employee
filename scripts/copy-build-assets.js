#!/usr/bin/env node

import { chmod, cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(repositoryRoot, "dist");
const corePackageOutput = path.join(repositoryRoot, "packages", "core", "dist");

async function copyDirectory(name) {
  await cp(path.join(repositoryRoot, name), path.join(outputRoot, name), {
    recursive: true,
    force: true
  });
}

await mkdir(outputRoot, { recursive: true });
for (const directory of ["configs", "locales", "tests/fixtures/knowledge"]) {
  await rm(path.join(outputRoot, directory), { recursive: true, force: true });
  await copyDirectory(directory);
}
await rm(corePackageOutput, { recursive: true, force: true });
await cp(path.join(outputRoot, "packages", "core"), corePackageOutput, {
  recursive: true,
  force: true
});
const answerAgentOutput = path.join(outputRoot, "profiles", "answer-agent");
await mkdir(answerAgentOutput, { recursive: true });
await cp(
  path.join(repositoryRoot, "profiles", "answer-agent", "profile.json"),
  path.join(answerAgentOutput, "profile.json"),
  { force: true }
);
await chmod(path.join(outputRoot, "apps", "cli", "bin.js"), 0o755);
