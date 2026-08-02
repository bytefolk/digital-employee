import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  RuntimeComponentRegistry,
  validateProfileManifest
} from "../../packages/core/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function fixtureManifest() {
  const file = path.join(
    root,
    "tests",
    "fixtures",
    "runtime",
    "minimal-reader.profile.json"
  );
  return validateProfileManifest(JSON.parse(await readFile(file, "utf8")));
}

test("component registry validates interfaces and creates registered components", async () => {
  const registry = new RuntimeComponentRegistry();
  registry.register("model", "fixture-model", () => ({
    async generate() {
      return { answer: "fixture" };
    }
  }));

  const model = await registry.create("model", "fixture-model");
  const generated = await model.generate();
  assert.ok(generated && typeof generated === "object" && !Array.isArray(generated));
  assert.equal((generated as { answer?: string }).answer, "fixture");
  assert.deepEqual(registry.list("model"), ["fixture-model"]);

  registry.register("source", "invalid-source", () => ({}));
  await assert.rejects(
    () => registry.create("source", "invalid-source"),
    /invalid_source_component:invalid-source/
  );
});

test("component registry rejects duplicate and undeclared identifiers", async () => {
  const registry = new RuntimeComponentRegistry();
  registry.register("tool", "reader", () => ({
    mode: "read",
    async execute() {}
  }));
  assert.throws(
    () => registry.register("tool", "reader", () => ({})),
    /duplicate_component:tool:reader/
  );
  await assert.rejects(
    () => registry.create("channel", "missing"),
    /unsupported_component:channel:missing/
  );
});

test("profile registrations require a matching, compatible manifest", async () => {
  const registry = new RuntimeComponentRegistry();
  const manifest = await fixtureManifest();
  assert.throws(
    () =>
      registry.register(
        "profile",
        "different-name",
        () => ({ id: "test", instructions: "test", readOnly: true }),
        { manifest }
      ),
    /profile_manifest_name_mismatch:different-name:minimal-reader/
  );
});

test("profile metadata stays deeply immutable for callers and factories", async () => {
  const registry = new RuntimeComponentRegistry();
  const manifest = await fixtureManifest();

  registry.register(
    "profile",
    manifest.name,
    (_context, metadata) => {
      assert.ok(metadata.manifest);
      assert.throws(
        () => metadata.manifest?.capabilities.sources.push("dws"),
        TypeError
      );
      assert.deepEqual(metadata.manifest.capabilities.sources, ["filesystem"]);
      return { id: "test", instructions: "test", readOnly: true };
    },
    { manifest }
  );

  const metadata = registry.metadata("profile", manifest.name);
  assert.ok(metadata.manifest);
  assert.equal(Object.isFrozen(metadata), true);
  assert.equal(Object.isFrozen(metadata.manifest), true);
  assert.equal(Object.isFrozen(metadata.manifest.capabilities), true);
  assert.equal(Object.isFrozen(metadata.manifest.capabilities.sources), true);
  assert.throws(
    () => metadata.manifest?.capabilities.sources.push("dws"),
    TypeError
  );
  assert.deepEqual(metadata.manifest.capabilities.sources, ["filesystem"]);

  await registry.create("profile", manifest.name);
  assert.deepEqual(metadata.manifest.capabilities.sources, ["filesystem"]);
});
