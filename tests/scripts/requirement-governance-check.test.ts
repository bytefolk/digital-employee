import assert from "node:assert/strict";
import {
  access,
  cp,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  MAX_FIXTURE_BYTES,
  validateCiWorkflow,
  validateDecisionExampleContinuity,
  validateFixtureCorpus,
  validateGithubEventFile,
  validateGovernanceGuide,
  validateIssueTemplate,
  validatePullRequestTemplate,
  validatePullRequestTrace
} from "../../scripts/requirement-governance-check.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const checkerPath = path.join(
  repositoryRoot,
  "scripts/requirement-governance-check.js"
);
const fixtureRoot = path.join(
  repositoryRoot,
  "fixtures/requirement-governance/v1"
);

async function readRepositoryFile(relativePath: string) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

async function readFixture(name: string) {
  return readFile(path.join(fixtureRoot, "pr", name), "utf8");
}

function fillPullRequestTemplate(source: string) {
  return source
    .replace(
      /- Canonical Issue URL:.*$/m,
      "- Canonical Issue URL: https://github.com/fullstack-ai-infra/digital-employee/issues/95"
    )
    .replace(/- Consumed revision:.*$/m, "- Consumed revision: R1")
    .replace(
      /- No automatic close keywords:.*$/m,
      "- No automatic close keywords: acknowledged"
    )
    .replace(
      "| REQ-NNN / AC-NNN |  |  |",
      "| REQ-001 / AC-001 | `.github/pull_request_template.md` | `npm run governance:check` (PASS: template contract) |"
    )
    .replace(
      "<!-- List each changed file group, its owner, and why it belongs in this requirement. -->",
      "- Repository governance: PR template and checker contract only.\n- Product runtime: unchanged."
    )
    .replace(
      "<!-- Describe the user-visible change, implementation boundary, and explicit non-goals. -->",
      "Keep the contributor template and CI parser byte-level compatible without changing runtime behavior."
    )
    .replace(
      /- Exact commands:.*$/m,
      "- Exact commands: `npm run governance:check`"
    )
    .replace(
      /- Observed counts\/results:.*$/m,
      "- Observed counts/results: PASS, 1/1 completed template body accepted"
    )
    .replace(
      /- Check URLs:.*$/m,
      "- Check URLs: NOT VERIFIED: local template conformance fixture has no CI URL"
    )
    .replace(
      "| V1 | AC-NNN |  |  |  |  |  | PASS / FAIL / NOT VERIFIED / N/A |",
      "| V1 | AC-001 | Filled template passes the actual parser | `npm run governance:check` | Node.js 20+ | Parser accepts one complete body | 1/1 template body accepted | PASS |"
    )
    .replaceAll("- [ ]", "- [x]")
    .replace(
      "<!-- Security findings, compatibility range, migration requirements, and evidence visibility. -->",
      "No dependency, credential, runtime, or compatibility surface changes."
    )
    .replace(
      '<!-- List unverified platforms, unavailable environments, accepted fixture boundaries, and remaining HOLD conditions. Use "None" only after review. -->',
      "Real fork checkout remains NOT VERIFIED and is recorded in the governance guide."
    )
    .replace(
      "<!-- Describe permissions, data flow, rollback steps, and any irreversible effect. -->",
      "Rollback is one governance-only revert; there is no product data migration."
    )
    .replace(/- Merge ledger owner:.*$/m, "- Merge ledger owner: @maintainer")
    .replace(/- Product reviewer:.*$/m, "- Product reviewer: @product-owner")
    .replace(
      /- Milestone or release packet:.*$/m,
      "- Milestone or release packet: N/A: local template conformance is not a milestone delivery"
    )
    .replace(
      /- Merge, CI, release, and model judgment do not accept or close the Issue:.*$/m,
      "- Merge, CI, release, and model judgment do not accept or close the Issue: acknowledged"
    );
}

async function copyCorpus() {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "requirement-governance-")
  );
  const corpus = path.join(temporaryRoot, "corpus");
  await cp(fixtureRoot, corpus, { recursive: true });
  return { temporaryRoot, corpus };
}

