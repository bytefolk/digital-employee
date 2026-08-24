#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

export const MAX_FIXTURES = 8;
export const MAX_FIXTURE_BYTES = 65_536;
const MAX_MANIFEST_BYTES = 16_384;
const MAX_TEMPLATE_BYTES = 131_072;
const MAX_GUIDE_BYTES = 262_144;
const MAX_EVENT_BYTES = 1_048_576;
const MAX_COMMIT_COUNT = 256;
const MAX_COMMIT_MESSAGE_BYTES = 65_536;
const MAX_GIT_OUTPUT_BYTES = 1_048_576;

export const REQUIRED_PR_HEADINGS = Object.freeze([
  "Canonical requirement",
  "Requirement trace",
  "File domains",
  "Scope and non-goals",
  "Validation",
  "Security and compatibility",
  "Known limitations",
  "Risk and rollback",
  "Product review handoff"
]);

const ISSUE_FIELD_TYPES = Object.freeze({
  issue_type: "dropdown",
  current_record: "textarea",
  user_problem: "textarea",
  route_boundary: "textarea",
  delivery_owners: "textarea",
  requirements: "textarea",
  dependencies: "textarea",
  acceptance: "textarea",
  non_goals: "textarea",
  lifecycle: "dropdown",
  status_decisions: "textarea",
  evidence: "textarea",
  history: "textarea",
  readiness: "checkboxes"
});
const REQUIRED_ISSUE_IDS = Object.freeze(Object.keys(ISSUE_FIELD_TYPES));
const INITIAL_LIFECYCLE_VALUES = Object.freeze(["needs-design"]);
const DOCUMENTED_LIFECYCLE_VALUES = Object.freeze([
  "needs-design",
  "ready",
  "in-progress",
  "product-review",
  "accepted",
  "blocked",
  "HOLD"
]);
const REQUIRED_GUIDE_HEADINGS = Object.freeze([
  "Exact semantic decision examples",
  "Pull request implementation trace",
  "Lifecycle and authority",
  "Append-only merge verification ledger",
  "Product review",
  "Milestone artifact packet and owner decision"
]);
const DECISION_EXAMPLE_SPEC = Object.freeze([
  Object.freeze({
    heading: "Additive",
    decisionType: "additive",
    previousRevision: "R1",
    resultingRevision: "R2"
  }),
  Object.freeze({
    heading: "Narrowing",
    decisionType: "narrowing",
    previousRevision: "R2",
    resultingRevision: "R3"
  }),
  Object.freeze({
    heading: "Breaking or compatibility",
    decisionType: "breaking",
    previousRevision: "R3",
    resultingRevision: "R4"
  }),
  Object.freeze({
    heading: "Dependency",
    decisionType: "dependency",
    previousRevision: "R4",
    resultingRevision: "R5"
  }),
  Object.freeze({
    heading: "Priority",
    decisionType: "priority",
    previousRevision: "R5",
    resultingRevision: "R6"
  }),
  Object.freeze({
    heading: "HOLD",
    decisionType: "hold",
    previousRevision: "R6",
    resultingRevision: "R7"
  }),
  Object.freeze({
    heading: "Release from HOLD",
    decisionType: "release",
    previousRevision: "R7",
    resultingRevision: "R8"
  }),
  Object.freeze({
    heading: "Duplicate",
    decisionType: "duplicate",
    previousRevision: "R8",
    resultingRevision: "R9"
  })
]);
const REQUIRED_DECISION_EXAMPLES = Object.freeze(
  DECISION_EXAMPLE_SPEC.map((example) => example.heading)
);
const TRACE_TABLE_HEADER =
  "| REQ/AC IDs | Changed files / domain | Tests or review evidence |";
const VALIDATION_TABLE_HEADER =
  "| ID | REQ/AC | Observable acceptance criterion | Command or manual steps | Environment | Expected | Observed | Status |";
const EXACT_EVIDENCE_FIELDS = Object.freeze([
  "Exact commands",
  "Observed counts/results",
  "Check URLs"
]);
const ALLOWED_VALIDATION_STATUSES = new Set([
  "PASS",
  "FAIL",
  "NOT VERIFIED",
  "N/A"
]);
const ALLOWED_PULL_REQUEST_ACTIONS = Object.freeze([
  "opened",
  "synchronize",
  "reopened",
  "edited"
]);
const FULL_REPOSITORY_NAME =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;
const ISSUE_REFERENCE = String.raw`(?:#[1-9]\d*|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*|https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9]\d*)`;
const AUTOMATIC_CLOSE = new RegExp(
  String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*${ISSUE_REFERENCE}(?=$|[\s.,;!?)}\]])`,
  "gi"
);
const PLACEHOLDER = /\b(?:TODO|TBD|NNN|PLACEHOLDER)\b|\b(?:REQ|AC)-NNN\b|<[^>\n]+>/i;
const FULL_ISSUE_URL =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9]\d*$/;
const FULL_CHECK_URL =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:actions\/runs\/[1-9]\d*(?:\/job\/[1-9]\d*)?|pull\/[1-9]\d*\/checks)(?:\?\S+)?$/;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameKeys(value, expected) {
  if (!isObject(value)) return false;
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function headingPattern(level, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${"#".repeat(level)} ${escaped}\\s*$`, "gm");
}

function headingCount(markdown, level, heading) {
  return [...markdown.matchAll(headingPattern(level, heading))].length;
}

