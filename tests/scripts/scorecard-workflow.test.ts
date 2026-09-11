import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import YAML from "yaml";

const readWorkflow = (name: string) =>
  readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8");

// Exact allowlist: a new job, step, input, env, condition or permission needs
// explicit security review. Parse YAML rather than matching comments as policy.
const expected = {
  name: "Scorecard PR",
  on: { pull_request: { branches: ["main"] } },
  permissions: { contents: "read" },
  jobs: {
    scorecard: {
      name: "OpenSSF Scorecard",
      "runs-on": "ubuntu-24.04",
      "timeout-minutes": 15,
      steps: [
        {
          name: "Check out PR merge commit",
          uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
          with: { "persist-credentials": false }
        },
        {
          name: "Analyze PR checkout",
          uses: "ossf/scorecard-action@2d1146689b8cda280b9bc96326124645441f03bc",
          with: {
            results_file: "results.sarif",
            results_format: "sarif",
            publish_results: false
          }
        },
        {
          name: "Upload PR Scorecard report",
          uses: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
          with: {
            name: "scorecard-pr-results",
            path: "results.sarif",
            "if-no-files-found": "error",
            "retention-days": 14
          }
        }
      ]
    }
  }
};

function validatePrWorkflow(source: string) {
  const doc = YAML.parseDocument(source, { uniqueKeys: true });
  assert.deepEqual(doc.errors, [], "workflow must be unambiguous YAML");
  assert.deepEqual(doc.toJS({ maxAliasCount: 0 }), expected,
    "PR workflow must match the reviewed least-privilege analysis contract");
}

test("PR workflow emits the required real analysis and artifact with read-only authority", () => {
  validatePrWorkflow(readWorkflow("scorecard-pr.yml"));
});

test("security contract accepts YAML formatting and comments, not textual lookalikes", () => {
  validatePrWorkflow(`# publication stays disabled\n${YAML.stringify(expected)}`);
  assert.throws(() => validatePrWorkflow(`# ${YAML.stringify(expected).replaceAll("\n", "\n# ")}`));
});

type Mutation = { name: string; path: (string | number)[]; value?: unknown; remove?: boolean };
const mutations: Mutation[] = [
  { name: "missing PR trigger", path: ["on", "pull_request"], remove: true },
  { name: "unsafe privileged trigger", path: ["on", "pull_request_target"], value: {} },
  { name: "non-main target", path: ["on", "pull_request", "branches"], value: ["release"] },
  { name: "path-filtered required check", path: ["on", "pull_request", "paths"], value: ["src/**"] },
  { name: "missing synchronize events", path: ["on", "pull_request", "types"], value: ["opened"] },
  { name: "missing required name", path: ["jobs", "scorecard", "name"], remove: true },
  { name: "wrong required name", path: ["jobs", "scorecard", "name"], value: "Scorecard" },
  { name: "write-all shorthand", path: ["permissions"], value: "write-all" },
  { name: "contents write", path: ["permissions", "contents"], value: "write" },
  { name: "OIDC write", path: ["permissions", "id-token"], value: "write" },
  { name: "SARIF write", path: ["permissions", "security-events"], value: "write" },
  { name: "extra token read scope", path: ["permissions", "actions"], value: "read" },
  { name: "job permission override", path: ["jobs", "scorecard", "permissions"], value: { contents: "write" } },
  { name: "job skip", path: ["jobs", "scorecard", "if"], value: false },
  { name: "job failure waiver", path: ["jobs", "scorecard", "continue-on-error"], value: true },
  { name: "persisted checkout credentials", path: ["jobs", "scorecard", "steps", 0, "with", "persist-credentials"], value: true },
  { name: "default persisted credentials", path: ["jobs", "scorecard", "steps", 0, "with", "persist-credentials"], remove: true },
  { name: "base instead of candidate checkout", path: ["jobs", "scorecard", "steps", 0, "with", "ref"], value: "main" },
  { name: "other checkout repository", path: ["jobs", "scorecard", "steps", 0, "with", "repository"], value: "example/other" },
  { name: "missing analysis", path: ["jobs", "scorecard", "steps", 1], remove: true },
  { name: "skipped analysis", path: ["jobs", "scorecard", "steps", 1, "if"], value: false },
  { name: "analysis failure waiver", path: ["jobs", "scorecard", "steps", 1, "continue-on-error"], value: true },
  { name: "publication enabled", path: ["jobs", "scorecard", "steps", 1, "with", "publish_results"], value: true },
  { name: "implicit publication default", path: ["jobs", "scorecard", "steps", 1, "with", "publish_results"], remove: true },
  { name: "custom PAT", path: ["jobs", "scorecard", "steps", 1, "with", "repo_token"], value: "${{ secrets.SCORECARD_PAT }}" },
  { name: "event spoofing", path: ["jobs", "scorecard", "steps", 1, "env"], value: { GITHUB_EVENT_NAME: "push" } },
  { name: "arbitrary PR command", path: ["jobs", "scorecard", "steps", 3], value: { run: "npm run untrusted" } },
  { name: "extra publication action", path: ["jobs", "scorecard", "steps", 3], value: { uses: "github/codeql-action/upload-sarif@cdf488f595d80d6e07e03d4674febd5ab45fa938" } },
  { name: "missing report allowed", path: ["jobs", "scorecard", "steps", 2, "with", "if-no-files-found"], value: "warn" },
  { name: "wrong report uploaded", path: ["jobs", "scorecard", "steps", 2, "with", "path"], value: "README.md" },
  { name: "workflow secret environment", path: ["env"], value: { CUSTOM_TOKEN: "${{ secrets.CUSTOM_TOKEN }}" } },
  ...[0, 1, 2].map((index) => ({
    name: `unpinned action ${index}`,
    path: ["jobs", "scorecard", "steps", index, "uses"],
    value: expected.jobs.scorecard.steps[index]!.uses.replace(/@[a-f0-9]{40}$/, "@main")
  }))
];

for (const mutation of mutations) {
  test(`PR security negative control rejects ${mutation.name}`, () => {
    const doc = new YAML.Document(structuredClone(expected));
    if (mutation.remove) doc.deleteIn(mutation.path);
    else doc.setIn(mutation.path, mutation.value);
    assert.throws(() => validatePrWorkflow(doc.toString()), /least-privilege analysis contract/);
  });
}

test("duplicate YAML policy keys fail closed", () => {
  assert.throws(() => validatePrWorkflow(`${YAML.stringify(expected)}permissions: write-all\n`),
    /unambiguous YAML/);
});

test("default-branch repository reporting remains separate from PR analysis", () => {
  const main = YAML.parse(readWorkflow("bytefolk-scorecard.yml"));
  assert.deepEqual(main.on, {
    push: { branches: ["main"] },
    schedule: [{ cron: "43 3 * * 1" }],
    workflow_dispatch: null
  });
  const steps = main.jobs.scorecard.steps;
  assert.equal(steps.find((step: { uses: string }) => step.uses.startsWith("ossf/scorecard-action@")).with.publish_results, true);
  assert.equal(main.jobs.scorecard.permissions["security-events"], "write");
  assert.equal(main.jobs.scorecard.permissions["id-token"], "write");
  assert.ok(steps.some((step: { uses: string }) => step.uses.startsWith("github/codeql-action/upload-sarif@")));
});
