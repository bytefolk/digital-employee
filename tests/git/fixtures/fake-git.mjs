#!/usr/bin/env node
// Fake git for GitSource tests: records every invocation, materializes a
// shallow clone checkout, resolves a fixed commit, and can simulate a typed
// remote acquisition failure (exit code) on any clone call.
//
// Environment contract:
//   GIT_TEST_RECORD          - JSONL path; each line records { args, cwd, env }
//   GIT_TEST_FAIL_EXIT       - when set, every clone exits with this code
//   GIT_TEST_COMMIT          - override the resolved HEAD commit (hex, 40)
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const recordPath = process.env.GIT_TEST_RECORD;
const record = {
  args: process.argv.slice(2),
  cwd: process.cwd(),
  env: {
    gitConfigGlobal: process.env.GIT_CONFIG_GLOBAL,
    gitConfigNoSystem: process.env.GIT_CONFIG_NOSYSTEM,
    gitConfigCount: process.env.GIT_CONFIG_COUNT,
    gitConfigKey: process.env.GIT_CONFIG_KEY_0,
    gitConfigValue: process.env.GIT_CONFIG_VALUE_0,
    gitAskPass: process.env.GIT_ASKPASS,
    sshAskPass: process.env.SSH_ASKPASS,
  },
};
if (recordPath) {
  appendFileSync(recordPath, `${JSON.stringify(record)}\n`);
}

const args = process.argv.slice(2);
const failExit = process.env.GIT_TEST_FAIL_EXIT
  ? Number(process.env.GIT_TEST_FAIL_EXIT)
  : 0;

if (args.includes("clone")) {
  if (failExit) {
    process.stderr.write(`fatal: fake remote acquisition failure (${failExit})\n`);
    process.exit(failExit);
  }
  const separator = args.lastIndexOf("--");
  const target =
    separator !== -1 && args[separator + 2]
      ? path.resolve(args[separator + 2])
      : path.join(process.cwd(), "checkout");
  mkdirSync(path.join(target, ".git"), { recursive: true });
  writeFileSync(path.join(target, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(path.join(target, "README.md"), "# Demo\n\nHello from the fake repository.\n");
  mkdirSync(path.join(target, "docs"), { recursive: true });
  writeFileSync(path.join(target, "docs", "guide.md"), "# Guide\n\nStep one.\n");
  writeFileSync(path.join(target, "notes.json"), '{"topic":"fixture"}\n');
  writeFileSync(path.join(target, ".env.example"), "EXAMPLE=hidden\n");
  writeFileSync(path.join(target, "secret.env"), "SECRET=must-not-load\n");
  process.exit(0);
}

if (args.includes("rev-parse")) {
  process.stdout.write(`${process.env.GIT_TEST_COMMIT || "c0ffee0000000000000000000000000000000000"}\n`);
  process.exit(0);
}

process.exit(0);