async function mutateManifest(
  corpus: string,
  mutate: (manifest: any) => void
) {
  const manifestPath = path.join(corpus, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  mutate(manifest);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function mutateIssue(source: string, mutate: (form: any) => void) {
  const form = YAML.parse(source);
  mutate(form);
  return YAML.stringify(form);
}

function mutateDecisionExample(
  source: string,
  heading: string,
  mutate: (section: string) => string
) {
  const headingText = `### ${heading}`;
  const start = source.indexOf(headingText);
  assert.notEqual(start, -1, `missing decision heading: ${heading}`);
  const remainder = source.slice(start + headingText.length);
  const next = remainder.search(/^#{1,3}\s+/m);
  const end = next === -1
    ? source.length
    : start + headingText.length + next;
  return `${source.slice(0, start)}${mutate(source.slice(start, end))}${source.slice(end)}`;
}

function decisionEnvelope(source: string, heading: string) {
  let envelope = "";
  mutateDecisionExample(source, heading, (section) => {
    const match = section.match(
      /<!-- requirement-decision:v1 -->\s*```yaml\s*\r?\n[\s\S]*?\r?\n```/
    );
    assert.ok(match, `missing decision envelope: ${heading}`);
    envelope = match[0];
    return section;
  });
  return envelope;
}

function runCli(args: string[], cwd = repositoryRoot) {
  return spawnSync(process.execPath, [checkerPath, ...args], {
    cwd,
    encoding: "utf8",
    shell: false
  });
}

function runGit(cwd: string, args: string[]) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message || "git failed");
  return result.stdout.trim();
}

async function createGitFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "requirement-event-git-"));
  runGit(root, ["init", "--quiet", "--initial-branch=main"]);
  runGit(root, ["config", "user.name", "Requirement Fixture"]);
  runGit(root, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(path.join(root, "tracked.txt"), "base\n");
  runGit(root, ["add", "tracked.txt"]);
  runGit(root, ["commit", "--quiet", "-m", "base"]);
  const baseSha = runGit(root, ["rev-parse", "HEAD"]);
  await writeFile(path.join(root, "tracked.txt"), "clean head\n");
  runGit(root, ["add", "tracked.txt"]);
  runGit(root, ["commit", "--quiet", "-m", "Implement requirement trace"]);
  const headSha = runGit(root, ["rev-parse", "HEAD"]);
  return { root, baseSha, headSha };
}

function githubEvent(body: unknown, baseSha: string, headSha: string) {
  return {
    action: "opened",
    number: 95,
    repository: { full_name: "fullstack-ai-infra/digital-employee" },
    pull_request: {
      body,
      base: {
        sha: baseSha,
        repo: { full_name: "fullstack-ai-infra/digital-employee" }
      },
      head: {
        sha: headSha,
        repo: { full_name: "contributor/digital-employee" }
      }
    }
  };
}

test("complete PR trace is substantive and maps a canonical revision", async () => {
  assert.deepEqual(validatePullRequestTrace(await readFixture("complete.md")), []);
});

test("a contributor can fill the repository PR template into a valid trace", async () => {
  const template = await readRepositoryFile(".github/pull_request_template.md");
  const completed = fillPullRequestTemplate(template);
  assert.deepEqual(validatePullRequestTemplate(template), []);
  assert.deepEqual(validatePullRequestTrace(completed), []);
});

test("automatic close detector covers colon, case, full URL, and cross-repository syntax", async () => {
  assert.deepEqual(validatePullRequestTrace(await readFixture("automatic-close.md")), [
    "automatic close keyword is forbidden: Fixes: #95"
  ]);
  assert.deepEqual(
    validatePullRequestTrace(await readFixture("automatic-close-full-url.md")),
    [
      "automatic close keyword is forbidden: CLOSES: https://github.com/fullstack-ai-infra/digital-employee/issues/95"
    ]
  );
  assert.deepEqual(
    validatePullRequestTrace(await readFixture("automatic-close-cross-repo.md")),
    [
      "automatic close keyword is forbidden: Resolves fullstack-ai-infra/digital-employee#95"
    ]
  );
});

