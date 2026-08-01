import { dwsError } from "./errors.js";

const MAX_QUERY_COUNT = 50;
const MAX_ARGUMENT_COUNT = 64;
const MAX_ARGUMENT_LENGTH = 8_192;

const RESERVED_GLOBAL_FLAGS = new Set([
  "client-id",
  "client-secret",
  "debug",
  "dry-run",
  "fields",
  "format",
  "jq",
  "mock",
  "profile",
  "timeout",
  "verbose",
  "yes"
]);

interface FlagSpecification {
  type: "string" | "integer"
  values?: string[]
  min?: number
  max?: number
  csvMax?: number
  csvValues?: string[]
}
interface PolicyDefinition {
  path: string
  service: string
  required?: string[]
  requireOneOf?: string[]
  flags: Record<string, Readonly<FlagSpecification>>
  validate?: (values: Map<string, string>, queryName: string) => void
}
interface CompiledPolicy extends PolicyDefinition { tokens: readonly string[] }
export interface ApprovedQuery {
  name: string
  service: string
  commandPath: string
  command: readonly string[]
  args: readonly string[]
}

function stringFlag(options: Omit<FlagSpecification, "type"> = {}) {
  return Object.freeze({ type: "string", ...options });
}

function integerFlag(options: Omit<FlagSpecification, "type"> = {}) {
  return Object.freeze({ type: "integer", ...options });
}

const POLICY_DEFINITIONS: PolicyDefinition[] =
  [
    {
      path: "doc read",
      service: "doc",
      required: ["node"],
      flags: {
        node: stringFlag(),
        "content-format": stringFlag({ values: ["markdown", "jsonml"] }),
        scope: stringFlag({ values: ["outline", "range", "section", "tags"] }),
        "max-depth": integerFlag({ min: 0, max: 100 }),
        "start-block-id": stringFlag(),
        "end-block-id": stringFlag(),
        tags: stringFlag({ csvMax: 50 })
      },
      validate(values: Map<string, string>, queryName: string) {
        const scope = values.get("scope");
        if (scope && values.get("content-format") !== "jsonml") {
          invalidQuery(queryName, "dws_query_scope_requires_jsonml", "scope");
        }
        if ((scope === "range" || scope === "section") && !values.has("start-block-id")) {
          invalidQuery(queryName, "dws_query_missing_required_flag", "start-block-id");
        }
        if (scope === "tags" && !values.has("tags")) {
          invalidQuery(queryName, "dws_query_missing_required_flag", "tags");
        }
        if (values.has("end-block-id") && scope !== "range") {
          invalidQuery(queryName, "dws_query_flag_requires_scope_range", "end-block-id");
        }
        if (values.has("tags") && scope !== "tags") {
          invalidQuery(queryName, "dws_query_flag_requires_scope_tags", "tags");
        }
      }
    },
    {
      path: "doc info",
      service: "doc",
      required: ["node"],
      flags: { node: stringFlag() }
    },
    {
      path: "doc search",
      service: "doc",
      required: ["query"],
      flags: {
        query: stringFlag(),
        "created-from": integerFlag({ min: 0 }),
        "created-to": integerFlag({ min: 0 }),
        "creator-uids": stringFlag({ csvMax: 30 }),
        cursor: stringFlag(),
        "editor-uids": stringFlag({ csvMax: 30 }),
        extensions: stringFlag({ csvMax: 30 }),
        limit: integerFlag({ min: 1, max: 30 }),
        "mentioned-uids": stringFlag({ csvMax: 30 }),
        "visited-from": integerFlag({ min: 0 }),
        "visited-to": integerFlag({ min: 0 }),
        "workspace-ids": stringFlag({ csvMax: 30 })
      }
    },
    {
      path: "minutes get info",
      service: "minutes",
      required: ["id"],
      flags: { id: stringFlag() }
    },
    {
      path: "minutes get summary",
      service: "minutes",
      required: ["id"],
      flags: { id: stringFlag() }
    },
    {
      path: "minutes get transcription",
      service: "minutes",
      required: ["id"],
      flags: {
        id: stringFlag(),
        cursor: stringFlag(),
        direction: stringFlag({ values: ["0", "1"] })
      }
    },
    {
      path: "minutes get keywords",
      service: "minutes",
      required: ["id"],
      flags: { id: stringFlag() }
    },
    {
      path: "minutes get todos",
      service: "minutes",
      required: ["id"],
      flags: { id: stringFlag() }
    },
    {
      path: "chat message list",
      service: "chat",
      required: ["group", "time", "direction"],
      flags: {
        group: stringFlag(),
        time: stringFlag(),
        direction: stringFlag({ values: ["newer", "older"] }),
        limit: integerFlag({ min: 1, max: 100 })
      }
    },
    {
      path: "chat message list-by-ids",
      service: "chat",
      required: ["msg-ids"],
      flags: {
        "msg-ids": stringFlag({ csvMax: 50 })
      }
    },
    {
      path: "chat message search",
      service: "chat",
      required: ["query", "group", "start", "end"],
      flags: {
        query: stringFlag(),
        group: stringFlag(),
        start: stringFlag(),
        end: stringFlag(),
        limit: integerFlag({ min: 1, max: 100 }),
        cursor: stringFlag()
      }
    },
    {
      path: "wiki space get",
      service: "wiki",
      required: ["workspace"],
      flags: { workspace: stringFlag() }
    },
    {
      path: "wiki node list",
      service: "wiki",
      required: ["workspace"],
      flags: {
        workspace: stringFlag(),
        folder: stringFlag(),
        limit: integerFlag({ min: 1, max: 50 }),
        cursor: stringFlag()
      }
    },
    {
      path: "wiki node search",
      service: "wiki",
      required: ["workspace", "query"],
      flags: {
        workspace: stringFlag(),
        query: stringFlag(),
        extensions: stringFlag({ csvMax: 30 }),
        limit: integerFlag({ min: 1, max: 30 }),
        cursor: stringFlag()
      }
    },
    {
      path: "drive info",
      service: "drive",
      required: ["node"],
      flags: {
        node: stringFlag(),
        "space-id": stringFlag()
      }
    },
    {
      path: "drive list",
      service: "drive",
      requireOneOf: ["folder", "space-id", "workspace"],
      flags: {
        folder: stringFlag(),
        "space-id": stringFlag(),
        workspace: stringFlag(),
        limit: integerFlag({ min: 1, max: 50 }),
        cursor: stringFlag(),
        "order-by": stringFlag({ values: ["createTime", "modifyTime", "name"] }),
        order: stringFlag({ values: ["asc", "desc"] })
      }
    },
    {
      path: "drive search",
      service: "drive",
      required: ["query"],
      flags: {
        query: stringFlag(),
        target: stringFlag({ values: ["all", "file", "space"] }),
        extensions: stringFlag({ csvMax: 30 }),
        "file-types": stringFlag({
          csvMax: 6,
          csvValues: ["alidoc", "document", "image", "video", "audio", "archive"]
        }),
        "creator-uids": stringFlag({ csvMax: 30 }),
        "created-from": integerFlag({ min: 0 }),
        "created-to": integerFlag({ min: 0 }),
        "modified-from": integerFlag({ min: 0 }),
        "modified-to": integerFlag({ min: 0 }),
        limit: integerFlag({ min: 1, max: 30 }),
        cursor: stringFlag()
      }
    }
  ];

