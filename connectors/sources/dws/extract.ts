import { createHash } from "node:crypto";
import type { ApprovedQuery } from "./policy.js";

type ObjectValue = Record<string, unknown>;
interface Provenance {
  title?: string
  objectId?: string
  uri?: string
  updatedAt?: string
}
export interface DwsDocument {
  id: string
  title: string
  text: string
  source: { type: "dws"; id: string; uri?: string; updatedAt?: string }
  metadata: { service: string; query: string; command: string; path: string }
}

const TITLE_KEYS = [
  "title",
  "name",
  "subject",
  "displayname",
  "filename",
  "topic"
];
const TEXT_KEYS = new Set([
  "abstract",
  "answer",
  "body",
  "caption",
  "content",
  "description",
  "detail",
  "details",
  "keyword",
  "keywords",
  "markdown",
  "message",
  "paragraph",
  "plaintext",
  "question",
  "sentence",
  "snippet",
  "summary",
  "text",
  "todo",
  "transcript",
  "transcription",
  "utterance",
  "words"
]);
const ID_KEYS = [
  "messageid",
  "msgid",
  "taskuuid",
  "minutesid",
  "nodeid",
  "dentryuuid",
  "dentryid",
  "documentid",
  "docid",
  "fileid",
  "recordid",
  "uuid",
  "id",
  "key",
  "openconversationid",
  "conversationid",
  "workspaceid",
  "spaceid"
];
const URI_KEYS = [
  "url",
  "uri",
  "weburl",
  "shareurl",
  "docurl",
  "minutesurl",
  "sourceurl",
  "link"
];
const TIME_KEYS = [
  "updatedat",
  "modifiedat",
  "modifytime",
  "modifiedtime",
  "updatetime",
  "sendtime",
  "timestamp",
  "time",
  "createdat",
  "createtime",
  "starttime",
  "endtime"
];
const SENSITIVE_KEY =
  /(?:authorization|clientsecret|cookie|credential|password|privatekey|refreshtoken|secret|sessionkey|token|webhook)/i;

function canonicalKey(value: unknown): string {
  return String(value).replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function stableId(...values: string[]): string {
  return createHash("sha256")
    .update(values.join("\0"))
    .digest("hex")
    .slice(0, 24);
}

function primitiveText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  return normalized || null;
}

function firstByKeys(object: ObjectValue, keys: string[]): unknown {
  const entries = new Map(
    Object.entries(object).map(([key, value]) => [canonicalKey(key), value])
  );
  for (const key of keys) {
    const value = entries.get(key);
    if (
      (typeof value === "string" && value.trim()) ||
      typeof value === "number"
    ) {
      return value;
    }
  }
  return undefined;
}

function normalizeUri(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (
      !["https:", "http:", "dingtalk:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function normalizeTime(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    typeof value === "number" ||
    (typeof value === "string" && /^\d{10,13}$/.test(value))
  ) {
    const numeric = Number(value);
    const milliseconds = numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
    const date = new Date(milliseconds);
    return Number.isNaN(date.valueOf()) ? String(value) : date.toISOString();
  }
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value.trim() || undefined : date.toISOString();
}

function directTextValues(object: ObjectValue): string[] {
  const values: string[] = [];
  for (const [key, value] of Object.entries(object)) {
    const canonical = canonicalKey(key);
    if (SENSITIVE_KEY.test(canonical) || !TEXT_KEYS.has(canonical)) continue;
    if (typeof value === "string") {
      const text = primitiveText(value);
      if (text) values.push(text);
      continue;
    }
    if (
      Array.isArray(value) &&
      value.every((entry) => typeof entry === "string")
    ) {
      const text = value
        .map(primitiveText)
        .filter((entry): entry is string => Boolean(entry))
        .join("\n");
      if (text) values.push(text);
    }
  }
  return [...new Set(values)];
}

function directTitle(object: ObjectValue): string | undefined {
  const value = firstByKeys(object, TITLE_KEYS);
  return typeof value === "string" ? primitiveText(value) ?? undefined : undefined;
}

function childEntries(object: ObjectValue): Array<[string, object]> {
  return Object.entries(object).filter(
    ([key, value]) =>
      !SENSITIVE_KEY.test(canonicalKey(key)) &&
      value !== null &&
      typeof value === "object"
  ) as Array<[string, object]>;
}

export function extractDwsDocuments(
  payload: unknown,
  { query, maxDocuments = 500 }: { query: ApprovedQuery; maxDocuments?: number }
): DwsDocument[] {
  const documents: DwsDocument[] = [];
  const dedupe = new Set<string>();
  const service = query.service;

  function addDocument(text: unknown, provenance: Provenance, path: string) {
    const normalized = primitiveText(text);
    if (!normalized) return;
    const sourceId =
      provenance.objectId ??
      `${service}:${query.name}:${stableId(query.commandPath, path, normalized)}`;
    const duplicateKey = `${sourceId}\0${normalized}`;
    if (dedupe.has(duplicateKey)) return;
    dedupe.add(duplicateKey);
    if (documents.length >= maxDocuments) {
      throw new RangeError("dws_extracted_document_limit_exceeded");
    }

    const id = stableId("dws", service, sourceId, path, normalized);
    const source: DwsDocument["source"] = {
      type: "dws",
      id: String(sourceId)
    };
    if (provenance.uri) source.uri = provenance.uri;
    if (provenance.updatedAt) source.updatedAt = provenance.updatedAt;

    documents.push({
      id,
      title: provenance.title || `${service} · ${query.name}`,
      text: normalized,
      source,
      metadata: {
        service,
        query: query.name,
        command: query.commandPath,
        path
      }
    });
  }

  function visit(value: unknown, inherited: Provenance, path: string, depth: number): void {
    if (depth > 32 || value === null || value === undefined) return;
    if (typeof value === "string") {
      addDocument(value, inherited, path);
      return;
    }
    if (typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) =>
        visit(entry, inherited, `${path}[${index}]`, depth + 1)
      );
      return;
    }

    const object = value as ObjectValue;
    const ownObjectId = firstByKeys(object, ID_KEYS);
    const ownUri = normalizeUri(firstByKeys(object, URI_KEYS));
    const ownUpdatedAt = normalizeTime(firstByKeys(object, TIME_KEYS));
    const ownTitle = directTitle(object);
    const provenance = {
      title: ownTitle ?? inherited.title,
      objectId:
        ownObjectId !== undefined ? String(ownObjectId) : inherited.objectId,
      uri: ownUri ?? inherited.uri,
      updatedAt: ownUpdatedAt ?? inherited.updatedAt
    };

    const textValues = directTextValues(object);
    if (textValues.length) {
      addDocument(textValues.join("\n\n"), provenance, path);
    }

    const children = childEntries(object);
    if (
      textValues.length === 0 &&
      ownTitle &&
      (children.length === 0 || ownObjectId !== undefined || ownUri)
    ) {
      addDocument(ownTitle, provenance, path);
    }
    for (const [key, child] of children) {
      visit(child, provenance, `${path}.${key}`, depth + 1);
    }
  }

  visit(
    payload,
    {
      title: undefined,
      objectId: undefined,
      uri: undefined,
      updatedAt: undefined
    },
    "$",
    0
  );
  return documents;
}