test("PR trace rejects missing and hollow required sections", async () => {
  assert.deepEqual(
    validatePullRequestTrace(await readFixture("missing-known-limitations.md")),
    ["missing required heading: Known limitations"]
  );
  const errors = validatePullRequestTrace(await readFixture("hollow.md"));
  assert.ok(errors.includes("section is hollow or placeholder-only: File domains"));
  assert.ok(errors.includes(
    "requirement trace row 1 needs REQ/AC IDs, a substantive domain, and substantive evidence"
  ));
  assert.ok(errors.includes("validation ledger needs one complete 8-cell row with an allowed status"));
  assert.ok(errors.includes("product handoff acknowledgement is missing"));

  const punctuationOnly = (await readFixture("complete.md")).replace(
    "- Repository governance: Issue/PR templates, maintainer guide, offline fixtures, and CI checker only.\n- Product runtime: unchanged.",
    "..."
  );
  assert.ok(
    validatePullRequestTrace(punctuationOnly).includes(
      "section is hollow or placeholder-only: File domains"
    )
  );
});

test("PR trace validates every nonseparator row", async () => {
  assert.deepEqual(
    validatePullRequestTrace(await readFixture("partial-trace-row.md")),
    [
      "requirement trace row 2 needs REQ/AC IDs, a substantive domain, and substantive evidence"
    ]
  );
});

test("PR trace rejects shorthand Issue references and invalid revisions", async () => {
  const invalid = (await readFixture("complete.md"))
    .replace(
      "https://github.com/fullstack-ai-infra/digital-employee/issues/95",
      "#95"
    )
    .replace("Consumed revision: R1", "Consumed revision: latest");
  assert.deepEqual(validatePullRequestTrace(invalid), [
    "canonical Issue must be a full GitHub Issue URL",
    "consumed revision must match R<positive integer>"
  ]);
});

test("PR trace requires exact evidence and exact product handoff fields", async () => {
  const complete = await readFixture("complete.md");
  const withCheckUrl = complete.replace(
    "- Check URLs: NOT VERIFIED: this local fixture has no authoritative CI check URL",
    "- Check URLs: https://github.com/fullstack-ai-infra/digital-employee/actions/runs/123456789"
  );
  assert.deepEqual(validatePullRequestTrace(withCheckUrl), []);

  const invalid = complete
    .replace("- Exact commands: `npm run governance:check`", "- Exact commands: TODO")
    .replace(
      "- Observed counts/results: PASS, 7/7 allowlisted PR fixtures matched expected outcomes",
      "- Observed counts/results: PASS"
    )
    .replace(
      "- Check URLs: NOT VERIFIED: this local fixture has no authoritative CI check URL",
      "- Check URLs: N/A"
    )
    .replace("- Merge ledger owner: @maintainer", "- Merge ledger owner:")
    .replace(
      "- Milestone or release packet: N/A: this fixture is not a milestone delivery",
      "- Milestone or release packet: N/A"
    );
  const errors = validatePullRequestTrace(invalid);
  assert.ok(errors.includes("exact commands need copyable inline code or NOT VERIFIED: <reason>"));
  assert.ok(errors.includes("observed counts/results need PASS|FAIL plus N/N, or NOT VERIFIED: <reason>"));
  assert.ok(errors.includes("check URLs need a full GitHub URL or NOT VERIFIED: <reason>"));
  assert.ok(errors.includes("product handoff needs an exact merge ledger owner handle"));
  assert.ok(errors.includes("product handoff needs a full packet URL or N/A: <reason>"));
});

test("PR trace input size is bounded", async () => {
  const oversized = `${await readFixture("complete.md")}\n${"x".repeat(MAX_FIXTURE_BYTES)}`;
  assert.equal(
    validatePullRequestTrace(oversized)[0],
    `PR trace exceeds ${MAX_FIXTURE_BYTES} bytes`
  );
});

