import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const securityCheck = path.join(repositoryRoot, "scripts/security-check.js");

function runSecurityCheck(cwd: string) {
  return spawnSync(process.execPath, [securityCheck], {
    cwd,
    encoding: "utf8"
  });
}

test("security check detects common service key shapes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "digital-employee-security-"));
  try {
    const initialized = spawnSync("git", ["init", "--quiet"], {
      cwd: root,
      encoding: "utf8"
    });
    assert.equal(initialized.status, 0, initialized.stderr);

    const examples = [
      ["github", "pat", "A".repeat(28)].join("_"),
      `ASIA${"A1".repeat(8)}`,
      ["sk", "proj", "A".repeat(32)].join("-"),
      `xoxb-${"1".repeat(12)}-${"a".repeat(24)}`,
      `AIza${"B".repeat(35)}`,
      `client_secret = "${"c".repeat(32)}"`
    ];
    await writeFile(path.join(root, "unsafe.txt"), examples.join("\n"));
    await writeFile(
      path.join(root, "unsafe-json.txt"),
      `"apiKey": "${"j".repeat(32)}"\n`
    );
    await writeFile(
      path.join(root, "unsafe-aws.txt"),
      `aws_secret_access_key = "${"w".repeat(40)}"\n`
    );

    const result = runSecurityCheck(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /blocked GitHub token/);
    assert.match(result.stderr, /blocked AWS access key/);
    assert.match(result.stderr, /blocked OpenAI or Anthropic API key/);
    assert.match(result.stderr, /blocked Slack token/);
    assert.match(result.stderr, /blocked Google API key/);
    assert.match(result.stderr, /blocked assigned secret value/);
    assert.match(
      result.stderr,
      /unsafe-json\.txt: blocked assigned secret value/
    );
    assert.match(
      result.stderr,
      /unsafe-aws\.txt: blocked assigned secret value/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("security check permits environment-variable placeholders", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "digital-employee-security-"));
  try {
    const initialized = spawnSync("git", ["init", "--quiet"], {
      cwd: root,
      encoding: "utf8"
    });
    assert.equal(initialized.status, 0, initialized.stderr);

    await writeFile(
      path.join(root, "safe.txt"),
      'api_key = "${MODEL_API_KEY}"\nclient_secret = "replace-me"\n'
    );

    const result = runSecurityCheck(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /security-check passed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