function requireSingleHeadings(markdown, headings, level = 2) {
  const errors = [];
  for (const heading of headings) {
    const count = headingCount(markdown, level, heading);
    if (count === 0) errors.push(`missing required heading: ${heading}`);
    if (count > 1) errors.push(`duplicate required heading: ${heading}`);
  }
  return errors;
}

function validateHeadingOrder(markdown, headings) {
  let previous = -1;
  for (const heading of headings) {
    const index = markdown.search(headingPattern(2, heading));
    if (index === -1) continue;
    if (index < previous) return ["required PR headings are out of order"];
    previous = index;
  }
  return [];
}

function normalizeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function validateFileSize(text, limit, label) {
  return Buffer.byteLength(text, "utf8") > limit
    ? [`${label} exceeds ${limit} bytes`]
    : [];
}

function sectionBodyAtLevel(markdown, level, heading) {
  const match = headingPattern(level, heading).exec(markdown);
  if (!match) return "";
  const start = match.index + match[0].length;
  const remainder = markdown.slice(start);
  const next = remainder.search(new RegExp(`^#{1,${level}}\\s+`, "m"));
  return (next === -1 ? remainder : remainder.slice(0, next)).trim();
}

function sectionBody(markdown, heading) {
  return sectionBodyAtLevel(markdown, 2, heading);
}

function stripComments(value) {
  return value.replace(/<!--[\s\S]*?-->/g, " ").trim();
}

function isSubstantive(value) {
  const clean = stripComments(String(value || ""))
    .replace(/^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/gm, " ")
    .replace(/[`*_#|>\-[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length < 3 || PLACEHOLDER.test(clean) || !/[\p{L}\p{N}]/u.test(clean)) return false;
  return !/^(?:none|n\/?a)$/i.test(clean);
}

function markdownRows(section, header) {
  const lines = section.split(/\r?\n/).map((line) => line.trim());
  const index = lines.indexOf(header);
  if (index === -1) return [];
  const rows = [];
  for (let cursor = index + 2; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    if (!line.startsWith("|") || !line.endsWith("|")) break;
    rows.push(line.slice(1, -1).split("|").map((cell) => cell.trim()));
  }
  return rows;
}

function fieldValue(section, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = section.match(new RegExp(`^- ${escaped}:\\s*(.*)$`, "m"));
  return match ? stripComments(match[1]) : "";
}

function isNotVerifiedWithReason(value) {
  const match = value.match(/^NOT VERIFIED:\s*(.+)$/);
  return Boolean(match && isSubstantive(match[1]));
}

function validateTraceRows(section) {
  if (!section.includes(TRACE_TABLE_HEADER)) {
    return ["requirement trace table header is missing"];
  }
  const rows = markdownRows(section, TRACE_TABLE_HEADER);
  if (rows.length === 0) {
    return ["requirement trace needs at least one REQ/AC, domain, and evidence row"];
  }
  const errors = [];
  for (const [index, cells] of rows.entries()) {
    if (!(cells.length === 3 &&
      /\bREQ-\d{3}\b/.test(cells[0]) &&
      /\bAC-\d{3}\b/.test(cells[0]) &&
      isSubstantive(cells[1]) &&
      isSubstantive(cells[2]))) {
      errors.push(
        `requirement trace row ${index + 1} needs REQ/AC IDs, a substantive domain, and substantive evidence`
      );
    }
  }
  return errors;
}

export function findAutomaticCloseKeywords(text) {
  return [...String(text || "").matchAll(AUTOMATIC_CLOSE)].map((match) =>
    match[0].trim()
  );
}

function validateEvidenceFields(section) {
  const errors = [];
  const commands = fieldValue(section, "Exact commands");
  const counts = fieldValue(section, "Observed counts/results");
  const checks = fieldValue(section, "Check URLs");
  if (!(isNotVerifiedWithReason(commands) || (isSubstantive(commands) && /`[^`]+`/.test(commands)))) {
    errors.push("exact commands need copyable inline code or NOT VERIFIED: <reason>");
  }
  if (!(isNotVerifiedWithReason(counts) || (isSubstantive(counts) && /\b(?:PASS|FAIL)\b/i.test(counts) && /\b\d+\/\d+\b/.test(counts)))) {
    errors.push("observed counts/results need PASS|FAIL plus N/N, or NOT VERIFIED: <reason>");
  }
  if (!(isNotVerifiedWithReason(checks) || FULL_CHECK_URL.test(checks))) {
    errors.push("check URLs need a full GitHub URL or NOT VERIFIED: <reason>");
  }
  return errors;
}

function validateValidationRows(section) {
  if (!section.includes(VALIDATION_TABLE_HEADER)) {
    return ["validation ledger table header is missing"];
  }
  const complete = markdownRows(section, VALIDATION_TABLE_HEADER).some((cells) =>
    cells.length === 8 &&
    /^V[1-9]\d*$/.test(cells[0]) &&
    /\b(?:REQ|AC)-\d{3}\b/.test(cells[1]) &&
    cells.slice(2, 7).every(isSubstantive) &&
    ALLOWED_VALIDATION_STATUSES.has(cells[7])
  );
  return complete
    ? []
    : ["validation ledger needs one complete 8-cell row with an allowed status"];
}

function validateProductHandoff(section) {
  const errors = [];
  const owner = fieldValue(section, "Merge ledger owner");
  const reviewer = fieldValue(section, "Product reviewer");
  const packet = fieldValue(section, "Milestone or release packet");
  const handle = /^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
  if (!handle.test(owner)) errors.push("product handoff needs an exact merge ledger owner handle");
  if (!handle.test(reviewer)) errors.push("product handoff needs an exact product reviewer handle");
  if (!(/^https:\/\/github\.com\/\S+$/.test(packet) || /^N\/A:\s*\S.+$/.test(packet))) {
    errors.push("product handoff needs a full packet URL or N/A: <reason>");
  }
  if (!section.includes("- Merge, CI, release, and model judgment do not accept or close the Issue: acknowledged")) {
    errors.push("product handoff acknowledgement is missing");
  }
  return errors;
}

