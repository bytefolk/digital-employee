import assert from "node:assert/strict";
import { mkdtemp, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createBuiltInRegistry,
  loadAllowedComponentModules
} from "../../apps/cli/registry.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureDirectory = path.join(root, "tests", "fixtures", "runtime");
const fixtureModule = path.join(fixtureDirectory, "minimal-reader.mjs");

test("built-ins are registry data and Console creates without credentials", async () => {
  const registry = await createBuiltInRegistry();

  assert.ok(registry.list("profile").includes("answer-agent"));
  assert.deepEqual(registry.list("channel"), ["console", "dingtalk"]);
  const channel = await registry.create("channel", "console", {
    config: {},
    environment: {}
  });
  assert.equal(typeof channel.start, "function");
  assert.equal(typeof channel.stop, "function");
});

test("an explicitly allowlisted local module can add a profile", async () => {
  const registry = await createBuiltInRegistry();
  await loadAllowedComponentModules(registry, {
    configDirectory: fixtureDirectory,
    modules: ["./minimal-reader.mjs"],
    moduleAllowlist: [fixtureModule]
  });

  assert.ok(registry.list("profile").includes("minimal-reader"));
  const profile = await registry.create("profile", "minimal-reader", {
    config: { id: "fixture" }
  });
  assert.equal(profile.profile, "minimal-reader");
  assert.equal(profile.readOnly, true);
});

test("local module loading is disabled without an explicit caller allowlist", async () => {
  const registry = await createBuiltInRegistry();
  await assert.rejects(
    () =>
      loadAllowedComponentModules(registry, {
        configDirectory: fixtureDirectory,
        modules: ["./minimal-reader.mjs"]
      }),
    /extension_module_not_allowlisted/
  );
  await assert.rejects(
    () =>
      loadAllowedComponentModules(registry, {
        configDirectory: fixtureDirectory,
        modules: ["https://example.test/profile.mjs"],
        moduleAllowlist: [fixtureModule]
      }),
    /extension_remote_specifier_not_allowed/
  );
  await assert.rejects(
    () =>
      loadAllowedComponentModules(registry, {
        configDirectory: fixtureDirectory,
        modules: ["../runtime/minimal-reader.mjs"],
        moduleAllowlist: [fixtureModule]
      }),
    /extension_module_path_escape_not_allowed/
  );
});

test("local module loading rejects symlinked files", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "employee-registry-"));
  const link = path.join(directory, "profile.mjs");
  try {
    await symlink(fixtureModule, link);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      t.skip("symlink creation is unavailable");
      return;
    }
    throw error;
  }
  const registry = await createBuiltInRegistry();
  await assert.rejects(
    () =>
      loadAllowedComponentModules(registry, {
        configDirectory: directory,
        modules: ["./profile.mjs"],
        moduleAllowlist: [link]
      }),
    /extension_module_symlink_not_allowed/
  );
});
