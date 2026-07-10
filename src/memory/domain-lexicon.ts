import path from "node:path";
import JSON5 from "json5";
import YAML from "yaml";

export type DomainLexicon = {
  terms: string[];
  normalizedTerms: string[];
};

// Common prose words to keep out of `note` title-case extraction. Real domain
// entities (companies, drugs, targets) come from dedicated keys; note is a
// free-text field so title-case capture needs a small guard against ordinary
// English words.
const NOTE_TITLECASE_STOPWORDS = new Set([
  "the",
  "this",
  "that",
  "these",
  "those",
  "and",
  "for",
  "with",
  "from",
  "into",
  "phase",
  "study",
  "trial",
  "data",
  "note",
  "notes",
  "drug",
  "drugs",
  "target",
  "targets",
  "company",
  "companies",
  "results",
  "result",
  "patients",
  "patient",
  "inhibitor",
  "therapy",
  "treatment",
  "disease",
  "cancer",
  "clinical",
  "pharmaceuticals",
  "pharma",
  "biotech",
  "therapeutics",
]);

export function normalizeDomainTerm(term: string): string {
  return term.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

// The default innovation-drug terms are no longer hardcoded here. They live in a
// workspace lexicon file (`<workspace>/lexicons/innovation-drug.yaml`) loaded via
// `memorySearch.lexicon.includeDefaults` during config resolution, then arrive
// here as ordinary resolved `terms`.
export function createDomainLexicon(params?: { terms?: string[] }): DomainLexicon {
  const rawTerms = [...(params?.terms ?? [])];

  const byNormalized = new Map<string, string>();
  for (const term of rawTerms) {
    addTerm(byNormalized, term);
  }

  const terms = Array.from(byNormalized.values()).toSorted((a, b) => {
    const len = b.length - a.length;
    return len !== 0 ? len : a.localeCompare(b);
  });
  const normalizedTerms = terms.map((term) => normalizeDomainTerm(term));
  return { terms, normalizedTerms };
}

export function extractTermsFromLexiconFile(content: string, filePath: string): string[] {
  const ext = path.extname(filePath).toLowerCase();
  const parsed =
    ext === ".json"
      ? JSON.parse(content)
      : ext === ".json5"
        ? JSON5.parse(content)
        : YAML.parse(content);
  const terms: string[] = [];
  collectTerms(parsed, terms, false);
  return terms;
}

function collectTerms(value: unknown, terms: string[], collectStrings: boolean): void {
  if (typeof value === "string") {
    if (collectStrings) {
      addValueTerms(terms, value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectTerms(entry, terms, collectStrings);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isDomainTermKey(key)) {
      collectTerms(entry, terms, true);
    } else if (key.trim().toLowerCase() === "note") {
      collectNoteTerms(entry, terms);
    } else if (Array.isArray(entry) || (entry && typeof entry === "object")) {
      collectTerms(entry, terms, false);
    }
  }
}

function isDomainTermKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return [
    "aliases",
    "category",
    "companies",
    "company",
    "companytype",
    "drug",
    "drugs",
    "indication",
    "indications",
    "modality",
    "modalities",
    "name",
    "target",
    "targets",
    "term",
    "terms",
  ].includes(normalized);
}

function addValueTerms(terms: string[], value: string): void {
  const trimmed = value.trim();
  if (!trimmed) {
    return;
  }
  terms.push(trimmed);
  for (const part of trimmed.split(/[():：,，、;；]+/u)) {
    const candidate = part.trim();
    if (candidate) {
      terms.push(candidate);
    }
  }
}

function collectNoteTerms(value: unknown, terms: string[]): void {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return;
  }
  // Uppercase-leading technical spans: EED, PD-1, CLDN18.2, CAR-T, HER2-low, TROP2.
  // `\b` anchors the start so we do not slice "RNA" out of "siRNA".
  for (const match of trimmed.matchAll(/\b[A-Z][A-Za-z0-9]*(?:[-./][A-Za-z0-9]+)*(?:\.[0-9]+)?/g)) {
    if (isUppercaseTechnicalSpan(match[0])) {
      terms.push(match[0]);
    }
  }
  // Lowercase-leading mixed-case entities: siRNA, mRNA, miRNA, shRNA, sgRNA, dsRNA.
  for (const match of trimmed.matchAll(/[a-z]+[A-Z][A-Za-z0-9]*/g)) {
    terms.push(match[0]);
  }
  // Title-case single-word entities: Kras, Myc \u2014 guarded against ordinary prose.
  for (const match of trimmed.matchAll(/\b[A-Z][a-z]{2,}\b/g)) {
    if (!NOTE_TITLECASE_STOPWORDS.has(match[0].toLowerCase())) {
      terms.push(match[0]);
    }
  }
  for (const match of trimmed.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    terms.push(match[0]);
  }
}

// A `note` uppercase-leading span is "technical" (kept) when it carries a digit,
// a separator, or at least two uppercase letters. This drops plain Title-case
// words like "Company" while keeping EED / PD-1 / CLDN18.2 / CAR-T.
function isUppercaseTechnicalSpan(token: string): boolean {
  const uppercaseCount = (token.match(/[A-Z]/g) ?? []).length;
  return uppercaseCount >= 2 || /[0-9]/.test(token) || /[-./]/.test(token);
}

function addTerm(byNormalized: Map<string, string>, term: string): void {
  const normalized = normalizeDomainTerm(term);
  if (!normalized || normalized.length < 2 || /^\d+$/u.test(normalized)) {
    return;
  }
  if (!byNormalized.has(normalized)) {
    byNormalized.set(normalized, term.trim());
  }
}