export function validatePullRequestTrace(markdown) {
  const errors = [
    ...validateFileSize(markdown, MAX_FIXTURE_BYTES, "PR trace"),
    ...requireSingleHeadings(markdown, REQUIRED_PR_HEADINGS),
    ...validateHeadingOrder(markdown, REQUIRED_PR_HEADINGS)
  ];

  for (const heading of REQUIRED_PR_HEADINGS) {
    if (headingCount(markdown, 2, heading) === 1 && !isSubstantive(sectionBody(markdown, heading))) {
      errors.push(`section is hollow or placeholder-only: ${heading}`);
    }
  }

  const canonical = sectionBody(markdown, "Canonical requirement");
  const issueUrl = fieldValue(canonical, "Canonical Issue URL");
  if (!FULL_ISSUE_URL.test(issueUrl)) {
    errors.push("canonical Issue must be a full GitHub Issue URL");
  }
  if (!/^R[1-9]\d*$/.test(fieldValue(canonical, "Consumed revision"))) {
    errors.push("consumed revision must match R<positive integer>");
  }
  if (fieldValue(canonical, "No automatic close keywords") !== "acknowledged") {
    errors.push("no-auto-close acknowledgement is missing");
  }

  errors.push(...validateTraceRows(sectionBody(markdown, "Requirement trace")));
  const validation = sectionBody(markdown, "Validation");
  errors.push(...validateEvidenceFields(validation));
  errors.push(...validateValidationRows(validation));
  errors.push(...validateProductHandoff(sectionBody(markdown, "Product review handoff")));

  for (const keyword of findAutomaticCloseKeywords(markdown)) {
    errors.push(`automatic close keyword is forbidden: ${keyword}`);
  }
  return errors;
}

export function validatePullRequestTemplate(markdown) {
  const errors = [
    ...validateFileSize(markdown, MAX_TEMPLATE_BYTES, "PR template"),
    ...requireSingleHeadings(markdown, REQUIRED_PR_HEADINGS),
    ...validateHeadingOrder(markdown, REQUIRED_PR_HEADINGS)
  ];
  const requiredText = [
    "Canonical Issue URL:",
    "Consumed revision:",
    "No automatic close keywords:",
    "implementationOwner:",
    "automatedPreReviewOwner:",
    "humanReviewOwner:",
    "Separation of duties:",
    TRACE_TABLE_HEADER,
    VALIDATION_TABLE_HEADER,
    ...EXACT_EVIDENCE_FIELDS.map((field) => `${field}:`),
    "Compatibility, migration, and cross-repository effects",
    "Merge ledger owner:",
    "Product reviewer:",
    "Milestone or release packet:",
    "Automated pre-review result:",
    "Human final review:",
    "Merge, CI, release, and model judgment do not accept or close the Issue:"
  ];
  for (const text of requiredText) {
    if (!markdown.includes(text)) errors.push(`PR template is missing: ${text}`);
  }
  return errors;
}

function validateIssueElement(entry, index, seen, errors) {
  if (!isObject(entry)) {
    errors.push(`Issue template body[${index}] must be an object`);
    return;
  }
  if (entry.type === "markdown") {
    if (!sameKeys(entry, ["type", "attributes"])) {
      errors.push(`Issue template markdown body[${index}] has unexpected keys`);
    }
    if (!isObject(entry.attributes) || !sameKeys(entry.attributes, ["value"]) || typeof entry.attributes.value !== "string") {
      errors.push(`Issue template markdown body[${index}] has invalid attributes`);
    }
    return;
  }
  if (typeof entry.id !== "string") {
    errors.push(`Issue template body[${index}] needs an id`);
    return;
  }
  if (seen.has(entry.id)) errors.push(`Issue template has duplicate field id: ${entry.id}`);
  seen.add(entry.id);
  if (!(entry.id in ISSUE_FIELD_TYPES)) {
    errors.push(`Issue template has unexpected field id: ${entry.id}`);
    return;
  }
  const expectedType = ISSUE_FIELD_TYPES[entry.id];
  if (entry.type !== expectedType) {
    errors.push(`Issue template field ${entry.id} must have type ${expectedType}`);
  }
  const expectedKeys = expectedType === "checkboxes"
    ? ["type", "id", "attributes"]
    : ["type", "id", "attributes", "validations"];
  if (!sameKeys(entry, expectedKeys)) {
    errors.push(`Issue template field ${entry.id} has unexpected or missing keys`);
  }
  if (!isObject(entry.attributes) || typeof entry.attributes.label !== "string") {
    errors.push(`Issue template field ${entry.id} has invalid attributes`);
    return;
  }
  if (expectedType === "checkboxes") {
    if (!sameKeys(entry.attributes, ["label", "options"]) ||
        !Array.isArray(entry.attributes.options) ||
        entry.attributes.options.length === 0 ||
        !entry.attributes.options.every((option) =>
          sameKeys(option, ["label", "required"]) &&
          typeof option.label === "string" &&
          option.required === true
        )) {
      errors.push(`Issue template checkbox field ${entry.id} must have exact required options`);
    }
    return;
  }
  if (!isObject(entry.validations) || !sameKeys(entry.validations, ["required"]) || entry.validations.required !== true) {
    errors.push(`Issue template field must be required: ${entry.id}`);
  }
  const attributeKeys = expectedType === "dropdown"
    ? ["label", "description", "options"]
    : ["label", "description", "value"];
  if (!sameKeys(entry.attributes, attributeKeys) || typeof entry.attributes.description !== "string") {
    errors.push(`Issue template field ${entry.id} has unexpected or missing attributes`);
  }
}