test("repository Issue, PR, CI, and governance guide contracts are complete", async () => {
  const [issue, pullRequest, ci, guide] = await Promise.all([
    readRepositoryFile(".github/ISSUE_TEMPLATE/roadmap_item.yml"),
    readRepositoryFile(".github/pull_request_template.md"),
    readRepositoryFile(".github/workflows/ci.yml"),
    readRepositoryFile("docs/requirement-governance.md")
  ]);
  assert.deepEqual(validateIssueTemplate(issue), []);
  assert.deepEqual(validatePullRequestTemplate(pullRequest), []);
  assert.deepEqual(validateCiWorkflow(ci), []);
  assert.deepEqual(validateGovernanceGuide(guide), []);
});

test("decision examples reject a contiguous series shifted from R2 through R10", async () => {
  const guide = await readRepositoryFile("docs/requirement-governance.md");
  const specifications = [
    ["Additive", "R1", "R2", "R2", "R3"],
    ["Narrowing", "R2", "R3", "R3", "R4"],
    ["Breaking or compatibility", "R3", "R4", "R4", "R5"],
    ["Dependency", "R4", "R5", "R5", "R6"],
    ["Priority", "R5", "R6", "R6", "R7"],
    ["HOLD", "R6", "R7", "R7", "R8"],
    ["Release from HOLD", "R7", "R8", "R8", "R9"],
    ["Duplicate", "R8", "R9", "R9", "R10"]
  ];
  let shifted = guide;
  for (const [
    heading,
    oldPrevious,
    oldResulting,
    newPrevious,
    newResulting
  ] of specifications) {
    shifted = mutateDecisionExample(shifted, heading, (section) =>
      section
        .replace(`previousRevision: ${oldPrevious}`, `previousRevision: ${newPrevious}`)
        .replace(`resultingRevision: ${oldResulting}`, `resultingRevision: ${newResulting}`)
    );
  }
  assert.deepEqual(validateDecisionExampleContinuity(shifted), [
    "semantic decision example Additive revisions must be exactly R1→R2",
    "semantic decision example Narrowing revisions must be exactly R2→R3",
    "semantic decision example Breaking or compatibility revisions must be exactly R3→R4",
    "semantic decision example Dependency revisions must be exactly R4→R5",
    "semantic decision example Priority revisions must be exactly R5→R6",
    "semantic decision example HOLD revisions must be exactly R6→R7",
    "semantic decision example Release from HOLD revisions must be exactly R7→R8",
    "semantic decision example Duplicate revisions must be exactly R8→R9"
  ]);
});

test("decision examples reject a wrong or unknown decision type", async () => {
  const guide = await readRepositoryFile("docs/requirement-governance.md");
  const wrongType = mutateDecisionExample(guide, "Dependency", (section) =>
    section.replace("decisionType: dependency", "decisionType: unknown")
  );
  assert.deepEqual(validateDecisionExampleContinuity(wrongType), [
    "semantic decision example Dependency decisionType must be dependency"
  ]);
});

test("decision examples reject content swapped between headings", async () => {
  const guide = await readRepositoryFile("docs/requirement-governance.md");
  const additive = decisionEnvelope(guide, "Additive");
  const narrowing = decisionEnvelope(guide, "Narrowing");
  const token = "<!-- swapped-decision-envelope -->";
  let swapped = mutateDecisionExample(guide, "Additive", (section) =>
    section.replace(additive, token)
  );
  swapped = mutateDecisionExample(swapped, "Narrowing", (section) =>
    section.replace(narrowing, additive)
  );
  swapped = swapped.replace(token, narrowing);
  assert.deepEqual(validateDecisionExampleContinuity(swapped), [
    "semantic decision example Additive decisionType must be additive",
    "semantic decision example Additive revisions must be exactly R1→R2",
    "semantic decision example Narrowing decisionType must be narrowing",
    "semantic decision example Narrowing revisions must be exactly R2→R3"
  ]);
});

