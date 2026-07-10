/**
 * Query expansion for FTS-only search mode.
 *
 * When no embedding provider is available, we fall back to FTS (full-text search).
 * FTS works best with specific keywords, but users often ask conversational queries
 * like "that thing we discussed yesterday" or "之前讨论的那个方案".
 *
 * This module extracts meaningful keywords from such queries to improve FTS results.
 */

import {
  KO_TRAILING_PARTICLES,
  STOP_WORDS_AR,
  STOP_WORDS_EN,
  STOP_WORDS_ES,
  STOP_WORDS_JA,
  STOP_WORDS_KO,
  STOP_WORDS_PT,
  STOP_WORDS_ZH,
} from "./stop-tokens.js";

function stripKoreanTrailingParticle(token: string): string | null {
  for (const particle of KO_TRAILING_PARTICLES) {
    if (token.length > particle.length && token.endsWith(particle)) {
      return token.slice(0, -particle.length);
    }
  }
  return null;
}

function isUsefulKoreanStem(stem: string): boolean {
  // Prevent bogus one-syllable stems from words like "논의" -> "논".
  if (/[\uac00-\ud7af]/.test(stem)) {
    return stem.length >= 2;
  }
  // Keep stripped ASCII stems for mixed tokens like "API를" -> "api".
  return /^[a-z0-9_]+$/i.test(stem);
}

/**
 * Check if a token looks like a meaningful keyword.
 * Returns false for short tokens, numbers-only, etc.
 */
function isValidKeyword(token: string): boolean {
  if (!token || token.length === 0) {
    return false;
  }
  // Skip very short English words (likely stop words or fragments)
  if (/^[a-zA-Z]+$/.test(token) && token.length < 3) {
    return false;
  }
  // Skip pure numbers (not useful for semantic search)
  if (/^\d+$/.test(token)) {
    return false;
  }
  // Skip tokens that are all punctuation
  if (/^[\p{P}\p{S}]+$/u.test(token)) {
    return false;
  }
  return true;
}

/**
 * Simple tokenizer that handles English, Chinese, Korean, and Japanese text.
 * For Chinese, we do character-based splitting since we don't have a proper segmenter.
 * For English, we split on whitespace and punctuation.
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const normalized = text.toLowerCase().trim();

  // Split into segments (English words, Chinese character sequences, etc.)
  const segments = normalized.split(/[\s\p{P}]+/u).filter(Boolean);

  for (const segment of segments) {
    // Japanese text often mixes scripts (kanji/kana/ASCII) without spaces.
    // Extract script-specific chunks so technical terms like "API" / "バグ" are retained.
    if (/[\u3040-\u30ff]/.test(segment)) {
      const jpParts =
        segment.match(/[a-z0-9_]+|[\u30a0-\u30ffー]+|[\u4e00-\u9fff]+|[\u3040-\u309f]{2,}/g) ?? [];
      for (const part of jpParts) {
        if (/^[\u4e00-\u9fff]+$/.test(part)) {
          tokens.push(part);
          for (let i = 0; i < part.length - 1; i++) {
            tokens.push(part[i] + part[i + 1]);
          }
        } else {
          tokens.push(part);
        }
      }
    } else if (/[\u4e00-\u9fff]/.test(segment)) {
      // Check if segment contains CJK characters (Chinese)
      // For Chinese, extract character n-grams (unigrams and bigrams)
      const chars = Array.from(segment).filter((c) => /[\u4e00-\u9fff]/.test(c));
      // Add individual characters
      tokens.push(...chars);
      // Add bigrams for better phrase matching
      for (let i = 0; i < chars.length - 1; i++) {
        tokens.push(chars[i] + chars[i + 1]);
      }
    } else if (/[\uac00-\ud7af\u3131-\u3163]/.test(segment)) {
      // For Korean (Hangul syllables and jamo), keep the word as-is unless it is
      // effectively a stop word once trailing particles are removed.
      const stem = stripKoreanTrailingParticle(segment);
      const stemIsStopWord = stem !== null && STOP_WORDS_KO.has(stem);
      if (!STOP_WORDS_KO.has(segment) && !stemIsStopWord) {
        tokens.push(segment);
      }
      // Also emit particle-stripped stems when they are useful keywords.
      if (stem && !STOP_WORDS_KO.has(stem) && isUsefulKoreanStem(stem)) {
        tokens.push(stem);
      }
    } else {
      // For non-CJK, keep as single token
      tokens.push(segment);
    }
  }

  return tokens;
}

/**
 * Extract keywords from a conversational query for FTS search.
 *
 * Examples:
 * - "that thing we discussed about the API" → ["discussed", "API"]
 * - "之前讨论的那个方案" → ["讨论", "方案"]
 * - "what was the solution for the bug" → ["solution", "bug"]
 */
export function extractKeywords(query: string): string[] {
  const tokens = tokenize(query);
  const keywords: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    // Skip stop words
    if (
      STOP_WORDS_EN.has(token) ||
      STOP_WORDS_ES.has(token) ||
      STOP_WORDS_PT.has(token) ||
      STOP_WORDS_AR.has(token) ||
      STOP_WORDS_ZH.has(token) ||
      STOP_WORDS_KO.has(token) ||
      STOP_WORDS_JA.has(token)
    ) {
      continue;
    }
    // Skip invalid keywords
    if (!isValidKeyword(token)) {
      continue;
    }
    // Skip duplicates
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    keywords.push(token);
  }

  return keywords;
}

/**
 * Expand a query for FTS search.
 * Returns both the original query and extracted keywords for OR-matching.
 *
 * @param query - User's original query
 * @returns Object with original query and extracted keywords
 */
export function expandQueryForFts(query: string): {
  original: string;
  keywords: string[];
  expanded: string;
} {
  const original = query.trim();
  const keywords = extractKeywords(original);

  // Build expanded query: original terms OR extracted keywords
  // This ensures both exact matches and keyword matches are found
  const expanded = keywords.length > 0 ? `${original} OR ${keywords.join(" OR ")}` : original;

  return { original, keywords, expanded };
}

/**
 * Type for an optional LLM-based query expander.
 * Can be provided to enhance keyword extraction with semantic understanding.
 */
export type LlmQueryExpander = (query: string) => Promise<string[]>;

/**
 * Expand query with optional LLM assistance.
 * Falls back to local extraction if LLM is unavailable or fails.
 */
export async function expandQueryWithLlm(
  query: string,
  llmExpander?: LlmQueryExpander,
): Promise<string[]> {
  // If LLM expander is provided, try it first
  if (llmExpander) {
    try {
      const llmKeywords = await llmExpander(query);
      if (llmKeywords.length > 0) {
        return llmKeywords;
      }
    } catch {
      // LLM failed, fall back to local extraction
    }
  }

  // Fall back to local keyword extraction
  return extractKeywords(query);
}