function parseCurrentRecord(value, errors) {
  if (typeof value !== "string" || !value.includes("<!-- requirement-record:v1 -->")) {
    errors.push("Issue current record marker is missing");
    return undefined;
  }
  const match = value.match(/```yaml\s*\n([\s\S]*?)\n```/);
  if (!match) {
    errors.push("Issue current record YAML fence is missing");
    return undefined;
  }
  try {
    return YAML.parse(match[1]);
  } catch (error) {
    errors.push(`Issue current record YAML is invalid: ${normalizeError(error)}`);
    return undefined;
  }
}

export function validateIssueTemplate(source) {
  const errors = validateFileSize(source, MAX_TEMPLATE_BYTES, "Issue template");
  let form;
  try {
    form = YAML.parse(source);
  } catch (error) {
    return [...errors, `Issue template YAML is invalid: ${normalizeError(error)}`];
  }
  if (!sameKeys(form, ["name", "description", "title", "labels", "body"])) {
    errors.push("Issue template has unexpected or missing top-level keys");
  }
  if (typeof form?.name !== "string" || typeof form?.description !== "string" || typeof form?.title !== "string") {
    errors.push("Issue template name, description, and title must be strings");
  }
  if (!Array.isArray(form?.labels) || !form.labels.every((label) => typeof label === "string")) {
    errors.push("Issue template labels must be an array of strings");
  }
  if (!Array.isArray(form?.body)) {
    return [...errors, "Issue template body must be an array"];
  }
  if (form.body.length !== REQUIRED_ISSUE_IDS.length + 1) {
    errors.push(`Issue template body must contain exactly ${REQUIRED_ISSUE_IDS.length + 1} elements`);
  }
  const seen = new Set();
  let markdownCount = 0;
  for (const [index, entry] of form.body.entries()) {
    if (entry?.type === "markdown") markdownCount += 1;
    validateIssueElement(entry, index, seen, errors);
  }
  if (markdownCount !== 1) errors.push("Issue template must contain exactly one markdown element");
  for (const id of REQUIRED_ISSUE_IDS) {
    if (!seen.has(id)) errors.push(`Issue template is missing field: ${id}`);
  }

  const entries = new Map(form.body.filter((entry) => entry?.id).map((entry) => [entry.id, entry]));
  const issueTypes = entries.get("issue_type")?.attributes?.options;
  if (JSON.stringify(issueTypes) !== JSON.stringify(["Roadmap", "Feature", "Maintenance"])) {
    errors.push("Issue template requirement types must be Roadmap, Feature, Maintenance");
  }
  const lifecycle = entries.get("lifecycle")?.attributes?.options;
  if (JSON.stringify(lifecycle) !== JSON.stringify(INITIAL_LIFECYCLE_VALUES)) {
    errors.push("Issue template new-Issue lifecycle must contain only needs-design");
  }

  const record = parseCurrentRecord(entries.get("current_record")?.attributes?.value, errors);
  const recordKeys = [
    "schemaVersion", "revision", "status", "priority", "productOwner",
    "technicalOwner", "implementationOwner", "automatedPreReviewOwner",
    "humanReviewOwner", "userOutcome", "requirements", "acceptanceCriteria",
    "parent", "dependencies", "supersedes", "lastDecisionAt"
  ];
  if (record && !sameKeys(record, recordKeys)) {
    errors.push("Issue current record has unexpected or missing keys");
  }
  if (record?.schemaVersion !== "requirement-record.v1" || record?.revision !== "R1") {
    errors.push("Issue current record must start at requirement-record.v1 revision R1");
  }
  if (record?.status !== "needs-design" || lifecycle?.[0] !== record?.status) {
    errors.push("Issue lifecycle default must consistently be needs-design");
  }
  if (!Array.isArray(record?.requirements) || !record.requirements.every((id) => /^REQ-\d{3}$/.test(id))) {
    errors.push("Issue current record requirements must use REQ-NNN identifiers");
  }
  if (!Array.isArray(record?.acceptanceCriteria) || !record.acceptanceCriteria.every((id) => /^AC-\d{3}$/.test(id))) {
    errors.push("Issue current record acceptanceCriteria must use AC-NNN identifiers");
  }

  const deliveryOwners = entries.get("delivery_owners")?.attributes?.value;
  for (const field of [
    "implementationOwner",
    "automatedPreReviewOwner",
    "humanReviewOwner"
  ]) {
    if (typeof record?.[field] !== "string" || !record[field].trim()) {
      errors.push(`Issue current record ${field} must be a non-empty string`);
    }
    if (typeof deliveryOwners !== "string" || !deliveryOwners.includes(`${field}:`)) {
      errors.push(`Issue delivery owners section is missing: ${field}`);
    }
  }
  if (!String(deliveryOwners || "").includes("PREFLIGHT PASS")) {
    errors.push("Issue delivery owners section must distinguish PREFLIGHT PASS from GitHub approval");
  }

  const readiness = entries.get("readiness")?.attributes?.options;
  const readinessText = Array.isArray(readiness)
    ? readiness.map((option) => String(option?.label || "")).join("\n")
    : "";
  for (const token of [
    "requirement-decision:v1",
    "full canonical URL",
    "Merge, release, product acceptance, and owner milestone acceptance"
  ]) {
    if (!readinessText.includes(token)) errors.push(`Issue integrity checklist is missing: ${token}`);
  }
  return errors;
}

