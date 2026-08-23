export {
  ENGINE_ERROR_CODE_PATTERN,
  ENGINE_ID,
  ENGINE_PROTOCOL_VERSION,
  EngineRequestError,
  isTerminalEngineEvent,
  terminalError,
  validateTurnRequest,
} from "./contracts.js"
export type {
  EngineEvent,
  EngineTerminalError,
  EngineTurnRequest,
  PositionContextInput,
  TerminalReason,
  TurnBudget,
} from "./contracts.js"

export {
  CONTEXT_ASSEMBLY_VERSION,
  CONTEXT_SLOT_ORDER,
  assembleContext,
} from "./context-assembler.js"
export type {
  AssemblyManifest,
  AssemblyManifestEntry,
  AssembleContextInput,
  AssembledContext,
  ContextBlock,
  ContextSlot,
  ContextWindowLimits,
} from "./context-assembler.js"

export { createDeterministicModelPort } from "./model-port.js"
export type {
  ModelPort,
  ModelTurnInput,
  ModelTurnResult,
  OutputViolation,
} from "./model-port.js"

export {
  ENGINE_MAX_OUTPUT_SCHEMA_BYTES,
  OutputSchemaGuardError,
  prepareTerminalSchema,
} from "./output-schema-guard.js"
export type { PreparedTerminalSchema } from "./output-schema-guard.js"

export { executeTurn } from "./turn-executor.js"
export type { TurnExecutorOptions } from "./turn-executor.js"