test("decision examples reject a wrong envelope schema", async () => {
  const guide = await readRepositoryFile("docs/requirement-governance.md");
  const wrongSchema = mutateDecisionExample(guide, "Priority", (section) =>
    section.replace(
      "schemaVersion: requirement-decision.v1",
      "schemaVersion: requirement-decision.v2"
    )
  );
  assert.deepEqual(validateDecisionExampleContinuity(wrongSchema), [
    "semantic decision example Priority schemaVersion must be requirement-decision.v1"
  ]);
});

test("decision examples reject a missing or extra envelope", async () => {
  const guide = await readRepositoryFile("docs/requirement-governance.md");
  const additive = decisionEnvelope(guide, "Additive");
  const missing = mutateDecisionExample(guide, "Additive", (section) =>
    section.replace(additive, "")
  );
  const extra = mutateDecisionExample(guide, "Additive", (section) =>
    section.replace(additive, `${additive}\n\n${additive}`)
  );
  const expected = [
    "semantic decision examples need exactly 8 requirement-decision.v1 envelopes",
    "semantic decision example Additive needs exactly one requirement-decision.v1 envelope"
  ];
  assert.deepEqual(validateDecisionExampleContinuity(missing), expected);
  assert.deepEqual(validateDecisionExampleContinuity(extra), expected);
});

test("governance guide enforces semantic R8 to R9 decision continuity", async () => {
  const guide = await readRepositoryFile("docs/requirement-governance.md");
  assert.deepEqual(validateDecisionExampleContinuity(guide), []);
  const invalid = guide.replace(
    'oldDecision: "status=in-progress; this Issue independently owns REQ-001 and AC-001."',
    'oldDecision: "status=needs-design; this Issue independently owns REQ-001 and AC-001."'
  );
  assert.ok(
    validateDecisionExampleContinuity(invalid).includes(
      "semantic R8→R9 continuity requires duplicate.oldDecision status to equal release.newDecision status"
    )
  );
});

test("Issue Form rejects an invalid field type", async () => {
  const source = await readRepositoryFile(".github/ISSUE_TEMPLATE/roadmap_item.yml");
  const invalid = mutateIssue(source, (form) => {
    form.body.find((entry: any) => entry.id === "lifecycle").type = "textarea";
  });
  assert.ok(
    validateIssueTemplate(invalid).includes(
      "Issue template field lifecycle must have type dropdown"
    )
  );
});

test("Issue Form rejects duplicate and unexpected IDs", async () => {
  const source = await readRepositoryFile(".github/ISSUE_TEMPLATE/roadmap_item.yml");
  const duplicate = mutateIssue(source, (form) => {
    const evidence = form.body.find((entry: any) => entry.id === "evidence");
    form.body.push(structuredClone(evidence));
  });
  assert.ok(
    validateIssueTemplate(duplicate).includes(
      "Issue template has duplicate field id: evidence"
    )
  );

  const unexpected = mutateIssue(source, (form) => {
    form.body.find((entry: any) => entry.id === "history").id = "surprise";
  });
  const errors = validateIssueTemplate(unexpected);
  assert.ok(errors.includes("Issue template has unexpected field id: surprise"));
  assert.ok(errors.includes("Issue template is missing field: history"));
});

test("Issue Form rejects inconsistent lifecycle defaults and extra top-level keys", async () => {
  const source = await readRepositoryFile(".github/ISSUE_TEMPLATE/roadmap_item.yml");
  const inconsistent = mutateIssue(source, (form) => {
    const current = form.body.find((entry: any) => entry.id === "current_record");
    current.attributes.value = current.attributes.value.replace(
      "status: needs-design",
      "status: ready"
    );
    form.extra = true;
  });
  const errors = validateIssueTemplate(inconsistent);
  assert.ok(errors.includes("Issue template has unexpected or missing top-level keys"));
  assert.ok(errors.includes("Issue lifecycle default must consistently be needs-design"));
});

test("fixture corpus is allowlisted and matches seven exact outcomes", async () => {
  const result = await validateFixtureCorpus(fixtureRoot);
  assert.equal(result.fixtureCount, 7);
  assert.deepEqual(result.errors, []);
});

