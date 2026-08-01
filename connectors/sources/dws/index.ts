import { extractDwsDocuments } from "./extract.js";
import { compileApprovedQueries, DWS_READ_COMMANDS } from "./policy.js";
import { runDwsJson } from "./runner.js";
import type { SpawnFunction } from "./runner.js";
import type { ApprovedQuery } from "./policy.js";
import type { DwsDocument } from "./extract.js";
import { DwsConnectorError, dwsError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_DOCUMENTS_PER_QUERY = 500;

function boundedInteger(
  value: unknown,
  fallback: number,
  { name, min, max }: { name: string; min: number; max: number }
): number {
  const resolved = value ?? fallback;
  if (
    typeof resolved !== "number" ||
    !Number.isInteger(resolved) ||
    resolved < min ||
    resolved > max
  ) {
    throw dwsError("dws_invalid_numeric_option", { option: name, min, max });
  }
  return resolved;
}

function validateProfile(profile: unknown): string {
  if (
    typeof profile !== "string" ||
    !profile.trim() ||
    profile.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(profile)
  ) {
    throw dwsError("dws_explicit_profile_required");
  }
  return profile;
}

function validateExecutable(executable: unknown): string {
  if (
    typeof executable !== "string" ||
    !executable.trim() ||
    executable.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(executable)
  ) {
    throw dwsError("dws_invalid_executable");
  }
  return executable;
}

type DwsLogger = (event: Readonly<Record<string, unknown>>) => void;
function validateLogger(logger: unknown): DwsLogger | undefined {
  if (logger === undefined) return undefined;
  if (typeof logger !== "function") {
    throw dwsError("dws_logger_must_be_function");
  }
  return logger as DwsLogger;
}

function defaultDwsEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowedNames = new Set([
    "APPDATA",
    "HOME",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "NO_PROXY",
    "PATH",
    "PATHEXT",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "SystemRoot",
    "TMPDIR",
    "USERPROFILE"
  ]);
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) =>
        allowedNames.has(name) ||
        name.startsWith("DWS_") ||
        name.startsWith("XDG_")
    )
  );
}

export { DWS_READ_COMMANDS, DwsConnectorError };

export interface DwsSourceOptions {
  id?: string
  profile?: unknown
  executable?: unknown
  approvedQueries?: unknown
  timeoutMs?: unknown
  maxOutputBytes?: unknown
  maxDocumentsPerQuery?: unknown
  env?: NodeJS.ProcessEnv
  logger?: unknown
}

export class DwsKnowledgeSource {
  id: string
  profile: string
  executable: string
  queries: readonly ApprovedQuery[]
  timeoutMs: number
  maxOutputBytes: number
  maxDocumentsPerQuery: number
  env: NodeJS.ProcessEnv
  logger?: DwsLogger
  spawnImpl?: SpawnFunction

  constructor(
    {
      id = "dws",
      profile,
      executable = "dws",
      approvedQueries,
      timeoutMs,
      maxOutputBytes,
      maxDocumentsPerQuery,
      env = defaultDwsEnvironment(process.env),
      logger
    }: DwsSourceOptions = {},
    dependencies: { spawn?: SpawnFunction } = {}
  ) {
    if (typeof id !== "string" || !id.trim() || id.length > 256) {
      throw dwsError("dws_source_requires_id");
    }
    if (!env || typeof env !== "object" || Array.isArray(env)) {
      throw dwsError("dws_env_must_be_object");
    }
    if (
      dependencies.spawn !== undefined &&
      typeof dependencies.spawn !== "function"
    ) {
      throw dwsError("dws_spawn_dependency_must_be_function");
    }

    this.id = id;
    this.profile = validateProfile(profile);
    this.executable = validateExecutable(executable);
    this.queries = compileApprovedQueries(approvedQueries);
    this.timeoutMs = boundedInteger(timeoutMs, DEFAULT_TIMEOUT_MS, {
      name: "timeoutMs",
      min: 10,
      max: 5 * 60_000
    });
    this.maxOutputBytes = boundedInteger(
      maxOutputBytes,
      DEFAULT_MAX_OUTPUT_BYTES,
      {
        name: "maxOutputBytes",
        min: 1_024,
        max: 20 * 1024 * 1024
      }
    );
    this.maxDocumentsPerQuery = boundedInteger(
      maxDocumentsPerQuery,
      DEFAULT_MAX_DOCUMENTS_PER_QUERY,
      {
        name: "maxDocumentsPerQuery",
        min: 1,
        max: 5_000
      }
    );
    this.env = env;
    this.logger = validateLogger(logger);
    this.spawnImpl = dependencies.spawn;
  }

  #emit(event: Record<string, unknown>): void {
    try {
      this.logger?.(Object.freeze({ ...event }));
    } catch {
      // Observability must never change connector behavior.
    }
  }

  async load(): Promise<DwsDocument[]> {
    const documents: DwsDocument[] = [];

    for (const query of this.queries) {
      const startedAt = Date.now();
      this.#emit({
        event: "dws.query.started",
        query: query.name,
        command: query.commandPath
      });

      let payload: unknown;
      try {
        payload = await runDwsJson({
          executable: this.executable,
          args: [
            ...query.command,
            ...query.args,
            "--profile",
            this.profile,
            "--format",
            "json"
          ],
          env: this.env,
          timeoutMs: this.timeoutMs,
          maxOutputBytes: this.maxOutputBytes,
          ...(this.spawnImpl ? { spawnImpl: this.spawnImpl } : {})
        });
      } catch (error) {
        const safeError =
          error instanceof DwsConnectorError
            ? error
            : dwsError("dws_query_failed");
        this.#emit({
          event: "dws.query.failed",
          query: query.name,
          command: query.commandPath,
          code: safeError.code,
          durationMs: Date.now() - startedAt
        });
        throw safeError;
      }

      const extracted = extractDwsDocuments(payload, {
        query,
        maxDocuments: this.maxDocumentsPerQuery
      });
      documents.push(...extracted);
      this.#emit({
        event: "dws.query.completed",
        query: query.name,
        command: query.commandPath,
        documentCount: extracted.length,
        durationMs: Date.now() - startedAt
      });
    }

    return documents;
  }
}
