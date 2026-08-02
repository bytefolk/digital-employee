interface ExtractiveContext {
  id?: string
  title?: string
  text?: string
  score?: number
  document?: ExtractiveContext
}

function documentFromContext(context?: ExtractiveContext): ExtractiveContext | undefined {
  return context?.document || context;
}

function compact(text: unknown, maxChars = 900): string {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "can",
  "do",
  "for",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "of",
  "on",
  "or",
  "should",
  "the",
  "to",
  "what",
  "when",
  "where",
  "which",
  "with",
  "you"
]);

function keywordTokens(input: unknown): Set<string> {
  const tokens = new Set<string>();
  const text = String(input || "").toLowerCase();
  for (const match of text.matchAll(/[a-z0-9][a-z0-9_-]*/g)) {
    let token = match[0];
    if (token.length > 4 && token.endsWith("s")) token = token.slice(0, -1);
    if (!STOP_WORDS.has(token)) tokens.add(token);
  }
  for (const segment of text.split(/[^\u3400-\u9fff]+/u)) {
    for (let index = 0; index < segment.length - 1; index += 1) {
      tokens.add(segment.slice(index, index + 2));
    }
  }
  return tokens;
}

function sectionCandidates(text: unknown): string[] {
  const byHeading = String(text || "")
    .split(/(?=^#{1,6}\s)/m)
    .map((section) => section.trim())
    .filter(Boolean);
  if (byHeading.some((section) => /^#{1,6}\s/.test(section))) return byHeading;
  const paragraphs = String(text || "")
    .split(/\n{2,}/)
    .map((section) => section.trim())
    .filter(Boolean);
  return paragraphs.length ? paragraphs : [String(text || "")];
}

function bestExtract(question: unknown, text: string) {
  const queryTokens = keywordTokens(question);
  if (queryTokens.size === 0) return { text, matches: 0, coverage: 0 };
  let best = { text, matches: 0, coverage: 0 };
  for (const candidate of sectionCandidates(text)) {
    const candidateTokens = keywordTokens(candidate);
    let matches = 0;
    for (const token of queryTokens) {
      if (candidateTokens.has(token)) matches += 1;
    }
    const coverage = matches / queryTokens.size;
    if (
      coverage > best.coverage ||
      (coverage > 0 && coverage === best.coverage && candidate.length < best.text.length)
    ) {
      best = { text: candidate, matches, coverage };
    }
  }
  return best;
}

export class ExtractiveModel {
  prefix: string

  constructor({ prefix = "Based on the approved source" }: { prefix?: string } = {}) {
    this.prefix = prefix;
  }

  async generate(input: unknown = {}) {
    const value = input && typeof input === "object" && !Array.isArray(input)
      ? input as { question?: unknown; contexts?: unknown }
      : {};
    const question = typeof value.question === "string" ? value.question : "";
    const contexts = Array.isArray(value.contexts)
      ? value.contexts as ExtractiveContext[]
      : [];
    const best = documentFromContext(contexts[0]);
    if (!best?.text) {
      return {
        answer: "",
        confidence: 0,
        citationIds: [],
        needsHuman: true
      };
    }

    const extract = bestExtract(question, best.text);
    const retrievalScore = Number(contexts[0]?.score ?? 0);
    const confidence =
      extract.matches > 0
        ? Math.min(0.85, 0.25 + extract.coverage * 0.6 + retrievalScore * 0.2)
        : Math.min(0.12, retrievalScore);
    return {
      answer:
        extract.matches > 0
          ? `${this.prefix} “${best.title || "Untitled"}”:\n\n${compact(extract.text)}`
          : "",
      confidence,
      citationIds: extract.matches > 0 ? [best.id] : [],
      needsHuman: extract.matches === 0
    };
  }
}