test("fixture corpus rejects traversal", async () => {
  const temporary = await copyCorpus();
  try {
    await mutateManifest(temporary.corpus, (manifest) => {
      manifest.prExamples[0].file = "../outside.md";
    });
    const result = await validateFixtureCorpus(temporary.corpus);
    assert.ok(
      result.errors.includes(
        "fixture[0]: fixture path is not a safe POSIX relative path: ../outside.md"
      )
    );
  } finally {
    await rm(temporary.temporaryRoot, { recursive: true, force: true });
  }
});

test("fixture corpus rejects a symlink manifest", async () => {
  const temporary = await copyCorpus();
  try {
    const manifest = path.join(temporary.corpus, "manifest.json");
    await rename(manifest, path.join(temporary.corpus, "manifest-target.json"));
    await symlink("manifest-target.json", manifest);
    assert.deepEqual(await validateFixtureCorpus(temporary.corpus), {
      errors: ["fixture manifest must be a regular non-symlink file"],
      fixtureCount: 0
    });
  } finally {
    await rm(temporary.temporaryRoot, { recursive: true, force: true });
  }
});

test("fixture corpus rejects a symlink PR directory", async () => {
  const temporary = await copyCorpus();
  try {
    const pr = path.join(temporary.corpus, "pr");
    await rename(pr, path.join(temporary.corpus, "pr-target"));
    await symlink("pr-target", pr);
    const result = await validateFixtureCorpus(temporary.corpus);
    assert.ok(
      result.errors.includes("fixture pr directory must be a non-symlink directory")
    );
  } finally {
    await rm(temporary.temporaryRoot, { recursive: true, force: true });
  }
});

test("fixture corpus rejects a symlink fixture file", async () => {
  const temporary = await copyCorpus();
  try {
    const fixture = path.join(temporary.corpus, "pr", "complete.md");
    const target = path.join(temporary.corpus, "complete-target.md");
    await rename(fixture, target);
    await symlink("../complete-target.md", fixture);
    const result = await validateFixtureCorpus(temporary.corpus);
    assert.ok(
      result.errors.includes(
        "fixture pr/complete.md must be a regular non-symlink file"
      )
    );
  } finally {
    await rm(temporary.temporaryRoot, { recursive: true, force: true });
  }
});

test("fixture corpus rejects missing, duplicate, and unlisted files", async () => {
  const missing = await copyCorpus();
  try {
    await unlink(path.join(missing.corpus, "pr", "complete.md"));
    const result = await validateFixtureCorpus(missing.corpus);
    assert.ok(
      result.errors.some((error) => error.startsWith("fixture pr/complete.md is missing:"))
    );
  } finally {
    await rm(missing.temporaryRoot, { recursive: true, force: true });
  }

  const duplicate = await copyCorpus();
  try {
    await mutateManifest(duplicate.corpus, (manifest) => {
      manifest.prExamples.push(structuredClone(manifest.prExamples[0]));
    });
    const result = await validateFixtureCorpus(duplicate.corpus);
    assert.ok(
      result.errors.includes("fixture file is listed more than once: pr/complete.md")
    );
  } finally {
    await rm(duplicate.temporaryRoot, { recursive: true, force: true });
  }

  const unlisted = await copyCorpus();
  try {
    await writeFile(path.join(unlisted.corpus, "pr", "unlisted.md"), "public fixture\n");
    const result = await validateFixtureCorpus(unlisted.corpus);
    assert.ok(result.errors.some((error) => error.startsWith("fixture allowlist mismatch:")));
  } finally {
    await rm(unlisted.temporaryRoot, { recursive: true, force: true });
  }
});

