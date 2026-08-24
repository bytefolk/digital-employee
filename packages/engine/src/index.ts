export {
  ENGINE_ERROR_CODE_PATTERN,
  ENGINE_ID,
  ENGINE_PROTOCOL_VERSION,
  ENGINE_VERSION,
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
  TurnApprovalActionInput,
  TurnApprovalActionKind,
  TurnApprovalPreviewRef,
  TurnBudget,
  TurnPendingApprovalInput,
} from "./contracts.js"

export {
  APPROVAL_DENIED_CODE,
  APPROVAL_EXPIRED_CODE,
  APPROVAL_PREVIEW_INVALID_CODE,
  APPROVAL_REQUIRED_CODE,
  pendingApprovalExpired,
  previewGateAllows,
} from "./approval.js"
export type { ApprovalPreviewGateResult } from "./approval.js"

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

export {
  MAX_BUDGET_CAP,
  checkPositionBudget,
  createInMemoryBudgetLedger,
  emptyBudgetUsage,
  validatePositionBudgetDeclaration,
} from "./budget.js"
export type {
  BudgetDimension,
  BudgetExceeded,
  BudgetLedgerPort,
  BudgetScope,
  BudgetUsage,
  PositionBudgetDeclaration,
} from "./budget.js"

export {
  DEFAULT_DOOM_LOOP_CONFIG,
  DoomLoopDetector,
  digestOutput,
} from "./doom-loop.js"
export type { DoomLoopConfig, DoomLoopSignal } from "./doom-loop.js"

export {
  ESCALATION_RECORD_VERSION,
  WORKSPACE_OPERATOR_ENTRY,
  createInMemoryEscalationSink,
  resolveEscalationRouting,
} from "./escalation.js"
export type {
  EscalationBudgetSnapshot,
  EscalationCause,
  EscalationRecord,
  EscalationRouting,
  EscalationSinkPort,
  InMemoryEscalationSink,
  OrgReportingLookup,
} from "./escalation.js"

export {
  TURN_EVIDENCE_VERSION,
  createInMemoryEvidenceSink,
  digestOutputValue,
  evidenceRecordContainsForbiddenMaterial,
} from "./turn-evidence.js"
export type {
  EvidenceSinkPort,
  InMemoryEvidenceSink,
  TurnEvidenceApprovalRef,
  TurnEvidenceBudget,
  TurnEvidenceRecord,
  TurnEvidenceTerminal,
} from "./turn-evidence.js"

export {
  DELEGATION_ENVELOPE_VERSION,
  DELEGATION_EVENT_VERSION,
  TASK_RECORD_VERSION,
  DelegationContractError,
  computeCanonicalDigest,
  computeDelegationEnvelopeDigest,
  createRequestedTaskRecord,
  deriveEffectiveDelegationScope,
  executeDelegation,
  parseExistingDelegationHistory,
  parseDelegationEnvelope,
  validateDelegationAdmission,
} from "./delegation.js"
export type {
  DelegationChildExecutorPort,
  DelegationChildRunRequest,
  DelegationChildRunResult,
  DelegationEngine,
  DelegationEnvelope,
  DelegationEvent,
  DelegationOrganization,
  DelegationPermissions,
  DelegationPositionPermissions,
  DelegationTerminalError,
  EffectiveDelegationScope,
  ExecuteDelegationOptions,
  ExistingDelegationRef,
  RequestedTaskRecord,
} from "./delegation.js"
