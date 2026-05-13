import { describe, expect, it } from "vitest";
import {
  buildKeywordQueryTokens,
  buildSearchTokens,
  serializeSearchTokens,
} from "./search-lexemes.js";

describe("search lexemes", () => {
  it("keeps han unigrams and bigrams for search indexing", () => {
    const tokens = buildSearchTokens("讨论中文分词");

    expect(tokens).toEqual(
      expect.arrayContaining(["讨", "论", "中", "文", "分", "词", "讨论", "中文", "分词"]),
    );
  });

  it("keeps mixed technical terms alongside han tokens", () => {
    const tokens = buildKeywordQueryTokens("昨天讨论 API 方案");

    expect(tokens).toEqual(expect.arrayContaining(["讨", "论", "讨论", "api", "方", "案", "方案"]));
    expect(tokens).not.toContain("昨天");
  });

  it("serializes tokens as a space-separated string", () => {
    expect(serializeSearchTokens(["讨论", "api", "方案"])).toBe("讨论 api 方案");
  });
});