test("GitHub event validator accepts every configured action and a fork head", async () => {
  const fixture = await createGitFixture();
  try {
    const eventPath = path.join(fixture.root, "event.json");
    const event = githubEvent(
      await readFixture("complete.md"),
      fixture.baseSha,
      fixture.headSha
    );
    for (const action of ["opened", "synchronize", "reopened", "edited"]) {
      event.action = action;
      await writeFile(eventPath, JSON.stringify(event));
      assert.deepEqual(
        await validateGithubEventFile(eventPath, fixture.root),
        []
      );
    }
    const result = runCli(["--github-event-file", eventPath], fixture.root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /body and commit range/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("GitHub event validator rescans a force-pushed replacement head", async () => {
  const fixture = await createGitFixture();
  try {
    const eventPath = path.join(fixture.root, "event.json");
    const event = githubEvent(
      await readFixture("complete.md"),
      fixture.baseSha,
      fixture.headSha
    );
    await writeFile(eventPath, JSON.stringify(event));
    assert.deepEqual(await validateGithubEventFile(eventPath, fixture.root), []);

    runGit(fixture.root, [
      "switch",
      "--quiet",
      "--create",
      "replacement",
      fixture.baseSha
    ]);
    await writeFile(path.join(fixture.root, "tracked.txt"), "replacement head\n");
    runGit(fixture.root, ["add", "tracked.txt"]);
    runGit(fixture.root, ["commit", "--quiet", "-m", "Fixes #95"]);
    const replacementHead = runGit(fixture.root, ["rev-parse", "HEAD"]);
    event.action = "synchronize";
    event.pull_request.head.sha = replacementHead;
    await writeFile(eventPath, JSON.stringify(event));

    const errors = await validateGithubEventFile(eventPath, fixture.root);
    assert.deepEqual(errors, [
      `automatic close keyword is forbidden in commit ${replacementHead}: Fixes #95`
    ]);
    const result = runCli(["--github-event-file", eventPath], fixture.root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /automatic close keyword is forbidden in commit/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("GitHub event validator rejects invalid, missing, and unreachable identities", async () => {
  const fixture = await createGitFixture();
  try {
    const eventPath = path.join(fixture.root, "event.json");
    const valid = githubEvent(
      await readFixture("complete.md"),
      fixture.baseSha,
      fixture.headSha
    );

    const invalidSha = structuredClone(valid);
    invalidSha.pull_request.base.sha = "not-a-sha";
    await writeFile(eventPath, JSON.stringify(invalidSha));
    assert.ok(
      (await validateGithubEventFile(eventPath, fixture.root)).includes(
        "GitHub event base SHA must be exactly 40 lowercase hexadecimal characters"
      )
    );

    const missingSha = structuredClone(valid);
    delete (missingSha.pull_request.head as { sha?: string }).sha;
    await writeFile(eventPath, JSON.stringify(missingSha));
    assert.ok(
      (await validateGithubEventFile(eventPath, fixture.root)).includes(
        "GitHub event head SHA must be exactly 40 lowercase hexadecimal characters"
      )
    );

    const unreachableSha = structuredClone(valid);
    unreachableSha.pull_request.head.sha = "f".repeat(40);
    await writeFile(eventPath, JSON.stringify(unreachableSha));
    assert.deepEqual(await validateGithubEventFile(eventPath, fixture.root), [
      `GitHub event head SHA is not a reachable local commit: ${"f".repeat(40)}`
    ]);

    const invalidEnvelope = structuredClone(valid);
    invalidEnvelope.action = "closed";
    invalidEnvelope.number = 0;
    invalidEnvelope.pull_request.base.repo.full_name = "another/repository";
    await writeFile(eventPath, JSON.stringify(invalidEnvelope));
    const envelopeErrors = await validateGithubEventFile(eventPath, fixture.root);
    assert.ok(envelopeErrors.includes(
      "GitHub event action must be opened, synchronize, reopened, or edited"
    ));
    assert.ok(envelopeErrors.includes(
      "GitHub event must contain a positive pull request number"
    ));
    assert.ok(envelopeErrors.includes(
      "GitHub event base repository must match event.repository.full_name"
    ));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("GitHub event validator rejects null and empty PR bodies", async () => {
  const fixture = await createGitFixture();
  try {
    const eventPath = path.join(fixture.root, "event.json");
    for (const body of [null, "", "   "]) {
      await writeFile(
        eventPath,
        JSON.stringify(githubEvent(body, fixture.baseSha, fixture.headSha))
      );
      assert.deepEqual(await validateGithubEventFile(eventPath, fixture.root), [
        "GitHub event pull_request.body must be a nonempty string"
      ]);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("GitHub event CLI rejects a hollow actual PR body", async () => {
  const fixture = await createGitFixture();
  try {
    const eventPath = path.join(fixture.root, "event.json");
    await writeFile(
      eventPath,
      JSON.stringify(githubEvent(
        await readFixture("hollow.md"),
        fixture.baseSha,
        fixture.headSha
      ))
    );
    const result = runCli(["--github-event-file", eventPath], fixture.root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /section is hollow or placeholder-only/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("GitHub event file input never evaluates PR body as shell source", async () => {
  const fixture = await createGitFixture();
  try {
    const sentinel = path.join(fixture.root, "must-not-exist");
    const body = (await readFixture("complete.md")).replace(
      "Add an auditable requirement-to-acceptance path for revision R1.",
      `Treat $(touch ${sentinel}) as inert public text. Add an auditable path.`
    );
    const eventPath = path.join(fixture.root, "event.json");
    await writeFile(
      eventPath,
      JSON.stringify(githubEvent(body, fixture.baseSha, fixture.headSha))
    );
    const result = runCli(["--github-event-file", eventPath], fixture.root);
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(access(sentinel));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("CI contract enforces the exact pull-request action set and order", async () => {
  const ci = await readRepositoryFile(".github/workflows/ci.yml");
  const expectedError =
    "CI pull_request types must be exactly opened, synchronize, reopened, edited in that order";
  const missingEdited = ci.replace("      - edited\n", "");
  const wrongOrder = ci.replace(
    "      - synchronize\n      - reopened\n",
    "      - reopened\n      - synchronize\n"
  );
  const extraType = ci.replace(
    "      - edited\n",
    "      - edited\n      - closed\n"
  );
  assert.ok(validateCiWorkflow(missingEdited).includes(expectedError));
  assert.ok(validateCiWorkflow(wrongOrder).includes(expectedError));
  assert.ok(validateCiWorkflow(extraType).includes(expectedError));
});

test("CI contract preserves push main, full history, and the Node 22-only gate", async () => {
  const ci = await readRepositoryFile(".github/workflows/ci.yml");
  assert.ok(
    validateCiWorkflow(ci.replace("      - main\n", "      - next\n")).includes(
      "CI push branches must remain exactly main"
    )
  );
  assert.ok(
    validateCiWorkflow(ci.replaceAll("          fetch-depth: 0", "          fetch-depth: 1")).includes(
      "CI test checkout must use actions/checkout@v6 with fetch-depth 0"
    )
  );
  assert.ok(
    validateCiWorkflow(ci.replace("          - 22\n", "          - 23\n")).includes(
      "CI test matrix must contain exactly one Node 22 lane"
    )
  );
  assert.ok(
    validateCiWorkflow(ci.replace("matrix.node-version == 22", "matrix.node-version == 24")).includes(
      "CI workflow must validate PR events on exactly the Node 22 lane"
    )
  );
});

test("CI contract rejects direct PR body interpolation", async () => {
  const ci = await readRepositoryFile(".github/workflows/ci.yml");
  const unsafe = ci.replace(
    'npm run governance:check -- --github-event-file "$GITHUB_EVENT_PATH"',
    "echo '${{ github.event.pull_request.body }}'"
  );
  const errors = validateCiWorkflow(unsafe);
  assert.ok(
    errors.includes("CI workflow must read the PR body through quoted GITHUB_EVENT_PATH")
  );
  assert.ok(
    errors.includes("CI workflow must not interpolate the PR body into workflow shell source")
  );
});

test("default CLI validates the bounded repository contract", () => {
  const result = runCli([]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /requirement-governance-check passed \(7 allowlisted PR fixtures\)/
  );
});
