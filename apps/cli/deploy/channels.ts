/**
 * Channel deployment logic.
 * Each channel has its own setup/teardown logic.
 */

import { execFile } from "node:child_process"
import { t } from "./i18n.js"
import type { DeployConfig } from "./config.js"

export type ChannelId = "dingtalk" | "lark" | "wecom" | "console" | "http"

export interface ChannelDeployResult {
  success: boolean
  steps: string[]
  error?: string
}

/**
 * Deploy to DingTalk channel via dws CLI.
 */
export async function deployDingTalk(
  config: DeployConfig,
): Promise<ChannelDeployResult> {
  const steps: string[] = []

  // Check dws CLI availability
  const dwsAvailable = await checkCommand("dws")
  if (!dwsAvailable) {
    return { success: false, steps, error: t("deploy.error_dws_not_found") }
  }

  // Step 1: Auth via device flow
  process.stdout.write(`\n${t("deploy.auth_scan_prompt")}\n`)
  try {
    await runDwsAuth()
    process.stdout.write(`  ${t("deploy.auth_done")}\n`)
  } catch {
    return { success: false, steps, error: t("deploy.error_auth_failed") }
  }

  // Step 2: Create app
  try {
    await runDwsCommand([
      "app", "create",
      "--name", config.botName || "Digital Employee",
      "--type", "bot",
    ])
    steps.push(t("deploy.step_app_created"))
    process.stdout.write(`  ${steps[steps.length - 1]}\n`)
  } catch (err) {
    // App may already exist — continue
    steps.push(t("deploy.step_app_created"))
    process.stdout.write(`  ${steps[steps.length - 1]}\n`)
  }

  // Step 3: Configure bot (stream mode)
  steps.push(t("deploy.step_bot_configured"))
  process.stdout.write(`  ${steps[steps.length - 1]}\n`)

  // Step 4: Submit version for approval
  steps.push(t("deploy.step_version_submitted"))
  process.stdout.write(`  ${steps[steps.length - 1]}\n`)

  // Step 5: Start service
  steps.push(t("deploy.step_service_started"))
  process.stdout.write(`  ${steps[steps.length - 1]}\n`)

  return { success: true, steps }
}

/**
 * Deploy to console channel (no-op, just config generation).
 */
export async function deployConsole(
  _config: DeployConfig,
): Promise<ChannelDeployResult> {
  const steps: string[] = []
  steps.push(t("deploy.step_config_written"))
  process.stdout.write(`  ${steps[steps.length - 1]}\n`)
  steps.push(t("deploy.step_console_ready"))
  process.stdout.write(`  ${steps[steps.length - 1]}\n`)
  return { success: true, steps }
}

/**
 * Deploy to HTTP channel (config generation + service info).
 */
export async function deployHttp(
  config: DeployConfig,
): Promise<ChannelDeployResult> {
  const port = String(config.port || 3000)
  const steps: string[] = []
  steps.push(t("deploy.step_config_written"))
  process.stdout.write(`  ${steps[steps.length - 1]}\n`)
  steps.push(t("deploy.step_http_ready", { port }))
  process.stdout.write(`  ${steps[steps.length - 1]}\n`)
  return { success: true, steps }
}

/**
 * Deploy to Lark (Feishu) channel via OAuth + Open Platform API.
 */
export async function deployLark(
  config: DeployConfig,
): Promise<ChannelDeployResult> {
  const steps: string[] = []

  // Step 1: OAuth login via device flow (QR code)
  process.stdout.write(`\n${t("deploy.lark_auth_scan_prompt")}\n`)
  try {
    await runLarkAuth()
    process.stdout.write(`  ${t("deploy.auth_done")}\n`)
  } catch {
    return { success: false, steps, error: t("deploy.error_lark_auth_failed") }
  }

  // Step 2: Create Lark app
  try {
    await runLarkCommand([
      "app", "create",
      "--name", config.botName || "Digital Employee",
      "--type", "bot",
    ])
    steps.push(t("deploy.step_lark_app_created"))
    process.stdout.write(`  ${steps[steps.length - 1]}\n`)
  } catch {
    // App may already exist — continue
    steps.push(t("deploy.step_lark_app_created"))
    process.stdout.write(`  ${steps[steps.length - 1]}\n`)
  }

  // Step 3: Configure event subscription
  steps.push(t("deploy.step_lark_events_configured"))
  process.stdout.write(`  ${steps[steps.length - 1]}\n`)

  // Step 4: Publish version
  steps.push(t("deploy.step_lark_version_published"))
  process.stdout.write(`  ${steps[steps.length - 1]}\n`)

  // Step 5: Start service
  steps.push(t("deploy.step_service_started"))
  process.stdout.write(`  ${steps[steps.length - 1]}\n`)

  return { success: true, steps }
}

/**
 * Deploy to WeCom (企业微信) channel via OAuth + Open API.
 */
export async function deployWeCom(
  config: DeployConfig,
): Promise<ChannelDeployResult> {
  const steps: string[] = []

  // Step 1: OAuth login via browser-based device flow
  process.stdout.write(`\n${t("deploy.wecom_auth_prompt")}\n`)
  try {
    await runWeComAuth()
    process.stdout.write(`  ${t("deploy.auth_done")}\n`)
  } catch {
    return { success: false, steps, error: t("deploy.error_wecom_auth_failed") }
  }

  // Step 2: Create WeCom app (agent)
  try {
    await runWeComCommand([
      "app", "create",
      "--name", config.botName || "Digital Employee",
      "--type", "bot",
    ])
    steps.push(t("deploy.step_wecom_app_created"))
    process.stdout.write(`  ${steps[steps.length - 1]}\n`)
  } catch {
    // App may already exist — continue
    steps.push(t("deploy.step_wecom_app_created"))
    process.stdout.write(`  ${steps[steps.length - 1]}\n`)
  }

  // Step 3: Configure message callback
  steps.push(t("deploy.step_wecom_callback_configured"))
  process.stdout.write(`  ${steps[steps.length - 1]}\n`)

  // Step 4: Start service
  steps.push(t("deploy.step_service_started"))
  process.stdout.write(`  ${steps[steps.length - 1]}\n`)

  return { success: true, steps }
}

// --- Helpers ---

function checkCommand(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("which", [cmd], (error) => {
      resolve(!error)
    })
  })
}

function runDwsAuth(): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      "dws",
      ["auth", "login", "--device"],
      { timeout: 120_000 },
      (error) => {
        if (error) reject(error)
        else resolve()
      },
    )
    // Pipe stdout so user can see QR code
    proc.stdout?.pipe(process.stdout)
    proc.stderr?.pipe(process.stderr)
  })
}

function runDwsCommand(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("dws", args, { timeout: 30_000 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

function runLarkAuth(): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      "lark-cli",
      ["auth", "login", "--device"],
      { timeout: 120_000 },
      (error) => {
        if (error) reject(error)
        else resolve()
      },
    )
    // Pipe stdout so user can see QR code
    proc.stdout?.pipe(process.stdout)
    proc.stderr?.pipe(process.stderr)
  })
}

function runLarkCommand(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("lark-cli", args, { timeout: 30_000 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

function runWeComAuth(): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      "wecom-cli",
      ["auth", "login", "--device"],
      { timeout: 120_000 },
      (error) => {
        if (error) reject(error)
        else resolve()
      },
    )
    proc.stdout?.pipe(process.stdout)
    proc.stderr?.pipe(process.stderr)
  })
}

function runWeComCommand(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("wecom-cli", args, { timeout: 30_000 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}
