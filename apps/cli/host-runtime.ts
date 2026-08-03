/**
 * Trusted embedder API for selecting Agent hosts programmatically.
 *
 * This module deliberately performs no module discovery. An application may
 * create a registry, explicitly register adapters that are part of its trusted
 * deployment, and pass that registry to the package runner. Employee packages
 * cannot install adapters or provide executable/module paths.
 */
export {
  EMPLOYEE_RUN_SCHEMA_VERSION,
  inspectEmployeeHostCompatibility,
  runEmployeePackage,
} from "./agent-run.js"
export type {
  EmployeeRunResult,
  InspectEmployeeHostCompatibilityOptions,
  RunEmployeePackageOptions,
} from "./agent-run.js"
export { createBuiltInAgentHostRegistry } from "./agent-host-registry.js"
