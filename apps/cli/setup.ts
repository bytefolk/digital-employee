/**
 * Agent-native setup command.
 *
 * This is the single entry point for the "one-link install" flow described
 * in issue #48. An Agent Host drops the link, runs `npx digital-employee setup`
 * (or `digital-employee setup` after install), and this command:
 *
 * 1. Verifies the local environment (Node version, package integrity).
 * 2. Probes for available Agent Hosts.
 * 3. Scaffolds an employee package if none exists in the working directory.
 * 4. Runs a doctor check to confirm readiness.
 * 5. Prints deterministic, actionable next steps (or structured JSON).
 *
 * The entire flow is credential-free. It fails closed with actionable errors.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILT_IN_AGENT_HOST_IDS,
} from "./agent-hosts.js";
import {
  probeBuiltInAgentHosts,
} from "./agent-host-registry.js";
import { createEmployeePackage } from "./employee-package.js";

interface SetupOptions {
  directory?: string;
  json?: boolean;
  name?: string;
  recipe?: string;
}

interface SetupResult {
  status: "ready" | "partial" | "failed";
  environment: EnvironmentCheck;
  hosts: HostCheck[];
  employee: EmployeeCheck;
  nextSteps: string[];
  errors: string[];
}

interface EnvironmentCheck {
  nodeVersion: string;
  nodeMajor: number;
  supported: boolean;
  packageVersion: string;
}

interface HostCheck {
  id: string;
  displayName: string;
  available: boolean;
  version?: string;
}

interface EmployeeCheck {
  found: boolean;
  scaffolded: boolean;
  directory: string;
  name?: string;
}

function getPackageVersion(): string {
  try {
    const packageRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../..",
    );
    const pkgPath = path.join(packageRoot, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      return pkg.version || "unknown";
    }
  } catch {
    // Ignore
  }
  return "unknown";
}

function checkEnvironment(): EnvironmentCheck {
  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1), 10);
  return {
    nodeVersion,
    nodeMajor,
    supported: nodeMajor >= 20,
    packageVersion: "pending",
  };
}

async function checkHosts(): Promise<HostCheck[]> {
  const probes = await probeBuiltInAgentHosts(BUILT_IN_AGENT_HOST_IDS);
  return probes.map((probe) => ({
    id: probe.hostId,
    displayName: probe.displayName,
    available: probe.available,
    version: probe.version ?? undefined,
  }));
}

async function checkOrScaffoldEmployee(
  directory: string,
  options: { name?: string; recipe?: string },
): Promise<EmployeeCheck> {
  const manifestPath = path.join(directory, "employee.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      return {
        found: true,
        scaffolded: false,
        directory,
        name: manifest.name,
      };
    } catch {
      return { found: true, scaffolded: false, directory };
    }
  }

  // Scaffold a new employee package in a subdirectory
  const employeeName = options.name || "my-employee";
  const targetDir = path.join(directory, employeeName);
  try {
    const created = await createEmployeePackage(targetDir, {
      name: employeeName,
      recipe: options.recipe || "minimal-answer.v1",
    });
    return {
      found: true,
      scaffolded: true,
      directory: created.directory,
      name: created.manifest.name,
    };
  } catch (error) {
    if (
      error instanceof TypeError &&
      error.message === "init_target_already_exists"
    ) {
      // The subdirectory already exists — check if it has a manifest
      const subManifest = path.join(targetDir, "employee.json");
      if (existsSync(subManifest)) {
        try {
          const manifest = JSON.parse(readFileSync(subManifest, "utf8"));
          return {
            found: true,
            scaffolded: false,
            directory: targetDir,
            name: manifest.name,
          };
        } catch {
          return { found: true, scaffolded: false, directory: targetDir };
        }
      }
      return { found: true, scaffolded: false, directory: targetDir };
    }
    return { found: false, scaffolded: false, directory };
  }
}

function computeNextSteps(result: SetupResult): string[] {
  const steps: string[] = [];
  if (!result.environment.supported) {
    steps.push(
      `Upgrade Node.js to v20 or later (current: ${result.environment.nodeVersion}).`,
    );
  }
  if (!result.hosts.some((h) => h.available)) {
    steps.push(
      "Install a supported Agent Host: Qoder CLI, Claude Code, Qwen Code, or CodeBuddy.",
    );
  }
  if (!result.employee.found) {
    steps.push(
      `Create an employee package: digital-employee init <directory>`,
    );
  }
  if (result.employee.scaffolded) {
    steps.push(
      `Edit ${path.join(result.employee.directory, "SKILL.md")} to define the employee's role.`,
    );
  }
  if (
    result.environment.supported &&
    result.hosts.some((h) => h.available) &&
    result.employee.found
  ) {
    steps.push(
      "Run `digital-employee doctor` to verify end-to-end readiness.",
    );
    steps.push(
      "Run `digital-employee validate` to check the employee package.",
    );
  }
  return steps;
}

export async function setup(options: SetupOptions = {}): Promise<void> {
  const directory = options.directory || process.cwd();
  const json = options.json ?? false;

  // Step 1: Environment check
  const environment = checkEnvironment();

  // Resolve package version (async due to fs read)
  environment.packageVersion = await getPackageVersion();

  const errors: string[] = [];
  if (!environment.supported) {
    errors.push(`node_version_unsupported:${environment.nodeVersion}`);
  }

  // Step 2: Probe Agent Hosts
  const hosts = await checkHosts();
  const anyHostAvailable = hosts.some((h) => h.available);
  if (!anyHostAvailable) {
    errors.push("no_agent_host_available");
  }

  // Step 3: Check or scaffold employee
  const employee = await checkOrScaffoldEmployee(directory, {
    name: options.name,
    recipe: options.recipe,
  });
  if (!employee.found) {
    errors.push("employee_scaffold_failed");
  }

  // Determine overall status
  let status: SetupResult["status"];
  if (environment.supported && anyHostAvailable && employee.found) {
    status = "ready";
  } else if (environment.supported && employee.found) {
    status = "partial";
  } else {
    status = "failed";
  }

  const result: SetupResult = {
    status,
    environment,
    hosts,
    employee,
    nextSteps: [],
    errors,
  };
  result.nextSteps = computeNextSteps(result);

  // Output
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printHumanResult(result);
  }

  if (status === "failed") {
    process.exitCode = 1;
  }
}

function printHumanResult(result: SetupResult): void {
  process.stdout.write("Digital Employee setup\n");
  process.stdout.write("=====================\n\n");

  // Environment
  process.stdout.write(
    `Environment: Node ${result.environment.nodeVersion} ` +
      `${result.environment.supported ? "[supported]" : "[UNSUPPORTED]"}\n`,
  );
  process.stdout.write(
    `Package: @fullstack-ai-infra/digital-employee@${result.environment.packageVersion}\n\n`,
  );

  // Agent Hosts
  process.stdout.write("Agent Hosts:\n");
  for (const host of result.hosts) {
    const mark = host.available ? "+" : "-";
    const ver = host.version ? ` (${host.version})` : "";
    process.stdout.write(`  [${mark}] ${host.displayName}${ver}\n`);
  }
  process.stdout.write("\n");

  // Employee
  if (result.employee.found) {
    if (result.employee.scaffolded) {
      process.stdout.write(
        `Employee: scaffolded "${result.employee.name || "employee"}" in ${result.employee.directory}\n`,
      );
    } else {
      process.stdout.write(
        `Employee: found "${result.employee.name || "employee"}" in ${result.employee.directory}\n`,
      );
    }
  } else {
    process.stdout.write("Employee: not found (scaffold failed)\n");
  }
  process.stdout.write("\n");

  // Status
  const statusLabel =
    result.status === "ready"
      ? "READY"
      : result.status === "partial"
        ? "PARTIAL (no Agent Host detected)"
        : "FAILED";
  process.stdout.write(`Status: ${statusLabel}\n`);

  // Errors
  if (result.errors.length > 0) {
    process.stdout.write("\nErrors:\n");
    for (const err of result.errors) {
      process.stdout.write(`  - ${err}\n`);
    }
  }

  // Next steps
  if (result.nextSteps.length > 0) {
    process.stdout.write("\nNext steps:\n");
    for (const step of result.nextSteps) {
      process.stdout.write(`  1. ${step}\n`);
    }
  }
}
