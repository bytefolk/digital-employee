import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitSource } from "../../connectors/sources/git/index.js";

test("Git source accepts a credential-free HTTPS repository", () => {
  const source = new GitSource({
    id: "public-docs",
    remote: "https://github.com/example/example.git",
    ref: "main"
  });
  assert.equal(source.remote, "https://github.com/example/example.git");
});

test("Git source rejects embedded credentials and unsafe schemes", () => {
  assert.throws(
    () =>
      new GitSource({
        id: "unsafe",
        remote: "https://token@example.test/repo.git"
      }),
    /without_credentials/
  );
  assert.throws(
    () =>
      new GitSource({
        id: "unsafe",
        remote: "ssh://git@example.test/repo.git"
      }),
    /public_https/
  );
});

test("Git source rejects command-like refs", () => {
  assert.throws(
    () =>
      new GitSource({
        id: "unsafe",
        remote: "https://example.test/repo.git",
        ref: "main; touch bad"
      }),
    /invalid_ref/
  );
});

test("Git source isolates global config and inherited credential helpers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "digital-employee-git-"));
  const binDir = path.join(root, "bin");
  const recordPath = path.join(root, "git-record.json");
  const fakeGit = path.join(binDir, process.platform === "win32" ? "git.cmd" : "git");
  await mkdir(binDir, { recursive: true });
  await writeFile(
    fakeGit,
    `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.GIT_TEST_RECORD, JSON.stringify({
  args: process.argv.slice(2),
  gitConfigGlobal: process.env.GIT_CONFIG_GLOBAL,
  gitConfigNoSystem: process.env.GIT_CONFIG_NOSYSTEM,
  gitConfigCount: process.env.GIT_CONFIG_COUNT,
  gitConfigKey: process.env.GIT_CONFIG_KEY_0,
  gitAskPass: process.env.GIT_ASKPASS,
  sshAskPass: process.env.SSH_ASKPASS
}));
`,
    { mode: 0o700 }
  );
  if (process.platform !== "win32") await chmod(fakeGit, 0o700);

  const original = {
    PATH: process.env.PATH,
    GIT_TEST_RECORD: process.env.GIT_TEST_RECORD,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
    GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
    GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
    GIT_ASKPASS: process.env.GIT_ASKPASS,
    SSH_ASKPASS: process.env.SSH_ASKPASS
  };
  try {
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
    process.env.GIT_TEST_RECORD = recordPath;
    process.env.GIT_CONFIG_GLOBAL = path.join(root, "unsafe-global-config");
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "credential.helper";
    process.env.GIT_CONFIG_VALUE_0 = "unsafe-helper";
    process.env.GIT_ASKPASS = path.join(root, "unsafe-git-askpass");
    process.env.SSH_ASKPASS = path.join(root, "unsafe-ssh-askpass");

    const source = new GitSource({
      id: "isolated",
      remote: "https://example.test/public.git",
      cacheDir: path.join(root, "cache")
    });
    await source.sync();

    const record = JSON.parse(await readFile(recordPath, "utf8"));
    assert.deepEqual(record.args.slice(0, 4), [
      "-c",
      "credential.helper=",
      "-c",
      "core.askPass="
    ]);
    assert.equal(
      record.gitConfigGlobal,
      process.platform === "win32" ? "NUL" : "/dev/null"
    );
    assert.equal(record.gitConfigNoSystem, "1");
    assert.equal(record.gitConfigCount, undefined);
    assert.equal(record.gitConfigKey, undefined);
    assert.equal(record.gitAskPass, undefined);
    assert.equal(record.sshAskPass, undefined);
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
