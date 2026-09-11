import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import YAML from "yaml";

const baseline = YAML.parse(await readFile(
  new URL("../../.github/workflows/bytefolk-security.yml", import.meta.url),
  "utf8"
));
const ci = YAML.parse(await readFile(
  new URL("../../.github/workflows/ci.yml", import.meta.url),
  "utf8"
));

test("fork and same-repository PRs each receive the required CodeQL analysis", () => {
  assert.equal(baseline.on.pull_request, null);
  assert.ok(ci.on.pull_request.types.includes("synchronize"));
  assert.equal(baseline.jobs.codeql.if,
    "${{ github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository }}");
  const fork = ci.jobs["codeql-fork"];
  assert.ok(fork, "fork PRs need actual CodeQL analysis, not a skipped check");
  assert.equal(fork.if,
    "${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository }}");
  assert.equal(fork.name, "CodeQL (${{ matrix.language }})");
  assert.equal(fork.name, baseline.jobs.codeql.name);
  assert.deepEqual(fork.strategy, baseline.jobs.codeql.strategy);
  assert.deepEqual(fork.strategy.matrix.language, ["javascript-typescript"]);
  assert.deepEqual(fork.steps, baseline.jobs.codeql.steps);
  for (const step of fork.steps) {
    assert.equal(step.if, undefined, "required analysis steps must not be skipped");
  }
});

test("fork CodeQL analysis retains the unprivileged PR execution boundary", () => {
  assert.deepEqual(Object.keys(ci.on).sort(), ["pull_request", "push"]);
  assert.deepEqual(ci.permissions, { contents: "read" });
  const fork = ci.jobs["codeql-fork"];
  assert.ok(fork);
  assert.deepEqual(fork.permissions, {
    contents: "read",
    actions: "read",
    packages: "read",
    "security-events": "write"
  });
  for (const step of fork.steps) {
    assert.match(step.uses, /@[0-9a-f]{40}$/);
    assert.equal(step.run, undefined);
    if (step.uses.startsWith("actions/checkout@")) {
      assert.equal(step.with["persist-credentials"], false);
      assert.equal(step.with.ref, undefined, "scan the default PR merge ref");
    }
  }
});