function lifecycleStatus(value) {
  const match = typeof value === "string" ? value.match(/^status=([^;]+)(?:;|$)/) : null;
  return match ? match[1].trim() : undefined;
}

export function validateDecisionExampleContinuity(markdown) {
  const errors = [];
  const section = sectionBody(markdown, "Exact semantic decision examples");
  let previousHeadingIndex = -1;
  for (const specification of DECISION_EXAMPLE_SPEC) {
    const headingIndex = section.search(headingPattern(3, specification.heading));
    if (headingIndex !== -1 && headingIndex < previousHeadingIndex) {
      errors.push("semantic decision headings must follow the exact specification order");
      break;
    }
    if (headingIndex !== -1) previousHeadingIndex = headingIndex;
  }
  const envelopePattern =
    /<!-- requirement-decision:v1 -->\s*```yaml\s*\r?\n([\s\S]*?)\r?\n```/g;
  const totalMarkers = section.match(/<!-- requirement-decision:v1 -->/g)?.length || 0;
  const totalEnvelopes = [...section.matchAll(envelopePattern)].length;
  if (totalMarkers !== DECISION_EXAMPLE_SPEC.length ||
      totalEnvelopes !== DECISION_EXAMPLE_SPEC.length) {
    errors.push(
      `semantic decision examples need exactly ${DECISION_EXAMPLE_SPEC.length} requirement-decision.v1 envelopes`
    );
  }

  const decisions = new Map();
  for (const specification of DECISION_EXAMPLE_SPEC) {
    const exampleSection = sectionBodyAtLevel(markdown, 3, specification.heading);
    const markerCount =
      exampleSection.match(/<!-- requirement-decision:v1 -->/g)?.length || 0;
    const envelopes = [...exampleSection.matchAll(envelopePattern)];
    if (markerCount !== 1 || envelopes.length !== 1) {
      errors.push(
        `semantic decision example ${specification.heading} needs exactly one requirement-decision.v1 envelope`
      );
      continue;
    }
    const yaml = envelopes[0][1];
    if (Buffer.byteLength(yaml, "utf8") > 8_192) {
      errors.push(`semantic decision example ${specification.heading} exceeds 8192 bytes`);
      continue;
    }
    let decision;
    try {
      decision = YAML.parse(yaml);
    } catch (error) {
      errors.push(
        `semantic decision example ${specification.heading} YAML is invalid: ${normalizeError(error)}`
      );
      continue;
    }
    if (!isObject(decision)) {
      errors.push(`semantic decision example ${specification.heading} must be a YAML object`);
      continue;
    }
    decisions.set(specification.heading, decision);
    if (decision.schemaVersion !== "requirement-decision.v1") {
      errors.push(
        `semantic decision example ${specification.heading} schemaVersion must be requirement-decision.v1`
      );
    }
    if (decision.decisionType !== specification.decisionType) {
      errors.push(
        `semantic decision example ${specification.heading} decisionType must be ${specification.decisionType}`
      );
    }
    if (decision.previousRevision !== specification.previousRevision ||
        decision.resultingRevision !== specification.resultingRevision) {
      errors.push(
        `semantic decision example ${specification.heading} revisions must be exactly ${specification.previousRevision}→${specification.resultingRevision}`
      );
    }
  }

  const release = decisions.get("Release from HOLD");
  const duplicate = decisions.get("Duplicate");
  const releasedStatus = lifecycleStatus(release?.newDecision);
  const duplicateOldStatus = lifecycleStatus(duplicate?.oldDecision);
  if (release && duplicate &&
      (!releasedStatus || duplicateOldStatus !== releasedStatus)) {
    errors.push(
      "semantic R8→R9 continuity requires duplicate.oldDecision status to equal release.newDecision status"
    );
  }
  return errors;
}

export function validateGovernanceGuide(markdown) {
  const errors = [
    ...validateFileSize(markdown, MAX_GUIDE_BYTES, "governance guide"),
    ...requireSingleHeadings(markdown, REQUIRED_GUIDE_HEADINGS),
    ...validateDecisionExampleContinuity(markdown)
  ];
  for (const heading of REQUIRED_DECISION_EXAMPLES) {
    if (headingCount(markdown, 3, heading) !== 1) {
      errors.push(`governance guide needs one decision example: ${heading}`);
    }
  }
  for (const marker of [
    "<!-- requirement-record:v1 -->",
    "<!-- requirement-decision:v1 -->",
    "<!-- verification-ledger:v1 -->",
    "<!-- product-review:v1 -->",
    "<!-- milestone-packet:v1 -->",
    "<!-- milestone-owner-decision:v1 -->"
  ]) {
    if (!markdown.includes(marker)) errors.push(`governance guide is missing marker: ${marker}`);
  }
  for (const lifecycle of DOCUMENTED_LIFECYCLE_VALUES) {
    if (!markdown.includes(`\`${lifecycle}\``)) {
      errors.push(`governance guide is missing lifecycle: ${lifecycle}`);
    }
  }
  for (const text of [
    "one authoritative initial lifecycle value",
    "GitHub comments are technically editable",
    "not technical tamper prevention",
    "decision: ACCEPT",
    "`REJECT`",
    "frozenSha:"
  ]) {
    if (!markdown.includes(text)) errors.push(`governance guide is missing policy boundary: ${text}`);
  }
  return errors;
}

