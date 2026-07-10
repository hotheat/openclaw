import { normalizeDomainTerm, type DomainLexicon } from "./domain-lexicon.js";
import { extractKeywords } from "./query-expansion.js";
import { HAN_SEARCH_STOP_TOKENS, SEARCH_WORD_STOP_TOKENS } from "./stop-tokens.js";

export type SearchTokenKind = "word" | "bigram" | "unigram";

export type SearchToken = {
  value: string;
  kind: SearchTokenKind;
  weight: number;
};

export const SEARCH_TOKEN_WEIGHTS: Record<SearchTokenKind, number> = {
  word: 1,
  bigram: 0.35,
  unigram: 0.1,
};

const zhWordSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter("zh-CN", { granularity: "word" })
    : null;

function hasHanScript(value: string): boolean {
  return /[\u4e00-\u9fff]/u.test(value);
}

function isHanOnly(value: string): boolean {
  return /^[\u4e00-\u9fff]+$/u.test(value);
}

export function buildSearchTokenValues(text: string, lexicon?: DomainLexicon): string[] {
  return buildSearchTokenEntries(text, lexicon).map((entry) => entry.value);
}

export function buildSearchTokenEntries(text: string, lexicon?: DomainLexicon): SearchToken[] {
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }
  const tokens: SearchToken[] = [];
  const tokenIndex = new Map<string, number>();
  for (const token of matchDomainTerms(normalized, lexicon)) {
    pushToken(tokens, tokenIndex, token, "word");
  }
  for (const token of segmentWords(normalized)) {
    pushToken(tokens, tokenIndex, token, "word");
  }
  for (const token of extractKeywords(normalized)) {
    const trimmed = token.trim();
    if (!trimmed) {
      continue;
    }
    if (isHanOnly(trimmed)) {
      continue;
    }
    if (!isUsefulExtractedToken(trimmed)) {
      continue;
    }
    const includesHan = hasHanScript(trimmed);
    if (!includesHan && trimmed.length < 2) {
      continue;
    }
    pushToken(tokens, tokenIndex, trimmed, inferTokenKind(trimmed));
  }
  for (const token of buildHanNgrams(normalized, 2)) {
    pushToken(tokens, tokenIndex, token, "bigram");
  }
  for (const token of buildHanNgrams(normalized, 1)) {
    pushToken(tokens, tokenIndex, token, "unigram");
  }
  return tokens;
}

export function serializeSearchTokens(tokens: string[]): string {
  return tokens.map(serializeSearchTokenValue).join(" ");
}

export function deserializeSearchTokens(serialized: string): string[] {
  return serialized.split(/\s+/u).map(deserializeSearchTokenValue).filter(Boolean);
}

export function serializeSearchTokenValue(token: string): string {
  return normalizeDomainTerm(token)
    .replaceAll("~", "~7e")
    .replaceAll(" ", "~20")
    .replaceAll("%", "~25")
    .replaceAll("_", "~5f");
}

export function deserializeSearchTokenValue(token: string): string {
  return token
    .replaceAll("~5f", "_")
    .replaceAll("~25", "%")
    .replaceAll("~20", " ")
    .replaceAll("~7e", "~");
}

export function scoreSearchTokenMatches(
  queryTokens: SearchToken[],
  serializedTokens: string,
): number {
  if (queryTokens.length === 0) {
    return 0;
  }
  const haystack = new Set(deserializeSearchTokens(serializedTokens));
  let matchedWeight = 0;
  let queryWeight = 0;
  for (const token of queryTokens) {
    queryWeight += token.weight;
    if (haystack.has(token.value)) {
      matchedWeight += token.weight;
    }
  }
  return matchedWeight / Math.max(queryWeight, Number.EPSILON);
}

function matchDomainTerms(text: string, lexicon?: DomainLexicon): string[] {
  if (!lexicon?.terms.length) {
    return [];
  }
  const normalizedText = normalizeDomainTerm(text);
  const matches: string[] = [];
  for (let i = 0; i < lexicon.terms.length; i += 1) {
    const normalizedTerm = lexicon.normalizedTerms[i];
    if (!normalizedTerm) {
      continue;
    }
    if (matchesDomainTerm(normalizedText, normalizedTerm)) {
      matches.push(normalizedTerm);
    }
  }
  return matches;
}

