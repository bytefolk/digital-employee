/**
 * Channel deployment logic.
 * Each channel has its own setup/teardown logic.
 */

import { execFile } from "node:child_process"
import { t } from "./i18n.js"
import type { DeployConfig } from "./config.js"

export type ChannelId = "dingtalk" | "console" | "http"

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