export function validateCiWorkflow(source) {
  const errors = [];
  const command = 'npm run governance:check -- --github-event-file "$GITHUB_EVENT_PATH"';
  const condition = "if: github.event_name == 'pull_request' && matrix.node-version == 22";
  let workflow;
  try {
    workflow = YAML.parse(source);
  } catch (error) {
    return [`CI workflow YAML is invalid: ${normalizeError(error)}`];
  }

  const expectedTypes = ALLOWED_PULL_REQUEST_ACTIONS;
  const pullRequest = workflow?.on?.pull_request;
  if (!isObject(pullRequest) ||
      !sameKeys(pullRequest, ["types"]) ||
      JSON.stringify(pullRequest.types) !== JSON.stringify(expectedTypes)) {
    errors.push(
      "CI pull_request types must be exactly opened, synchronize, reopened, edited in that order"
    );
  }
  const push = workflow?.on?.push;
  if (!isObject(push) ||
      !sameKeys(push, ["branches"]) ||
      JSON.stringify(push.branches) !== JSON.stringify(["main"])) {
    errors.push("CI push branches must remain exactly main");
  }

  const testJob = workflow?.jobs?.test;
  const nodeVersions = testJob?.strategy?.matrix?.["node-version"];
  if (!Array.isArray(nodeVersions) ||
      nodeVersions.filter((version) => version === 22).length !== 1) {
    errors.push("CI test matrix must contain exactly one Node 22 lane");
  }
  const steps = testJob?.steps;
  if (!Array.isArray(steps)) {
    errors.push("CI test job steps must be an array");
  } else {
    const checkoutSteps = steps.filter((step) => step?.uses === "actions/checkout@v6");
    if (checkoutSteps.length !== 1 || checkoutSteps[0]?.with?.["fetch-depth"] !== 0) {
      errors.push("CI test checkout must use actions/checkout@v6 with fetch-depth 0");
    }
    const validationSteps = steps.filter((step) => step?.run === command);
    if (validationSteps.length !== 1) {
      errors.push("CI workflow must read the PR body through quoted GITHUB_EVENT_PATH");
    } else if (validationSteps[0]?.if !== condition.slice(4)) {
      errors.push("CI workflow must validate PR events on exactly the Node 22 lane");
    }
  }
  if (source.includes("github.event.pull_request.body")) {
    errors.push("CI workflow must not interpolate the PR body into workflow shell source");
  }
  return errors;
}

function validateManifest(manifest) {
  const errors = [];
  if (!sameKeys(manifest, ["schemaVersion", "limits", "prExamples"])) {
    errors.push("fixture manifest has unexpected or missing top-level keys");
  }
  if (manifest?.schemaVersion !== "requirement-governance-fixtures.v1") {
    errors.push("fixture manifest schemaVersion must be requirement-governance-fixtures.v1");
  }
  if (!sameKeys(manifest?.limits, ["maxFixtures", "maxFixtureBytes"]) ||
      manifest?.limits?.maxFixtures !== MAX_FIXTURES ||
      manifest?.limits?.maxFixtureBytes !== MAX_FIXTURE_BYTES) {
    errors.push("fixture manifest limits do not match checker limits");
  }
  if (!Array.isArray(manifest?.prExamples)) {
    errors.push("fixture manifest prExamples must be an array");
    return errors;
  }
  if (manifest.prExamples.length < 2 || manifest.prExamples.length > MAX_FIXTURES) {
    errors.push(`fixture manifest must list between 2 and ${MAX_FIXTURES} PR examples`);
  }
  if (!manifest.prExamples.some((entry) => entry?.expectedValid === true)) {
    errors.push("fixture manifest needs at least one valid PR example");
  }
  if (!manifest.prExamples.some((entry) => entry?.expectedValid === false)) {
    errors.push("fixture manifest needs at least one invalid PR example");
  }
  return errors;
}

function safeFixturePath(corpusRoot, relativePath) {
  if (typeof relativePath !== "string" || !/^pr\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(relativePath)) {
    throw new TypeError(`fixture path is not a safe POSIX relative path: ${relativePath}`);
  }
  const resolved = path.resolve(corpusRoot, ...relativePath.split("/"));
  const relative = path.relative(path.resolve(corpusRoot), resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new TypeError(`fixture path escapes the corpus: ${relativePath}`);
  }
  return resolved;
}

async function inspectNode(nodePath, kind, label, containmentRoot) {
  let info;
  try {
    info = await lstat(nodePath);
  } catch (error) {
    throw new TypeError(`${label} is missing: ${normalizeError(error)}`);
  }
  const validKind = kind === "file" ? info.isFile() : info.isDirectory();
  if (info.isSymbolicLink() || !validKind) {
    throw new TypeError(`${label} must be a ${kind === "file" ? "regular non-symlink file" : "non-symlink directory"}`);
  }
  const resolved = await realpath(nodePath);
  if (containmentRoot) {
    const relative = path.relative(containmentRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new TypeError(`${label} realpath escapes the fixture corpus`);
    }
  }
  return { info, resolved };
}

async function readBoundedRegularFile(filePath, maxBytes, label, containmentRoot) {
  const inspected = await inspectNode(filePath, "file", label, containmentRoot);
  if (inspected.info.size > maxBytes) {
    throw new TypeError(`${label} exceeds ${maxBytes} bytes`);
  }
  return readFile(inspected.resolved, "utf8");
}