function matchesDomainTerm(normalizedText: string, normalizedTerm: string): boolean {
  if (isHanOnly(normalizedTerm)) {
    return normalizedText.includes(normalizedTerm);
  }
  let fromIndex = 0;
  while (fromIndex < normalizedText.length) {
    const index = normalizedText.indexOf(normalizedTerm, fromIndex);
    if (index === -1) {
      return false;
    }
    if (hasDomainTermBoundary(normalizedText, index, normalizedTerm.length)) {
      return true;
    }
    fromIndex = index + 1;
  }
  return false;
}

function hasDomainTermBoundary(text: string, start: number, length: number): boolean {
  const before = start === 0 ? "" : text[start - 1];
  const afterIndex = start + length;
  const after = afterIndex >= text.length ? "" : text[afterIndex];
  return isDomainTermBoundary(before) && isDomainTermBoundary(after);
}

function isDomainTermBoundary(char: string | undefined): boolean {
  return !char || !/[\p{L}\p{N}_]/u.test(char);
}

function segmentWords(text: string): string[] {
  const tokens: string[] = [];
  if (zhWordSegmenter) {
    for (const part of zhWordSegmenter.segment(text)) {
      const segment = normalizeDomainTerm(part.segment);
      if (!part.isWordLike || !isUsefulWord(segment)) {
        continue;
      }
      tokens.push(segment);
    }
  }
  for (const match of text.matchAll(/[a-z0-9]+(?:[-._/][a-z0-9]+)+/giu)) {
    const token = normalizeDomainTerm(match[0]);
    if (isUsefulWord(token)) {
      tokens.push(token);
    }
  }
  return tokens;
}

function buildHanNgrams(text: string, size: 1 | 2): string[] {
  const tokens: string[] = [];
  for (const run of hanNgramRuns(text)) {
    const chars = Array.from(run);
    if (chars.length < size) {
      continue;
    }
    for (let i = 0; i <= chars.length - size; i += 1) {
      const token = chars.slice(i, i + size).join("");
      if (!SEARCH_WORD_STOP_TOKENS.has(token)) {
        tokens.push(token);
      }
    }
  }
  return tokens;
}

function hanNgramRuns(text: string): string[] {
  return Array.from(text.matchAll(/[\u4e00-\u9fff]+/gu), (match) => match[0]).flatMap((run) =>
    splitHanRunByStopTokens(run),
  );
}

function splitHanRunByStopTokens(run: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < run.length; ) {
    const stopToken = HAN_SEARCH_STOP_TOKENS.find((token) => run.startsWith(token, i));
    if (stopToken) {
      if (current) {
        parts.push(current);
        current = "";
      }
      i += stopToken.length;
      continue;
    }
    const char = run[i];
    if (char) {
      current += char;
    }
    i += 1;
  }
  if (current) {
    parts.push(current);
  }
  return parts.filter(Boolean);
}

function inferTokenKind(token: string): SearchTokenKind {
  if (isHanOnly(token)) {
    if (Array.from(token).length === 1) {
      return "unigram";
    }
    if (Array.from(token).length === 2) {
      return "bigram";
    }
  }
  return "word";
}

function isUsefulExtractedToken(token: string): boolean {
  const normalized = normalizeDomainTerm(token);
  if (!normalized || SEARCH_WORD_STOP_TOKENS.has(normalized)) {
    return false;
  }
  if (isHanOnly(normalized) && Array.from(normalized).length === 1) {
    return false;
  }
  return true;
}

function isUsefulWord(token: string): boolean {
  if (!token || SEARCH_WORD_STOP_TOKENS.has(token) || /^\d+$/u.test(token)) {
    return false;
  }
  if (isHanOnly(token)) {
    return Array.from(token).length >= 2;
  }
  return token.length >= 2;
}

function pushToken(
  tokens: SearchToken[],
  tokenIndex: Map<string, number>,
  token: string,
  kind: SearchTokenKind,
): void {
  const normalized = normalizeDomainTerm(token);
  if (!normalized) {
    return;
  }
  const weight = SEARCH_TOKEN_WEIGHTS[kind];
  const existingIndex = tokenIndex.get(normalized);
  if (existingIndex !== undefined) {
    if (weight > tokens[existingIndex].weight) {
      tokens[existingIndex] = { value: normalized, kind, weight };
    }
    return;
  }
  tokenIndex.set(normalized, tokens.length);
  tokens.push({ value: normalized, kind, weight });
}
