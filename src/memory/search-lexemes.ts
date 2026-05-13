import { extractKeywords } from "./query-expansion.js";

function hasHanScript(value: string): boolean {
  return /[\u4e00-\u9fff]/u.test(value);
}

export function buildSearchTokens(text: string): string[] {
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const token of extractKeywords(normalized)) {
    const trimmed = token.trim();
    if (!trimmed) {
      continue;
    }
    const includesHan = hasHanScript(trimmed);
    if (!includesHan && trimmed.length < 2) {
      continue;
    }
    if (seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    tokens.push(trimmed);
  }
  return tokens;
}

export function buildKeywordQueryTokens(query: string): string[] {
  return buildSearchTokens(query);
}

export function serializeSearchTokens(tokens: string[]): string {
  return tokens.join(" ");
}