const POLICIES = new Map<string, Readonly<CompiledPolicy>>(
  POLICY_DEFINITIONS.map((policy) => [
    policy.path,
    Object.freeze({
      ...policy,
      tokens: Object.freeze(policy.path.split(" ")),
      flags: Object.freeze(policy.flags)
    })
  ])
);

export const DWS_READ_COMMANDS = Object.freeze([...POLICIES.keys()]);

function invalidQuery(queryName: string, code: string, flag?: string): never {
  throw dwsError(code, {
    query: queryName,
    ...(flag ? { flag: `--${flag}` } : {})
  });
}

function normalizeCommand(command: unknown, queryName: string): string[] {
  let tokens: unknown[];
  if (Array.isArray(command)) {
    tokens = command;
  } else if (typeof command === "string") {
    tokens = command.trim().split(/\s+/);
  } else {
    invalidQuery(queryName, "dws_query_command_must_be_string_or_array");
  }

  if (
    tokens.length < 2 ||
    tokens.length > 3 ||
    tokens.some(
      (token) =>
        typeof token !== "string" ||
        !/^[a-z][a-z0-9-]*$/.test(token)
    )
  ) {
    invalidQuery(queryName, "dws_query_invalid_command_path");
  }
  return tokens as string[];
}

function validateFlagValue(
  value: unknown,
  specification: Readonly<FlagSpecification>,
  queryName: string,
  flag: string,
): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ARGUMENT_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    invalidQuery(queryName, "dws_query_invalid_flag_value", flag);
  }

  if (specification.type === "integer") {
    if (!/^(?:0|[1-9]\d*)$/.test(value)) {
      invalidQuery(queryName, "dws_query_flag_requires_integer", flag);
    }
    const number = Number(value);
    if (
      !Number.isSafeInteger(number) ||
      (specification.min !== undefined && number < specification.min) ||
      (specification.max !== undefined && number > specification.max)
    ) {
      invalidQuery(queryName, "dws_query_flag_integer_out_of_range", flag);
    }
  }

  if (specification.values && !specification.values.includes(value)) {
    invalidQuery(queryName, "dws_query_flag_value_not_allowed", flag);
  }

  if (specification.csvMax) {
    const values = value.split(",").map((item) => item.trim());
    if (
      values.length === 0 ||
      values.length > specification.csvMax ||
      values.some((item) => !item)
    ) {
      invalidQuery(queryName, "dws_query_invalid_csv_value", flag);
    }
    if (
      specification.csvValues &&
      values.some((item) => !specification.csvValues?.includes(item))
    ) {
      invalidQuery(queryName, "dws_query_flag_value_not_allowed", flag);
    }
  }
}

