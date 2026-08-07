import assert from "node:assert/strict"
import test from "node:test"

import { detectSystemLocale, setLocale, t, getLocale } from "../../apps/cli/deploy/i18n.js"

test("detectSystemLocale returns zh-CN for zh locale", () => {
  const original = process.env.LANG
  process.env.LANG = "zh_CN.UTF-8"
  try {
    assert.equal(detectSystemLocale(), "zh-CN")
  } finally {
    if (original !== undefined) process.env.LANG = original
    else delete process.env.LANG
  }
})

test("detectSystemLocale returns en for non-zh locale", () => {
  const original = process.env.LANG
  process.env.LANG = "en_US.UTF-8"
  try {
    assert.equal(detectSystemLocale(), "en")
  } finally {
    if (original !== undefined) process.env.LANG = original
    else delete process.env.LANG
  }
})

test("setLocale loads English messages", () => {
  setLocale("en")
  assert.equal(getLocale(), "en")
  assert.equal(t("deploy.channel_dingtalk"), "DingTalk")
})

test("setLocale loads Chinese messages", () => {
  setLocale("zh-CN")
  assert.equal(getLocale(), "zh-CN")
  assert.equal(t("deploy.channel_dingtalk"), "钉钉")
})

test("t interpolates variables", () => {
  setLocale("en")
  const result = t("deploy.done_dingtalk", { name: "TestBot" })
  assert.ok(result.includes("TestBot"))
})

test("t returns key when message not found", () => {
  setLocale("en")
  assert.equal(t("nonexistent.key"), "nonexistent.key")
})

test("setLocale falls back to English for unknown locale", () => {
  setLocale("fr" as any)
  assert.equal(getLocale(), "en")
  assert.equal(t("deploy.channel_dingtalk"), "DingTalk")
})
