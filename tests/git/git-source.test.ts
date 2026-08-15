import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  GitSource,
  LKG_MAX_STALE_MS_BOUNDS,
  ageWithinBound,
  isRemoteAcquisitionFailure
} from "../../connectors/sources/git/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fakeGitFixture = path.join(root, "tests", "git", "fixtures", "fake-git.mjs");
const FIXED_COMMIT = "c0ffee0000000000000000000000000000000000";

interface GitFixtureContext {
  root: string
  cacheDir: string
  recordPath: string
}

const gitEnvNames = [
  "PATH",
  "GIT_TEST_RECORD",
  "GIT_TEST_FAIL_EXIT",
  "GIT_TEST_COMMIT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "GIT_ASKPASS",
  "SSH_ASKPASS"
] as const;

async function withGitFixture(
  fn: (context: GitFixtureContext) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "digital-employee-git-"));
  const binDir = path.join(directory, "bin");
  const executable = path.join(binDir, process.platform === "win32" ? "git.cmd" : "git");
  await mkdir(binDir, { recursive: true });
  await writeFile(executable, await readFile(fakeGitFixture, "utf8"), { mode: 0o755 });
  await chmod(executable, 0o755);

  const original: Partial<Record<(typeof gitEnvNames)[number], string | undefined>> = {};
  for (const name of gitEnvNames) original[name] = process.env[name];
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.GIT_TEST_RECORD = path.join(directory, "git-record.jsonl");
  try {
    await fn({
      root: directory,
      cacheDir: path.join(directory, "cache"),
      recordPath: path.join(directory, "git-record.jsonl")
    });
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

function failRemote(exitCode = 73): void {
  process.env.GIT_TEST_FAIL_EXIT = String(exitCode);
}

function healRemote(): void {
  delete process.env.GIT_TEST_FAIL_EXIT;
}

function options(
  context: GitFixtureContext,
  overrides: Partial<ConstructorParameters<typeof GitSource>[0]> = {}
): ConstructorParameters<typeof GitSource>[0] {
  return {
    id: "git-docs",
    remote: "https://example.test/public-docs.git",
    ref: "main",
    cacheDir: context.cacheDir,
    policy: "prefer_last_known_good",
    maxStaleMs: 600_000,
    ...overrides
  };
}

async function activeGeneration(cacheDir: string): Promise<{ id: string; dir: string }> {
  const active = JSON.parse(await readFile(path.join(cacheDir, "active.json"), "utf8")) as {
    generation: string
  };
  return { id: active.generation, dir: path.join(cacheDir, "generations", active.generation) };
}

async function activeManifest(cacheDir: string): Promise<Record<string, unknown>> {
  const generation = await activeGeneration(cacheDir);
  return JSON.parse(
    await readFile(path.join(generation.dir, "manifest.json"), "utf8")
  ) as Record<string, unknown>;
}

async function rewriteActiveManifest(
  cacheDir: string,
  mutate: (manifest: Record<string, unknown>) => void
): Promise<void> {
  const generation = await activeGeneration(cacheDir);
  const manifestPath = path.join(generation.dir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  mutate(manifest);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function cloneTargets(recordPath: string): Promise<string[]> {
  const lines = (await readFile(recordPath, "utf8")).trim().split("\n");
  const targets: string[] = [];
  for (const line of lines) {
    if (!line) continue;
    const record = JSON.parse(line) as { args: string[]; cwd: string };
    if (!record.args.includes("clone")) continue;
    const separator = record.args.lastIndexOf("--");
    const target = record.args[separator + 2];
    if (typeof target === "string") targets.push(target);
  }
  return targets;
}

test("Git source accepts a credential-free HTTPS repository", () => {
  const source = new GitSource({
    id: "public-docs",
    remote: "https://github.com/example/example.git",
    ref: "main"
  });
  assert.equal(source.remote, "https://github.com/example/example.git");
  assert.equal(source.policy, "require_fresh");
  assert.equal(source.status, "unavailable");
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
  await withGitFixture(async (context) => {
    const unsafe = path.join(context.root, "unsafe");
    const original = {
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
      GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
      GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
      GIT_ASKPASS: process.env.GIT_ASKPASS,
      SSH_ASKPASS: process.env.SSH_ASKPASS
    };
    try {
      process.env.GIT_CONFIG_GLOBAL = path.join(unsafe, "unsafe-global-config");
      process.env.GIT_CONFIG_COUNT = "1";
      process.env.GIT_CONFIG_KEY_0 = "credential.helper";
      process.env.GIT_CONFIG_VALUE_0 = "unsafe-helper";
      process.env.GIT_ASKPASS = path.join(unsafe, "unsafe-git-askpass");
      process.env.SSH_ASKPASS = path.join(unsafe, "unsafe-ssh-askpass");

      const source = new GitSource({
        id: "isolated",
        remote: "https://example.test/public.git",
        cacheDir: context.cacheDir
      });
      await source.sync();
      assert.equal(source.status, "fresh");

      const first = JSON.parse(
        (await readFile(context.recordPath, "utf8")).trim().split("\n")[0]
      ) as { args: string[]; env: Record<string, unknown> };
      assert.deepEqual(first.args.slice(0, 4), [
        "-c",
        "credential.helper=",
        "-c",
        "core.askPass="
      ]);
      assert.equal(
        first.env.gitConfigGlobal,
        process.platform === "win32" ? "NUL" : "/dev/null"
      );
      assert.equal(first.env.gitConfigNoSystem, "1");
      assert.equal(first.env.gitConfigCount, undefined);
      assert.equal(first.env.gitConfigKey, undefined);
      assert.equal(first.env.gitAskPass, undefined);
      assert.equal(first.env.sshAskPass, undefined);
    } finally {
      for (const [name, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

test("AC-001: default strict policy fails closed on refresh failure", async () => {
  await withGitFixture(async (context) => {
    const source = new GitSource({
      id: "git-docs",
      remote: "https://example.test/public-docs.git",
      ref: "main",
      cacheDir: context.cacheDir
    });
    const first = await source.load();
    assert.equal(source.status, "fresh");
    assert.equal(first.length, 3);

    failRemote();
    await assert.rejects(() => source.load(), /git_source_command_failed:73/);
    assert.equal(source.status, "unavailable");
    healRemote();
  });
});

test("AC-001: explicit require_fresh policy also fails closed", async () => {
  await withGitFixture(async (context) => {
    const source = new GitSource(
      options(context, { policy: "require_fresh", maxStaleMs: undefined })
    );
    await source.load();
    failRemote();
    await assert.rejects(() => source.load(), /git_source_command_failed:73/);
    healRemote();
  });
});

test("AC-001: LKG without a bound is rejected during configuration", () => {
  assert.throws(
    () =>
      new GitSource({
        id: "lkg",
        remote: "https://example.test/repo.git",
        policy: "prefer_last_known_good"
      }),
    /git_source_lkg_max_stale_ms_out_of_bounds:missing/
  );
});

test("AC-001: LKG rejects unsafe, non-integer, and non-numeric bounds", () => {
  const base = {
    id: "lkg",
    remote: "https://example.test/repo.git",
    policy: "prefer_last_known_good"
  } as const;
  for (const maxStaleMs of [999, 604_800_001, 1.5, NaN, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => new GitSource({ ...base, maxStaleMs }),
      /git_source_lkg_max_stale_ms_out_of_bounds/,
      `expected ${String(maxStaleMs)} to be rejected`
    );
  }
  assert.throws(
    () => new GitSource({ ...base, maxStaleMs: "1000" as unknown as number }),
    /git_source_lkg_max_stale_ms_out_of_bounds/
  );
});

test("AC-001: LKG accepts the inclusive bounds", () => {
  assert.equal(LKG_MAX_STALE_MS_BOUNDS[0], 1_000);
  assert.equal(LKG_MAX_STALE_MS_BOUNDS[1], 604_800_000);
  for (const maxStaleMs of [1_000, 604_800_000]) {
    const source = new GitSource({
      id: "lkg",
      remote: "https://example.test/repo.git",
      policy: "prefer_last_known_good",
      maxStaleMs
    });
    assert.equal(source.maxStaleMs, maxStaleMs);
  }
});

test("AC-001: a bound under require_fresh and unknown policies are rejected", () => {
  assert.throws(
    () =>
      new GitSource({
        id: "lkg",
        remote: "https://example.test/repo.git",
        policy: "require_fresh",
        maxStaleMs: 60_000
      }),
    /git_source_max_stale_ms_requires_lkg_policy/
  );
  assert.throws(
    () =>
      new GitSource({
        id: "lkg",
        remote: "https://example.test/repo.git",
        policy: "degrade-everything" as never
      }),
    /git_source_invalid_policy/
  );
});

test("AC-002: clone and refresh occur only in a staging directory", async () => {
  await withGitFixture(async (context) => {
    const source = new GitSource(options(context));
    await source.load();

    const generation = await activeGeneration(context.cacheDir);
    const content = path.join(generation.dir, "content");
    assert.equal(
      (await readFile(path.join(content, "README.md"), "utf8")).includes("fake repository"),
      true
    );
    assert.equal(
      (await readFile(path.join(content, "docs", "guide.md"), "utf8")).includes("Step one"),
      true
    );
    const manifest = await activeManifest(context.cacheDir);
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.commit, FIXED_COMMIT);
    assert.equal(manifest.remote, "https://example.test/public-docs.git");
    assert.match(String(manifest.contentSha256), /^[0-9a-f]{64}$/);

    for (const target of await cloneTargets(context.recordPath)) {
      assert.match(target, /\.staging-/);
    }
    assert.doesNotMatch(generation.dir, /\.staging-/);
    const cacheEntries = await readdir(context.cacheDir);
    assert.ok(cacheEntries.includes("active.json"));
    assert.ok(cacheEntries.includes("generations"));
    assert.equal(cacheEntries.some((entry) => entry.startsWith(".staging-")), false);
  });
});

test("AC-002: a failed candidate never changes the active state", async () => {
  await withGitFixture(async (context) => {
    const source = new GitSource(options(context));
    await source.load();
    const before = await activeGeneration(context.cacheDir);
    const manifestBefore = await activeManifest(context.cacheDir);
    const generationEntriesBefore = (await readdir(path.join(context.cacheDir, "generations")))
      .sort();

    failRemote();
    await assert.rejects(() => source.sync(), /git_source_command_failed:73/);
    await source.load(); // degraded serves the untouched active generation
    healRemote();

    const after = await activeGeneration(context.cacheDir);
    assert.equal(after.id, before.id);
    assert.deepEqual(await activeManifest(context.cacheDir), manifestBefore);
    assert.deepEqual(
      (await readdir(path.join(context.cacheDir, "generations"))).sort(),
      generationEntriesBefore
    );
  });
});

test("AC-003: E3 reproduction serves degraded under a typed acquisition failure", async () => {
  await withGitFixture(async (context) => {
    const source = new GitSource(options(context));
    const first = await source.load();
    assert.equal(source.status, "fresh");
    assert.equal(first.length, 3);

    failRemote(73);
    const second = await source.load();
    assert.equal(source.status, "degraded");
    assert.equal(second.length, 3);
    const document = second[0] as { source: Record<string, unknown> };
    assert.equal(document.source.type, "git");
    assert.equal(document.source.repository, "https://example.test/public-docs.git");
    assert.equal(document.source.ref, "main");
    assert.equal(document.source.commit, FIXED_COMMIT);
    healRemote();
  });
});

test("AC-003: age at the limit is served and age over the limit by 1 ms is rejected", () => {
  const now = 1_752_000_000_000;
  assert.equal(ageWithinBound(now - 1_000, now, 1_000), true);
  assert.equal(ageWithinBound(now - 1_001, now, 1_000), false);
  assert.equal(ageWithinBound(now + 1, now, 1_000), false);
});

test("AC-003: an over-age generation is rejected on degraded read", async () => {
  await withGitFixture(async (context) => {
    const source = new GitSource(options(context, { maxStaleMs: 5_000 }));
    await source.load();
    await rewriteActiveManifest(context.cacheDir, (manifest) => {
      manifest.refreshedAt = new Date(Date.now() - 60_000).toISOString();
    });
    failRemote();
    await assert.rejects(
      () => source.load(),
      /git_source_lkg_unavailable:git_source_generation_over_age/
    );
    healRemote();
  });
});

test("AC-003: an in-bound generation serves degraded after refresh-time rewrite", async () => {
  await withGitFixture(async (context) => {
    const source = new GitSource(options(context, { maxStaleMs: 600_000 }));
    await source.load();
    await rewriteActiveManifest(context.cacheDir, (manifest) => {
      manifest.refreshedAt = new Date(Date.now() - 10_000).toISOString();
    });
    failRemote();
    const documents = await source.load();
    assert.equal(source.status, "degraded");
    assert.equal(documents.length, 3);
    healRemote();
  });
});

test("AC-004/AC-008: every degraded read revalidates manifest evidence", async () => {
  const tamperCases: Array<[string, (manifest: Record<string, unknown>) => void]> = [
    ["remote", (manifest) => { manifest.remote = "https://evil.test/other.git"; }],
    ["ref", (manifest) => { manifest.ref = "develop"; }],
    ["subdirectory", (manifest) => { manifest.subdirectory = "docs"; }],
    ["include", (manifest) => { manifest.include = [".md"]; }],
    ["policy", (manifest) => { manifest.policy = "require_fresh"; }],
    ["commit", (manifest) => { manifest.commit = "not-a-commit"; }],
    ["schema", (manifest) => { manifest.schemaVersion = 2; }],
    ["digest", (manifest) => { manifest.contentSha256 = "deadbeef"; }],
    ["future", (manifest) => {
      manifest.refreshedAt = new Date(Date.now() + 3_600_000).toISOString();
    }]
  ];
  for (const [label, mutate] of tamperCases) {
    await withGitFixture(async (context) => {
      const source = new GitSource(options(context));
      await source.load();
      await rewriteActiveManifest(context.cacheDir, mutate);
      failRemote();
      await assert.rejects(
        () => source.load(),
        /git_source_lkg_unavailable:git_source_generation_/,
        `expected tampered ${label} to fail closed`
      );
      healRemote();
    });
  }
});

test("AC-004/AC-008: malformed, missing, or altered state fails closed", async () => {
  await withGitFixture(async (context) => {
    const source = new GitSource(options(context));
    await source.load();
    const generation = await activeGeneration(context.cacheDir);

    failRemote();
    const manifestBytes = await readFile(path.join(generation.dir, "manifest.json"), "utf8");
    await writeFile(path.join(generation.dir, "manifest.json"), "{oops");
    await assert.rejects(
      () => source.load(),
      /git_source_lkg_unavailable:git_source_generation_invalid_manifest/
    );
    await rm(path.join(generation.dir, "manifest.json"));
    await assert.rejects(
      () => source.load(),
      /git_source_lkg_unavailable:git_source_generation_missing_manifest/
    );
    await writeFile(path.join(generation.dir, "manifest.json"), manifestBytes);

    await writeFile(path.join(generation.dir, "content", "docs", "guide.md"), "# Tampered\n");
    await assert.rejects(
      () => source.load(),
      /git_source_lkg_unavailable:git_source_generation_digest_mismatch/
    );
    await rm(path.join(generation.dir, "content", "docs", "guide.md"));
    await assert.rejects(
      () => source.load(),
      /git_source_lkg_unavailable:git_source_generation_digest_mismatch/
    );
    healRemote();
  });
});

test("AC-008: pointer symlinks, traversing ids, and content symlinks are rejected", async () => {
  await withGitFixture(async (context) => {
    const source = new GitSource(options(context));
    await source.load();

    failRemote();

    // active.json replaced by a symlink.
    const activePath = path.join(context.cacheDir, "active.json");
    const activeBytes = await readFile(activePath);
    const decoy = path.join(context.root, "decoy-active.json");
    await writeFile(decoy, activeBytes);
    await rm(activePath);
    await symlink(decoy, activePath);
    await assert.rejects(
      () => source.load(),
      /git_source_lkg_unavailable:git_source_generation_pointer_symlink/
    );
    await rm(activePath);
    await writeFile(activePath, activeBytes);

    // Generation directory replaced by a symlink.
    const generation = await activeGeneration(context.cacheDir);
    await writeFile(
      path.join(context.cacheDir, "active.json"),
      JSON.stringify({ schemaVersion: 1, generation: "0123456789ab-0000000000000-deadbeef" })
    );
    const decoyDir = path.join(context.root, "decoy-generation");
    await mkdir(decoyDir, { recursive: true });
    await symlink(decoyDir, path.join(context.cacheDir, "generations", "0123456789ab-0000000000000-deadbeef"));
    await assert.rejects(
      () => source.load(),
      /git_source_lkg_unavailable:git_source_generation_pointer_symlink/
    );
    await rm(path.join(context.cacheDir, "generations", "0123456789ab-0000000000000-deadbeef"), {
      force: true
    });
    await writeFile(
      path.join(context.cacheDir, "active.json"),
      JSON.stringify({ schemaVersion: 1, generation: generation.id })
    );

    // Traversing or absolute generation ids are rejected before any path use.
    for (const badId of ["../escape", "generations/../escape", "/abs/path"]) {
      await writeFile(
        path.join(context.cacheDir, "active.json"),
        JSON.stringify({ schemaVersion: 1, generation: badId })
      );
      await assert.rejects(
        () => source.load(),
        /git_source_lkg_unavailable:git_source_generation_invalid_id/,
        `expected ${badId} to be rejected`
      );
    }
    await writeFile(
      path.join(context.cacheDir, "active.json"),
      JSON.stringify({ schemaVersion: 1, generation: generation.id })
    );

    // A symlink inside the selected content is rejected.
    const symlinkTarget = path.join(context.root, "outside.md");
    await writeFile(symlinkTarget, "outside\n");
    await symlink(symlinkTarget, path.join(generation.dir, "content", "linked.md"));
    await assert.rejects(
      () => source.load(),
      /git_source_lkg_unavailable:git_source_generation_symlink_rejected/
    );
    healRemote();
  });
});

test("AC-006: restart revalidates all evidence and serves degraded within the bound", async () => {
  await withGitFixture(async (context) => {
    const first = new GitSource(options(context));
    await first.load();
    assert.equal(first.status, "fresh");

    const restarted = new GitSource(options(context));
    assert.equal(restarted.status, "unavailable");
    failRemote();
    const documents = await restarted.load();
    assert.equal(restarted.status, "degraded");
    assert.equal(documents.length, 3);
    healRemote();
  });
});

test("AC-006: cache eviction removes fallback availability", async () => {
  await withGitFixture(async (context) => {
    const source = new GitSource(options(context));
    await source.load();
    await rm(path.join(context.cacheDir, "generations"), { recursive: true });
    await rm(path.join(context.cacheDir, "active.json"));
    failRemote();
    await assert.rejects(
      () => source.load(),
      /git_source_lkg_unavailable:git_source_generation_missing_active/
    );
    healRemote();
  });
});

test("AC-005: concurrent degraded readers observe one complete generation", async () => {
  await withGitFixture(async (context) => {
    const source = new GitSource(options(context));
    await source.load();
    failRemote();
    const results = await Promise.all([source.load(), source.load()]);
    assert.equal(results[0].length, 3);
    assert.equal(results[1].length, 3);
    assert.equal(source.status, "degraded");
    healRemote();
  });
});

test("Non-goal: there is no fallback to an older generation", async () => {
  await withGitFixture(async (context) => {
    const source = new GitSource(options(context));
    await source.load();
    const active = await activeGeneration(context.cacheDir);

    // Simulate an older orphan generation that is NOT referenced by active.json.
    const orphanId = "0123456789ab-1000000000000-deadbeef";
    await mkdir(path.join(context.cacheDir, "generations", orphanId), { recursive: true });
    await writeFile(
      path.join(context.cacheDir, "generations", orphanId, "manifest.json"),
      await readFile(path.join(active.dir, "manifest.json"))
    );

    failRemote();
    await source.load(); // active generation is valid; orphan is ignored
    assert.equal(source.status, "degraded");

    // Break the active generation: no older generation may take its place.
    await rm(path.join(active.dir, "manifest.json"));
    await assert.rejects(
      () => source.load(),
      /git_source_lkg_unavailable:git_source_generation_missing_manifest/
    );
    healRemote();
  });
});

test("REQ-006: a legacy in-place checkout is never auto-promoted", async () => {
  await withGitFixture(async (context) => {
    const legacy = path.join(context.cacheDir, "legacy-checkout");
    await mkdir(path.join(legacy, ".git"), { recursive: true });
    await writeFile(path.join(legacy, "README.md"), "# Legacy\n\nNever trusted.\n");

    const source = new GitSource(options(context));
    failRemote();
    await assert.rejects(
      () => source.load(),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /git_source_lkg_unavailable:git_source_generation_missing_active/
        );
        assert.ok(error.cause instanceof Error);
        assert.match(error.cause.message, /git_source_command_failed:73/);
        return true;
      }
    );
    assert.equal(source.status, "unavailable");
    const generationsDir = path.join(context.cacheDir, "generations");
    assert.equal(
      existsSync(generationsDir) ? (await readdir(generationsDir)).length : 0,
      0
    );
    healRemote();
  });
});

test("REQ-005/REQ-007: degraded is reported as degraded, never ready or fresh", async () => {
  await withGitFixture(async (context) => {
    const source = new GitSource(options(context));
    await source.load();
    failRemote();
    await source.load();
    assert.equal(source.status, "degraded");
    assert.notEqual(source.status, "fresh");
    assert.notEqual(source.status, "ready");
    healRemote();
  });
});

test("REQ-007: the cache remains disposable with no backup or audit artifacts", async () => {
  await withGitFixture(async (context) => {
    const source = new GitSource(options(context));
    await source.load();
    failRemote();
    await assert.rejects(() => source.sync(), /git_source_command_failed:73/);
    healRemote();

    const entries = (await readdir(context.cacheDir)).sort();
    assert.deepEqual(entries, ["active.json", "generations"]);
  });
});

test("REQ-008: constructor compatibility and document shape are preserved", async () => {
  await withGitFixture(async (context) => {
    const source = new GitSource({
      id: "compat",
      remote: "https://example.test/public-docs.git",
      ref: "main",
      cacheDir: context.cacheDir
    });
    const documents = await source.load();
    assert.equal(source.status, "fresh");
    assert.equal(documents.length, 3);
    const first = documents[0] as {
      id: string
      title: string
      text: string
      source: Record<string, unknown>
      metadata: Record<string, unknown>
    };
    assert.equal(typeof first.id, "string");
    assert.equal(typeof first.title, "string");
    assert.equal(typeof first.text, "string");
    assert.equal(first.source.type, "git");
    assert.equal(first.source.repository, "https://example.test/public-docs.git");
    assert.equal(first.source.ref, "main");
    assert.equal(typeof first.metadata.path, "string");
    assert.equal(first.text.includes("fake repository"), true);
  });
});

test("Typed failure classification only accepts git subprocess failures", () => {
  assert.equal(isRemoteAcquisitionFailure(new Error("git_source_command_failed:73:")), true);
  assert.equal(isRemoteAcquisitionFailure(new Error("git_source_process_failed")), true);
  assert.equal(isRemoteAcquisitionFailure(new Error("git_source_process_timed_out")), true);
  assert.equal(isRemoteAcquisitionFailure(new Error("git_source_generation_digest_mismatch")), false);
  assert.equal(isRemoteAcquisitionFailure(new TypeError("git_source_invalid_ref")), false);
  assert.equal(isRemoteAcquisitionFailure(new Error("unrelated")), false);
});
