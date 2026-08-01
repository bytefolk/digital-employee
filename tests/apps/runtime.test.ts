import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createRuntime } from "../../apps/cli/runtime.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("demo runtime answers from approved files and cites the source", async () => {
  const runtime = await createRuntime(path.join(root, "configs", "demo.json"));
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
