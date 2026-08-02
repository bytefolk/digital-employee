import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createRuntime } from "../../apps/cli/runtime.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("demo runtime answers from approved files and cites the source", async () => {
  const runtime = await createRuntime(path.join(root, "configs", "demo.json"));
  assert.equal(runtime.profileReference.legacy, true);
  assert.equal(runtime.profileManifest.schemaVersion, "employee-profile.v1");
  const result = await runtime.employee.answer({
    requestId: "runtime-test-1",
    sessionId: "runtime-test",
    actorId: "tester",
    message: "What belongs in an incident report?"
  });

  assert.equal(result.status, "answered");
  assert.equal(typeof result.answer, "string");
  if (typeof result.answer !== "string") throw new Error("expected answer");
  assert.match(result.answer, /application version/i);
  assert.equal(result.citations.length, 1);
  const citation = result.citations[0];
  assert.ok(citation && typeof citation === "object" && !Array.isArray(citation));
  assert.equal(citation.uri, "source://demo-handbook/handbook.md");
});

test("a second profile runs through an allowlisted module without core assembly changes", async () => {
  const fixtureDirectory = path.join(root, "tests", "fixtures", "runtime");
  const runtime = await createRuntime(
    path.join(fixtureDirectory, "minimal-reader.json"),
    {
      moduleAllowlist: [path.join(fixtureDirectory, "minimal-reader.mjs")],
      environment: {}
    }
  );
  const result = await runtime.employee.answer({
    requestId: "runtime-fixture-1",
    sessionId: "runtime-fixture",
    actorId: "tester",
    message: "What belongs in an incident report?"
  });

  assert.equal(runtime.profileReference.legacy, false);
  assert.equal(runtime.profile.profile, "minimal-reader");
  assert.equal(result.status, "answered");
  assert.equal(result.citations.length, 1);
});

test("configured extension modules stay disabled without a caller allowlist", async () => {
  const fixtureDirectory = path.join(root, "tests", "fixtures", "runtime");
  await assert.rejects(
    () => createRuntime(path.join(fixtureDirectory, "minimal-reader.json")),
    /extension_module_not_allowlisted/
  );
});

test("a versioned profile reference must match the registered manifest", async () => {
  const fixtureDirectory = path.join(root, "tests", "fixtures", "runtime");
  const config = JSON.parse(
    await readFile(path.join(fixtureDirectory, "minimal-reader.json"), "utf8")
  );
  config.employee.profile.version = "2.0.0";
  config.extensions.modules = [path.join(fixtureDirectory, "minimal-reader.mjs")];
  config.sources[0].root = path.join(root, "examples", "knowledge");
  const directory = await mkdtemp(path.join(os.tmpdir(), "employee-version-"));
  const configPath = path.join(directory, "config.json");
  await writeFile(configPath, JSON.stringify(config));

  await assert.rejects(
    () =>
      createRuntime(configPath, {
        moduleAllowlist: [path.join(fixtureDirectory, "minimal-reader.mjs")]
      }),
    /profile_version_mismatch:2.0.0:1.0.0/
  );
});

test("runtime refuses deployment attempts to disable read-only policy", async () => {
  const config = JSON.parse(
    await readFile(path.join(root, "configs", "demo.json"), "utf8")
  );
  config.runtime.readOnly = false;
  const directory = await mkdtemp(path.join(os.tmpdir(), "employee-config-"));
  config.sources[0].root = path.join(root, "examples", "knowledge");
  const configPath = path.join(directory, "config.json");
  await writeFile(configPath, JSON.stringify(config));

  await assert.rejects(
    () => createRuntime(configPath),
    /write_capable_profiles_are_not_supported/
  );
});

test("demo runtime escalates a request outside approved knowledge", async () => {
  const runtime = await createRuntime(path.join(root, "configs", "demo.json"));
  const result = await runtime.employee.answer({
    requestId: "runtime-test-2",
    sessionId: "runtime-test",
    actorId: "tester",
    message: "Approve a production deployment now."
  });

  assert.equal(result.status, "escalated");
  assert.equal(typeof result.answer, "string");
  if (typeof result.answer !== "string") throw new Error("expected escalation answer");
  assert.match(result.answer, /maintainer/i);
  assert.deepEqual(result.citations, []);
});
