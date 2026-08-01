import assert from "node:assert/strict";
import test from "node:test";
import { createAnswerAgentProfile } from "../../profiles/answer-agent/index.js";

test("answer-agent is read-only and evidence constrained", () => {
  const profile = createAnswerAgentProfile({ domain: "example docs" });
  assert.equal(profile.readOnly, true);
  assert.match(profile.instructions, /approved evidence/i);
  assert.match(profile.instructions, /human review/i);
  assert.equal(profile.id, "answer-agent");
});
