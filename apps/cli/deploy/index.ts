/**
 * Interactive deploy command orchestrator.
 *
 * Flow:
 * 1. Language selection (auto-detect + persist)
 * 2. Channel selection (DingTalk / Console / HTTP)
 * 3. Auth (channel-specific)
 * 4. Bot naming
 * 5. Engine selection (probe-based)
 * 6. Automated deployment
 * 7. Done message
 */

import { detectSystemLocale, setLocale, t, getLocale, getAvailableLocales, getLocaleDisplayName } from "./i18n.js"
import type { SupportedLocale } from "./i18n.js"
import { selectPrompt, textPrompt, confirmPrompt, secretPrompt } from "./prompts.js"
import { loadConfig, saveConfig, hasExistingDeployment } from "./config.js"
import type { DeployConfig } from "./config.js"
import { detectEngines } from "./engines.js"
import type { EngineStatus } from "./engines.js"
import { deployDingTalk, deployLark, deployWeCom, deployConsole, deployHttp } from "./channels.js"
import type { ChannelId } from "./channels.js"

export interface DeployOptions {
  channel?: string
  engine?: string
  name?: string
  locale?: string
  yes?: boolean
  help?: boolean
}

const VALID_CHANNELS = ["dingtalk", "lark", "wecom", "console", "http"]
const VALID_ENGINES = ["qoder", "claude-code", "qwen-code", "codebuddy", "openai-key"]

export async function deploy(options: DeployOptions = {}): Promise<void> {
  // Load persisted config
  const existing = loadConfig()

  // Resolve locale early for --help support
  const resolvedLocale = options.locale || existing.locale || detectSystemLocale()
  setLocale(resolvedLocale)

  // --help: print help and exit
  if (options.help) {
    process.stdout.write(`${t("deploy.help")}\n`)
    return
  }

  // Step 1: Language selection
  let locale: SupportedLocale
  if (options.locale) {
    locale = options.locale
  } else {
    // Dynamically build locale choices from available locale files
    const localeChoices = getAvailableLocales().map((code) => ({
      label: getLocaleDisplayName(code),
      value: code,
    }))
    locale = await selectPrompt(t("deploy.lang_prompt"), localeChoices) as SupportedLocale
    setLocale(locale)
  }

  // Check for existing deployment (idempotent re-run)
  if (hasExistingDeployment()) {
    if (options.yes) {
      // Auto-confirm overwrite
    } else {
      process.stdout.write(`\n${t("deploy.existing_detected")}\n`)
      const overwrite = await confirmPrompt(t("deploy.existing_overwrite"), {
        yes: t("deploy.existing_yes"),
        no: t("deploy.existing_no"),
      })
      if (!overwrite) {
        process.stdout.write(`${t("deploy.aborted")}\n`)
        return
      }
    }
  }

  // Step 2: Channel selection
  let channel: ChannelId
  if (options.channel && VALID_CHANNELS.includes(options.channel)) {
    channel = options.channel as ChannelId
  } else {
    channel = await selectPrompt(t("deploy.channel_prompt"), [
      { label: t("deploy.channel_dingtalk"), value: "dingtalk" },
      { label: t("deploy.channel_lark"), value: "lark" },
      { label: t("deploy.channel_wecom"), value: "wecom" },
      { label: t("deploy.channel_console"), value: "console" },
      { label: t("deploy.channel_http"), value: "http" },
    ]) as ChannelId
  }

  // Step 3: Bot name
  let botName: string
  if (options.name) {
    botName = options.name
  } else if (options.yes) {
    botName = t("deploy.name_default")
  } else {
    botName = await textPrompt(
      t("deploy.name_prompt"),
      t("deploy.name_default"),
    )
  }

  // Step 4: Engine selection
  let engineChoice: string
  if (options.engine && VALID_ENGINES.includes(options.engine)) {
    engineChoice = options.engine
  } else {
    process.stdout.write("\n")
    const engines = await detectEngines()
    const engineOptions: { label: string; value: string; hint?: string }[] = engines.map((e) => ({
      label: e.displayName,
      value: e.id as string,
      hint: e.available
        ? t("deploy.engine_logged_in")
        : t("deploy.engine_not_found"),
    }))
    engineOptions.push({
      label: t("deploy.engine_openai_key"),
      value: "openai-key",
    })

    if (options.yes) {
      // In auto mode, pick first available engine
      const firstAvailable = engines.find((e) => e.available)
      engineChoice = firstAvailable ? firstAvailable.id : "openai-key"
    } else {
      engineChoice = await selectPrompt(t("deploy.engine_prompt"), engineOptions)
    }
  }

  let openaiKey: string | undefined
  if (engineChoice === "openai-key") {
    if (options.yes) {
      // In non-interactive mode without a key, we cannot proceed
      process.stderr.write(`${t("deploy.error_no_engine")}\n`)
      process.exitCode = 1
      return
    }
    openaiKey = await secretPrompt(t("deploy.openai_key_prompt"))
    if (!openaiKey) {
      process.stderr.write(`${t("deploy.error_no_engine")}\n`)
      process.exitCode = 1
      return
    }
  } else if (!options.engine) {
    // Verify selected engine is actually available (only when user picked interactively)
    const engines = await detectEngines()
    const selected = engines.find((e) => e.id === engineChoice)
    if (selected && !selected.available) {
      process.stderr.write(`${t("deploy.error_no_engine")}\n`)
      process.exitCode = 1
      return
    }
  }

  // Step 5: Deploy
  process.stdout.write(`\n${t("deploy.deploying")}\n`)

  const config: DeployConfig = {
    locale,
    channel,
    botName,
    engine: engineChoice,
    openaiKey,
    port: 3000,
  }

  let result
  if (channel === "dingtalk") {
    result = await deployDingTalk(config)
  } else if (channel === "lark") {
    result = await deployLark(config)
  } else if (channel === "wecom") {
    result = await deployWeCom(config)
  } else if (channel === "console") {
    result = await deployConsole(config)
  } else {
    result = await deployHttp(config)
  }

  if (!result.success) {
    process.stderr.write(
      `\n${t("deploy.error_deploy_failed", { reason: result.error || "unknown" })}\n`,
    )
    process.exitCode = 1
    return
  }

  // Step 6: Persist config
  config.deployedAt = new Date().toISOString()
  saveConfig(config)

  // Step 7: Done message
  process.stdout.write("\n")
  if (channel === "dingtalk") {
    process.stdout.write(`${t("deploy.done_dingtalk", { name: botName })}\n`)
  } else if (channel === "lark") {
    process.stdout.write(`${t("deploy.done_lark", { name: botName })}\n`)
  } else if (channel === "wecom") {
    process.stdout.write(`${t("deploy.done_wecom", { name: botName })}\n`)
  } else if (channel === "console") {
    process.stdout.write(`${t("deploy.done_console")}\n`)
  } else {
    process.stdout.write(`${t("deploy.done_http", { port: String(config.port) })}\n`)
  }
}
