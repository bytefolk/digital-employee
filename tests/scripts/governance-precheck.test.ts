import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runGovernancePrecheck } from "../../scripts/governance-precheck.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPLETE_BODY_PATH = path.join(
  repositoryRoot,
  "fixtures/requirement-governance/v1/pr/complete.md"
);

function runGit(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function createGitFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "governance-precheck-fixture-"));
  runGit(root, ["init", "--initial-branch=main"]);
  runGit(root, ["config", "user.email", "fixture@example.com"]);
  runGit(root, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(root, "base.txt"), "base\n", "utf8");
  runGit(root, ["add", "base.txt"]);
  runGit(root, ["commit", "-m", "base fixture commit"]);
  const baseSha = runGit(root, ["rev-parse", "HEAD"]);
  await writeFile(path.join(root, "head.txt"), "head\n", "utf8");
  runGit(root, ["add", "head.txt"]);
  runGit(root, ["commit", "-m", "head fixture commit"]);
  const headSha = runGit(root, ["rev-parse", "HEAD"]);
  return { root, baseSha, headSha };
}

async function writeBody(root: string, body: string) {
  const bodyFile = path.join(root, "pr-body.md");
  await writeFile(bodyFile, body, "utf8");
  return bodyFile;
}

test("#197 AC: strict complete form passes the precheck with zero errors", async () => {
  const { root, baseSha, headSha } = await createGitFixture();
  const body = await readFile(COMPLETE_BODY_PATH, "utf8");
  const bodyFile = await writeBody(root, body);
  const result = await runGovernancePrecheck({
    bodyFile,
    baseRef: baseSha,
    headRef: headSha,
    repositoryName: "bytefolk/digital-employee",
    repositoryRoot: root
  });
  assert.deepEqual(result.errors, []);
});

test("#197 AC: consumed-revision suffix form fails (three-strike regression sample)", async () => {
  const { root, baseSha, headSha } = await createGitFixture();
  const body = (await readFile(COMPLETE_BODY_PATH, "utf8")).replace(
    "- Consumed revision: R1",
    "- Consumed revision: R1 amended after review"
  );
  const bodyFile = await writeBody(root, body);
  const result = await runGovernancePrecheck({
    bodyFile,
    baseRef: baseSha,
    headRef: headSha,
    repositoryName: "bytefolk/digital-employee",
    repositoryRoot: root
  });
  assert.ok(
    result.errors.includes("consumed revision must match R<positive integer>"),
    `expected the suffix form to fail closed, got: ${JSON.stringify(result.errors)}`
  );
});

test("#197 AC: automatic close keyword fails (three-strike regression sample)", async () => {
  const { root, baseSha, headSha } = await createGitFixture();
  const body = `${await readFile(COMPLETE_BODY_PATH, "utf8")}\nCloses #197\n`;
  const bodyFile = await writeBody(root, body);
  const result = await runGovernancePrecheck({
    bodyFile,
    baseRef: baseSha,
    headRef: headSha,
    repositoryName: "bytefolk/digital-employee",
    repositoryRoot: root
  });
  assert.ok(
    result.errors.some((error) => error.startsWith("automatic close keyword is forbidden")),
    `expected the close keyword to fail closed, got: ${JSON.stringify(result.errors)}`
  );
});

test("#197 AC: body missing required headings fails (three-strike regression sample)", async () => {
  const { root, baseSha, headSha } = await createGitFixture();
  const bodyFile = await writeBody(root, "## Summary\n\nquick fix\n");
  const result = await runGovernancePrecheck({
    bodyFile,
    baseRef: baseSha,
    headRef: headSha,
    repositoryName: "bytefolk/digital-employee",
    repositoryRoot: root
  });
  assert.ok(result.errors.length > 0);
  assert.ok(
    result.errors.some((error) => error.includes("Known limitations")),
    `expected missing-heading errors, got: ${JSON.stringify(result.errors)}`
  );
});

test("#197 AC: unresolvable base ref fails closed before any event validation", async () => {
  const { root, headSha } = await createGitFixture();
  const bodyFile = await writeBody(root, "body");
  await assert.rejects(
    runGovernancePrecheck({
      bodyFile,
      baseRef: "origin/main",
      headRef: headSha,
      repositoryName: "bytefolk/digital-employee",
      repositoryRoot: root
    }),
    /cannot resolve origin\/main/
  );
});

function runCli(args: string[]) {
  const scriptPath = path.join(repositoryRoot, "scripts/governance-precheck.js");
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
}

test("#197 AC: CLI passes on the strict complete form against the real repository", () => {
  const headSha = runGit(repositoryRoot, ["rev-parse", "HEAD"]);
  const result = runCli([
    "--body-file",
    COMPLETE_BODY_PATH,
    "--base-sha",
    headSha,
    "--head-sha",
    headSha,
    "--repo",
    "bytefolk/digital-employee"
  ]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /governance-precheck: PASS/);
});

test("#197 AC: CLI fails closed on a malformed body and prints repair guidance", async () => {
  const headSha = runGit(repositoryRoot, ["rev-parse", "HEAD"]);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "governance-precheck-cli-"));
  const bodyFile = path.join(tempDir, "bad-body.md");
  await writeFile(bodyFile, "## Summary\n\nCloses #197\n", "utf8");
  const result = runCli([
    "--body-file",
    bodyFile,
    "--base-sha",
    headSha,
    "--head-sha",
    headSha,
    "--repo",
    "bytefolk/digital-employee"
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /governance-precheck: FAIL/);
  assert.match(result.stderr, /Repair guidance/);
});

test("#197 AC: CLI requires --body-file and rejects unknown arguments", () => {
  const missing = runCli([]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--body-file/);
  const unknown = runCli(["--no-such-flag"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown argument/);
  const help = runCli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /usage: node/);
});
