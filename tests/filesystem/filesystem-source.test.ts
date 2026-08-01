import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileSystemSource, chunkText } from "../../connectors/sources/filesystem/index.js";

test("filesystem source loads approved text and skips secrets and hidden files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "digital-employee-files-"));
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "docs", "guide.md"), "# Guide\n\nUse the smallest permission.");
  await writeFile(path.join(root, ".env"), "TOKEN=should-not-load");
  await writeFile(path.join(root, "credentials.json"), "{\"token\":\"should-not-load\"}");
  await writeFile(path.join(root, "docs", "binary.png"), "not indexed");

  const source = new FileSystemSource({ id: "handbook", root });
  const documents = await source.load();

  assert.equal(documents.length, 1);
  const document = documents[0] as {
    title: string;
    text: string;
    source: { uri: string };
  };
  assert.equal(document.title, "Guide");
  assert.match(document.text, /smallest permission/);
  assert.equal(document.source.uri, "source://handbook/docs/guide.md");
  assert.doesNotMatch(JSON.stringify(documents), /should-not-load/);
  assert.doesNotMatch(JSON.stringify(documents), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("filesystem source ignores symlinks", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "digital-employee-symlink-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "digital-employee-outside-"));
  await writeFile(path.join(outside, "private.md"), "# Private\n\nDo not index.");
  try {
    await symlink(path.join(outside, "private.md"), path.join(root, "linked.md"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      t.skip("symlink creation is unavailable");
      return;
    }
    throw error;
  }

  const source = new FileSystemSource({ id: "safe", root });
  assert.deepEqual(await source.load(), []);
});

test("chunkText creates bounded overlapping chunks", () => {
  const text = Array.from({ length: 60 }, (_, index) => `paragraph ${index} content`).join("\n\n");
  const chunks = chunkText(text, { maxChars: 180, overlapChars: 20 });
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 180));
});
