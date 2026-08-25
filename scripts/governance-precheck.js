#!/usr/bin/env node
// Local pre-push precheck for the PR implementation-trace gate (#197).
// Delegates to validateGithubEventFile in requirement-governance-check.js so
// the local check and the CI gate can never drift apart.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateGithubEventFile } from "./requirement-governance-check.js";

const DEFAULT_REPOSITORY_NAME = "fullstack-ai-infra/digital-employee";

const REPAIR_GUIDANCE = [
  "Repair guidance (docs/requirement-governance.md, section 'Pull request implementation trace'):",
  "- Use .github/pull_request_template.md verbatim; keep all nine required headings exactly.",
  "- Canonical requirement section needs the full canonical Issue URL, 'Consumed revision: R<positive integer>', the consumed decision comment reference, and the line 'No automatic close keywords: acknowledged'.",
  "- Never use automatic close keywords anywhere in the body or commit messages (Closes/Fixes/Resolves #N).",
  "- Requirement trace table header must be exactly: | REQ/AC IDs | Changed files / domain | Tests or review evidence |",
  "- Validation records exact commands in inline code, counts as 'PASS N/N' or 'FAIL N/N', full GitHub check URLs, and the validation ledger table.",
  "- Product review handoff names the merge ledger owner handle, the product reviewer handle, and the release packet URL or 'N/A: <reason>'.",
  "- Commit messages in base..head are scanned for close keywords; amend before pushing."
];

function normalizeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function git(repositoryRoot, args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

function deriveRepositoryName(repositoryRoot) {
  try {
    const url = git(repositoryRoot, ["remote", "get-url", "origin"]);
    const match = /github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url);
    if (match) return match[1];
  } catch {
    // No origin remote: fall back to the canonical repository identity.
  }
  return DEFAULT_REPOSITORY_NAME;
}

function resolveSha(repositoryRoot, ref) {
  try {
    return git(repositoryRoot, ["rev-parse", `${ref}^{commit}`]);
  } catch (error) {
    throw new Error(`cannot resolve ${ref} to a commit in ${repositoryRoot}: ${normalizeError(error)}`);
  }
}

export async function buildPrecheckEvent(options) {
  const repositoryRoot = options.repositoryRoot ?? process.cwd();
  const body = await readFile(options.bodyFile, "utf8");
  const baseSha = resolveSha(repositoryRoot, options.baseRef ?? "origin/main");
  const headSha = resolveSha(repositoryRoot, options.headRef ?? "HEAD");
  const repositoryName = options.repositoryName ?? deriveRepositoryName(repositoryRoot);
  const number = options.prNumber ?? 1;
  return {
    action: "opened",
    number,
    repository: { full_name: repositoryName },
    pull_request: {
      number,
      body,
      base: { repo: { full_name: repositoryName }, sha: baseSha },
      head: { repo: { full_name: repositoryName }, sha: headSha }
    }
  };
}

export async function runGovernancePrecheck(options) {
  const event = await buildPrecheckEvent(options);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "governance-precheck-"));
  const eventPath = path.join(tempDir, "event.json");
  try {
    await writeFile(eventPath, `${JSON.stringify(event, null, 2)}\n`, "utf8");
    const errors = await validateGithubEventFile(eventPath, options.repositoryRoot ?? process.cwd());
    return { errors, event };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      index += 1;
      return value;
    };
    if (arg === "--body-file") options.bodyFile = take();
    else if (arg === "--base-sha") options.baseRef = take();
    else if (arg === "--head-sha") options.headRef = take();
    else if (arg === "--pr-number") options.prNumber = Number.parseInt(take(), 10);
    else if (arg === "--repo") options.repositoryName = take();
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`governance-precheck: ${normalizeError(error)}`);
    process.exit(1);
  }
  if (options.help) {
    console.log(
      [
        "usage: node ./scripts/governance-precheck.js --body-file <path> [--base-sha <ref>] [--head-sha <ref>] [--pr-number <n>] [--repo owner/name]",
        "",
        "Validates a draft PR body against the exact CI implementation-trace gate before pushing.",
        "Defaults: --base-sha origin/main, --head-sha HEAD, --pr-number 1, --repo from the origin remote."
      ].join("\n")
    );
    return;
  }
  if (!options.bodyFile) {
    console.error("governance-precheck: --body-file <path> is required (write the draft PR body to a file first)");
    process.exit(1);
  }
  options.repositoryRoot = repositoryRoot;
  let result;
  try {
    result = await runGovernancePrecheck(options);
  } catch (error) {
    console.error(`governance-precheck: ${normalizeError(error)}`);
    process.exit(1);
  }
  if (!result.errors.length) {
    console.log("governance-precheck: PASS — body satisfies the implementation-trace gate locally");
    return;
  }
  console.error("governance-precheck: FAIL — the CI trace gate would reject this body:");
  for (const error of result.errors) console.error(`- ${error}`);
  console.error("");
  for (const line of REPAIR_GUIDANCE) console.error(line);
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
