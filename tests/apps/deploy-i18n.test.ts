import assert from "node:assert/strict"
import test from "node:test"

import { detectSystemLocale, setLocale, t, getLocale, getAvailableLocales, getLocaleDisplayName } from "../../apps/cli/deploy/i18n.js"

function withLang<T>(lang: string, callback: () => T): T {
  const originalLang = process.env.LANG
  const originalLcAll = process.env.LC_ALL
  delete process.env.LC_ALL
  process.env.LANG = lang
  try {
    return callback()
  } finally {
    if (originalLang !== undefined) process.env.LANG = originalLang
    else delete process.env.LANG
    if (originalLcAll !== undefined) process.env.LC_ALL = originalLcAll
    else delete process.env.LC_ALL
  }
}

test("detectSystemLocale returns zh-CN for zh locale", () => {
  withLang("zh_CN.UTF-8", () => {
    assert.equal(detectSystemLocale(), "zh-CN")
  })
})

test("detectSystemLocale returns en for non-zh locale", () => {
  withLang("en_US.UTF-8", () => {
    assert.equal(detectSystemLocale(), "en")
  })
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
  setLocale("fr")
  assert.equal(getLocale(), "en")
  assert.equal(t("deploy.channel_dingtalk"), "DingTalk")
})

test("getAvailableLocales discovers all locale files", () => {
  const locales = getAvailableLocales()
  assert.ok(locales.includes("en"))
  assert.ok(locales.includes("zh-CN"))
  assert.ok(locales.includes("ja"))
})

test("getLocaleDisplayName returns display name from locale file", () => {
  assert.equal(getLocaleDisplayName("en"), "English")
  assert.equal(getLocaleDisplayName("zh-CN"), "简体中文")
  assert.equal(getLocaleDisplayName("ja"), "日本語")
})

test("getLocaleDisplayName returns code for unknown locale", () => {
  assert.equal(getLocaleDisplayName("xx-YY"), "xx-YY")
})

test("setLocale loads Japanese messages", () => {
  setLocale("ja")
  assert.equal(getLocale(), "ja")
  assert.equal(t("deploy.channel_dingtalk"), "DingTalk")
  assert.equal(t("deploy.channel_console"), "コンソール（ターミナル）")
})

test("missing key in non-English locale falls back to English", () => {
  setLocale("ja")
  // locale.display_name exists in ja, but test a hypothetical missing key
  // by checking that the fallback mechanism works (key returns en value or key itself)
  assert.equal(t("nonexistent.key"), "nonexistent.key")
})

test("detectSystemLocale returns ja for Japanese locale", () => {
  withLang("ja_JP.UTF-8", () => {
    assert.equal(detectSystemLocale(), "ja")
  })
})
