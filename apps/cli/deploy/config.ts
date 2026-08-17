/**
 * Deploy configuration persistence.
 * Reads/writes ~/.digital-employee/config.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { homedir } from "node:os"

import type { SupportedLocale } from "./i18n.js"

export interface DeployConfig {
  locale?: SupportedLocale
  channel?: string
  botName?: string
  engine?: string
  openaiKey?: string
  dingtalkAppId?: string
  larkAppId?: string
  port?: number
  deployedAt?: string
}

const CONFIG_FILE_NAME = "config.json"

export function getConfigDir(): string {
  const override = process.env.DIGITAL_EMPLOYEE_CONFIG_DIR?.trim()
  return override || path.join(homedir(), ".digital-employee")
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), CONFIG_FILE_NAME)
}

export function loadConfig(): DeployConfig {
  const configFile = getConfigPath()
  if (!existsSync(configFile)) return {}
  try {
    return JSON.parse(readFileSync(configFile, "utf8")) as DeployConfig
  } catch {
    return {}
  }
}

export function saveConfig(config: DeployConfig): void {
  const configDir = getConfigDir()
  mkdirSync(configDir, { recursive: true })
  writeFileSync(path.join(configDir, CONFIG_FILE_NAME), JSON.stringify(config, null, 2) + "\n", "utf8")
}

export function hasExistingDeployment(): boolean {
  const config = loadConfig()
  return Boolean(config.deployedAt)
}