export async function validateFixtureCorpus(corpusRoot) {
  const errors = [];
  let rootReal;
  try {
    rootReal = (await inspectNode(corpusRoot, "directory", "fixture corpus root")).resolved;
  } catch (error) {
    return { errors: [normalizeError(error)], fixtureCount: 0 };
  }

  const manifestPath = path.join(corpusRoot, "manifest.json");
  let manifestText;
  try {
    manifestText = await readBoundedRegularFile(
      manifestPath,
      MAX_MANIFEST_BYTES,
      "fixture manifest",
      rootReal
    );
  } catch (error) {
    return { errors: [normalizeError(error)], fixtureCount: 0 };
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    return { errors: [`fixture manifest JSON is invalid: ${normalizeError(error)}`], fixtureCount: 0 };
  }
  errors.push(...validateManifest(manifest));
  if (!Array.isArray(manifest?.prExamples)) return { errors, fixtureCount: 0 };

  const prPath = path.join(corpusRoot, "pr");
  try {
    await inspectNode(prPath, "directory", "fixture pr directory", rootReal);
  } catch (error) {
    return { errors: [...errors, normalizeError(error)], fixtureCount: manifest.prExamples.length };
  }

  const listedFiles = [];
  const seen = new Set();
  for (const [index, entry] of manifest.prExamples.entries()) {
    const label = `fixture[${index}]`;
    if (!sameKeys(entry, ["file", "expectedValid", "expectedErrors"])) {
      errors.push(`${label} has unexpected or missing keys`);
      continue;
    }
    if (typeof entry.expectedValid !== "boolean" || !Array.isArray(entry.expectedErrors) ||
        !entry.expectedErrors.every((error) => typeof error === "string")) {
      errors.push(`${label} expectedValid/expectedErrors have invalid types`);
      continue;
    }
    if (entry.expectedValid !== (entry.expectedErrors.length === 0)) {
      errors.push(`${label} expectedValid disagrees with expectedErrors`);
    }
    let filePath;
    try {
      filePath = safeFixturePath(corpusRoot, entry.file);
    } catch (error) {
      errors.push(`${label}: ${normalizeError(error)}`);
      continue;
    }
    if (seen.has(entry.file)) {
      errors.push(`fixture file is listed more than once: ${entry.file}`);
      continue;
    }
    seen.add(entry.file);
    listedFiles.push(entry.file);
    let markdown;
    try {
      markdown = await readBoundedRegularFile(
        filePath,
        MAX_FIXTURE_BYTES,
        `fixture ${entry.file}`,
        rootReal
      );
    } catch (error) {
      errors.push(normalizeError(error));
      continue;
    }
    const actualErrors = validatePullRequestTrace(markdown);
    if (JSON.stringify(actualErrors) !== JSON.stringify(entry.expectedErrors)) {
      errors.push(
        `${entry.file}: expected ${JSON.stringify(entry.expectedErrors)}, observed ${JSON.stringify(actualErrors)}`
      );
    }
  }

  try {
    const entries = await readdir(prPath, { withFileTypes: true });
    if (entries.length > MAX_FIXTURES) {
      errors.push(`fixture directory exceeds ${MAX_FIXTURES} entries`);
    }
    const actualFiles = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = `pr/${entry.name}`;
      try {
        await inspectNode(path.join(prPath, entry.name), "file", `fixture ${relative}`, rootReal);
      } catch (error) {
        errors.push(normalizeError(error));
        continue;
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(entry.name)) {
        errors.push(`fixture directory contains a non-fixture entry: ${relative}`);
        continue;
      }
      actualFiles.push(relative);
    }
    const expectedFiles = [...listedFiles].sort();
    if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
      errors.push(
        `fixture allowlist mismatch: expected ${JSON.stringify(expectedFiles)}, observed ${JSON.stringify(actualFiles)}`
      );
    }
  } catch (error) {
    errors.push(`cannot enumerate fixture corpus: ${normalizeError(error)}`);
  }
  return { errors, fixtureCount: manifest.prExamples.length };
}

function runGit(repositoryRoot, args) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    shell: false
  });
  if (result.error) {
    return { error: `git ${args[0]} could not run: ${normalizeError(result.error)}` };
  }
  return result;
}

function validateCommitRange(repositoryRoot, baseSha, headSha) {
  const errors = [];
  for (const [label, sha] of [["base", baseSha], ["head", headSha]]) {
    const reachable = runGit(repositoryRoot, ["cat-file", "-e", `${sha}^{commit}`]);
    if (reachable.error || reachable.status !== 0) {
      errors.push(`GitHub event ${label} SHA is not a reachable local commit: ${sha}`);
    }
  }
  if (errors.length) return errors;

  const range = `${baseSha}..${headSha}`;
  const listing = runGit(repositoryRoot, [
    "rev-list",
    "--reverse",
    `--max-count=${MAX_COMMIT_COUNT + 1}`,
    range
  ]);
  if (listing.error || listing.status !== 0) {
    return [`cannot enumerate exact GitHub event commit range ${range}`];
  }
  const commits = listing.stdout.trim()
    ? listing.stdout.trim().split(/\r?\n/)
    : [];
  if (commits.length > MAX_COMMIT_COUNT) {
    return [`GitHub event commit range exceeds ${MAX_COMMIT_COUNT} commits`];
  }
  if (!commits.every((sha) => FULL_COMMIT_SHA.test(sha))) {
    return ["git returned an invalid commit identity for the GitHub event range"];
  }

  for (const sha of commits) {
    const messageResult = runGit(repositoryRoot, [
      "show",
      "--no-patch",
      "--format=%B",
      sha
    ]);
    if (messageResult.error || messageResult.status !== 0) {
      errors.push(`cannot read commit message for ${sha}`);
      continue;
    }
    if (Buffer.byteLength(messageResult.stdout, "utf8") > MAX_COMMIT_MESSAGE_BYTES) {
      errors.push(`commit message for ${sha} exceeds ${MAX_COMMIT_MESSAGE_BYTES} bytes`);
      continue;
    }
    for (const keyword of findAutomaticCloseKeywords(messageResult.stdout)) {
      errors.push(`automatic close keyword is forbidden in commit ${sha}: ${keyword}`);
    }
  }
  return errors;
}

