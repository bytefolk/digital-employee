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
  port?: number
  deployedAt?: string
}

const CONFIG_DIR = path.join(homedir(), ".digital-employee")
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json")

export function getConfigDir(): string {
  return CONFIG_DIR
}

export function getConfigPath(): string {
  return CONFIG_FILE
}

export function loadConfig(): DeployConfig {
  if (!existsSync(CONFIG_FILE)) return {}
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as DeployConfig
  } catch {
    return {}
  }
}

export function saveConfig(config: DeployConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf8")
}

export function hasExistingDeployment(): boolean {
  const config = loadConfig()
  return Boolean(config.deployedAt)
}
