import assert from "node:assert/strict"
import test from "node:test"

import {
  assembleContext,
  composePositionSkills,
  registerWorkspaceSkillUnit,
  resetSkillRegistries,
} from "../../packages/engine/src/index.js"

const unit = {
  name: "lookup",
  version: "1.0.0",
  digest: `sha256:${"ab".repeat(32)}`,
}

test("#307 AC-001: skills slot is last and appears in the assembly", () => {
  const composed = composePositionSkills({
    workspaceId: "ws-1",
    positionId: "repo-owner",
    declarations: [unit],
  })
  assert.ok(composed.text)
  const assembled = assembleContext({
    positionId: "repo-owner",
    turnId: "turn-1",
    instructions: "owner",
    spec: "spec",
    turnInput: "question",
    skills: composed.text,
  })
  assert.equal(assembled.blocks.at(-1)?.slot, "skills")
  assert.equal(assembled.blocks.at(-1)?.text, composed.text)
})

test("#307 AC-002: two positions sharing a unit get the same digest and distinct evidence", () => {
  resetSkillRegistries()
  registerWorkspaceSkillUnit("ws-1", unit)
  const owner = composePositionSkills({
    workspaceId: "ws-1",
    positionId: "repo-owner",
    declarations: [unit],
  })
  const worker = composePositionSkills({
    workspaceId: "ws-1",
    positionId: "issue-researcher",
    declarations: [unit],
  })
  assert.equal(owner.evidence.compositionDigest, worker.evidence.compositionDigest)
  assert.equal(owner.evidence.positionId, "repo-owner")
  assert.equal(worker.evidence.positionId, "issue-researcher")
})

test("#307 empty declarations omit the skills block", () => {
  const assembled = assembleContext({
    positionId: "repo-owner",
    turnId: "turn-1",
    instructions: "owner",
    spec: "spec",
    turnInput: "question",
  })
  assert.ok(!assembled.blocks.some((block) => block.slot === "skills"))
})