function validateGithubEventEnvelope(event) {
  const errors = [];
  const pullRequest = event?.pull_request;
  if (!isObject(event) || !isObject(pullRequest)) {
    return ["GitHub event must contain a pull_request object"];
  }
  if (!ALLOWED_PULL_REQUEST_ACTIONS.includes(event.action)) {
    errors.push(
      "GitHub event action must be opened, synchronize, reopened, or edited"
    );
  }
  if (!Number.isInteger(event.number) || event.number <= 0) {
    errors.push("GitHub event must contain a positive pull request number");
  }
  if (typeof pullRequest.body !== "string" || pullRequest.body.trim() === "") {
    errors.push("GitHub event pull_request.body must be a nonempty string");
  }

  const repositoryName = event.repository?.full_name;
  const baseRepositoryName = pullRequest.base?.repo?.full_name;
  const headRepositoryName = pullRequest.head?.repo?.full_name;
  if (!FULL_REPOSITORY_NAME.test(repositoryName || "")) {
    errors.push("GitHub event repository.full_name must be an owner/repository identity");
  }
  if (!FULL_REPOSITORY_NAME.test(baseRepositoryName || "") ||
      baseRepositoryName !== repositoryName) {
    errors.push("GitHub event base repository must match event.repository.full_name");
  }
  if (!FULL_REPOSITORY_NAME.test(headRepositoryName || "")) {
    errors.push("GitHub event head repository must be an owner/repository identity");
  }

  if (!FULL_COMMIT_SHA.test(pullRequest.base?.sha || "")) {
    errors.push("GitHub event base SHA must be exactly 40 lowercase hexadecimal characters");
  }
  if (!FULL_COMMIT_SHA.test(pullRequest.head?.sha || "")) {
    errors.push("GitHub event head SHA must be exactly 40 lowercase hexadecimal characters");
  }
  return errors;
}

export async function validateGithubEventFile(eventPath, repositoryRoot = process.cwd()) {
  let text;
  try {
    text = await readBoundedRegularFile(eventPath, MAX_EVENT_BYTES, "GitHub event file");
  } catch (error) {
    return [normalizeError(error)];
  }
  let event;
  try {
    event = JSON.parse(text);
  } catch (error) {
    return [`GitHub event JSON is invalid: ${normalizeError(error)}`];
  }
  const envelopeErrors = validateGithubEventEnvelope(event);
  if (envelopeErrors.length) return envelopeErrors;
  return [
    ...validatePullRequestTrace(event.pull_request.body),
    ...validateCommitRange(
      repositoryRoot,
      event.pull_request.base.sha,
      event.pull_request.head.sha
    )
  ];
}

export async function runGovernanceCheck(repositoryRoot) {
  const paths = {
    issue: path.join(repositoryRoot, ".github/ISSUE_TEMPLATE/roadmap_item.yml"),
    pullRequest: path.join(repositoryRoot, ".github/pull_request_template.md"),
    ci: path.join(repositoryRoot, ".github/workflows/ci.yml"),
    guide: path.join(repositoryRoot, "docs/requirement-governance.md"),
    corpus: path.join(repositoryRoot, "fixtures/requirement-governance/v1")
  };
  const [issue, pullRequest, ci, guide] = await Promise.all([
    readFile(paths.issue, "utf8"),
    readFile(paths.pullRequest, "utf8"),
    readFile(paths.ci, "utf8"),
    readFile(paths.guide, "utf8")
  ]);
  const corpus = await validateFixtureCorpus(paths.corpus);
  return {
    errors: [
      ...validateIssueTemplate(issue).map((error) => `Issue template: ${error}`),
      ...validatePullRequestTemplate(pullRequest).map((error) => `PR template: ${error}`),
      ...validateCiWorkflow(ci).map((error) => `CI workflow: ${error}`),
      ...validateGovernanceGuide(guide).map((error) => `governance guide: ${error}`),
      ...corpus.errors.map((error) => `fixture corpus: ${error}`)
    ],
    fixtureCount: corpus.fixtureCount
  };
}

async function main() {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2);
  if (args.length === 0) {
    const result = await runGovernanceCheck(repositoryRoot);
    if (result.errors.length) {
      process.stderr.write(
        `requirement-governance-check failed:\n${result.errors.map((error) => `- ${error}`).join("\n")}\n`
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `requirement-governance-check passed (${result.fixtureCount} allowlisted PR fixtures)\n`
    );
    return;
  }
  if (args.length !== 2 || args[0] !== "--github-event-file" || !args[1]) {
    throw new TypeError("usage: requirement-governance-check [--github-event-file <path>]");
  }
  const errors = await validateGithubEventFile(args[1], process.cwd());
  if (errors.length) {
    process.stderr.write(
      `pull-request-trace-check failed:\n${errors.map((error) => `- ${error}`).join("\n")}\n`
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write("pull-request-trace-check passed for GitHub event body and commit range\n");
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `requirement-governance-check: ${normalizeError(error) || "unexpected_error"}\n`
    );
    process.exitCode = 2;
  });
}