function validateArguments(
  args: unknown,
  policy: Readonly<CompiledPolicy>,
  queryName: string,
): readonly string[] {
  if (!Array.isArray(args)) {
    invalidQuery(queryName, "dws_query_args_must_be_array");
  }
  if (args.length > MAX_ARGUMENT_COUNT || args.length % 2 !== 0) {
    invalidQuery(queryName, "dws_query_invalid_argument_count");
  }

  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const rawFlag = args[index];
    const value = args[index + 1];
    if (
      typeof rawFlag !== "string" ||
      !rawFlag.startsWith("--") ||
      rawFlag.includes("=") ||
      !/^--[a-z][a-z0-9-]*$/.test(rawFlag)
    ) {
      invalidQuery(queryName, "dws_query_requires_long_flags");
    }

    const flag = rawFlag.slice(2);
    if (RESERVED_GLOBAL_FLAGS.has(flag)) {
      invalidQuery(queryName, "dws_query_reserved_global_flag", flag);
    }
    const specification = policy.flags[flag];
    if (!specification) {
      invalidQuery(queryName, "dws_query_flag_not_allowed", flag);
    }
    if (values.has(flag)) {
      invalidQuery(queryName, "dws_query_duplicate_flag", flag);
    }
    validateFlagValue(value, specification, queryName, flag);
    values.set(flag, value as string);
  }

  for (const flag of policy.required ?? []) {
    if (!values.has(flag)) {
      invalidQuery(queryName, "dws_query_missing_required_flag", flag);
    }
  }
  if (
    policy.requireOneOf &&
    !policy.requireOneOf.some((flag) => values.has(flag))
  ) {
    invalidQuery(queryName, "dws_query_missing_required_scope");
  }
  policy.validate?.(values, queryName);
  return Object.freeze([...(args as string[])]);
}

export function compileApprovedQueries(approvedQueries: unknown): readonly ApprovedQuery[] {
  if (
    !Array.isArray(approvedQueries) ||
    approvedQueries.length === 0 ||
    approvedQueries.length > MAX_QUERY_COUNT
  ) {
    throw dwsError("dws_requires_approved_queries", {
      maxQueries: MAX_QUERY_COUNT
    });
  }

  const names = new Set<string>();
  return Object.freeze(
    approvedQueries.map((rawQuery, index) => {
      const fallbackName = `query-${index + 1}`;
      if (
        !rawQuery ||
        typeof rawQuery !== "object" ||
        Array.isArray(rawQuery)
      ) {
        invalidQuery(fallbackName, "dws_query_must_be_object");
      }
      const query = rawQuery as Record<string, unknown>;
      const unknownKeys = Object.keys(query).filter(
        (key) => !["name", "command", "args"].includes(key)
      );
      if (unknownKeys.length) {
        invalidQuery(fallbackName, "dws_query_unknown_property");
      }

      const name = query.name ?? fallbackName;
      if (
        typeof name !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) ||
        names.has(name)
      ) {
        invalidQuery(fallbackName, "dws_query_invalid_or_duplicate_name");
      }
      names.add(name);

      const tokens = normalizeCommand(query.command, name);
      const commandPath = tokens.join(" ");
      const policy = POLICIES.get(commandPath);
      if (!policy) {
        invalidQuery(name, "dws_query_command_not_allowlisted");
      }
      const args = validateArguments(query.args ?? [], policy, name);

      return Object.freeze({
        name,
        service: policy.service,
        commandPath,
        command: policy.tokens,
        args
      });
    })
  );
}
