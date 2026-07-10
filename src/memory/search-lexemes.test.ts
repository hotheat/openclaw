import { describe, expect, it } from "vitest";
import { createDomainLexicon, extractTermsFromLexiconFile } from "./domain-lexicon.js";
import {
  buildSearchTokenEntries,
  buildSearchTokenValues,
  deserializeSearchTokens,
  scoreSearchTokenMatches,
  serializeSearchTokens,
} from "./search-lexemes.js";

describe("search lexemes", () => {
  it("classifies han words, bigrams, and unigrams for search indexing", () => {
    const entries = buildSearchTokenEntries("讨论中文分词");
    const tokens = entries.map((entry) => entry.value);
    const byValue = new Map(entries.map((entry) => [entry.value, entry]));

    expect(tokens).toEqual(
      expect.arrayContaining(["讨", "论", "中", "文", "分", "词", "讨论", "中文", "分词"]),
    );
    expect(byValue.get("讨论")).toMatchObject({ kind: "word", weight: 1 });
    expect(byValue.get("中文")).toMatchObject({ kind: "word", weight: 1 });
    expect(byValue.get("分词")).toMatchObject({ kind: "word", weight: 1 });
    expect(byValue.get("讨")).toMatchObject({ kind: "unigram", weight: 0.1 });
  });

  it("keeps mixed technical terms alongside han tokens", () => {
    const tokens = buildSearchTokenValues("昨天讨论 API 方案");

    expect(tokens).toEqual(expect.arrayContaining(["讨", "论", "讨论", "api", "方", "案", "方案"]));
    expect(tokens).not.toContain("昨天");
    expect(tokens).not.toContain("天讨");
  });

  it("serializes tokens as a space-separated string while preserving spaces inside tokens", () => {
    const serialized = serializeSearchTokens(["讨论", "oric pharmaceuticals", "a_b%~", "方案"]);

    expect(serialized).toBe("讨论 oric~20pharmaceuticals a~5fb~25~7e 方案");
    expect(deserializeSearchTokens(serialized)).toEqual([
      "讨论",
      "oric pharmaceuticals",
      "a_b%~",
      "方案",
    ]);
  });

  it("keeps configured domain terms before generic tokenization", () => {
    const lexicon = createDomainLexicon({
      terms: ["百济神州", "替雷利珠单抗", "PD-1", "CLDN18.2", "AK112", "OpenClaw"],
    });

    const entries = buildSearchTokenEntries(
      "百济神州 AK112 的替雷利珠单抗和 PD-1/CLDN18.2",
      lexicon,
    );
    const tokens = entries.map((entry) => entry.value);
    const byValue = new Map(entries.map((entry) => [entry.value, entry]));

    expect(tokens).toEqual(
      expect.arrayContaining(["百济神州", "ak112", "替雷利珠单抗", "pd-1", "cldn18.2"]),
    );
    expect(byValue.get("百济神州")).toMatchObject({ kind: "word", weight: 1 });
    expect(byValue.get("pd-1")).toMatchObject({ kind: "word", weight: 1 });
  });

  it("requires token boundaries when matching latin domain terms", () => {
    const lexicon = createDomainLexicon({ terms: ["EED"] });

    expect(buildSearchTokenValues("need and needed", lexicon)).not.toContain("eed");
    expect(buildSearchTokenValues("EED inhibitor", lexicon)).toContain("eed");
  });

  it("scores classified token matches by normalized token weight", () => {
    const queryTokens = buildSearchTokenEntries("讨论方案");
    const indexedTokens = serializeSearchTokens(["讨论", "方案", "论方", "讨", "论", "方", "案"]);

    expect(scoreSearchTokenMatches(queryTokens, indexedTokens)).toBeCloseTo(1);
    expect(scoreSearchTokenMatches(queryTokens, serializeSearchTokens(["讨", "论"]))).toBeCloseTo(
      0.2 / 2.75,
    );
  });

  it("extracts companies, drugs, targets, and note aliases from configured yaml", () => {
    const terms = extractTermsFromLexiconFile(
      [
        "companies:",
        "  - name: ORIC Pharmaceuticals",
        "    targets:",
        "      - drug: ORIC-944",
        "        target: EED",
        "        category: PRC2 (EED, EZH1/2)",
        "        note: 信诺维医药",
      ].join("\n"),
      "companies_targets.yaml",
    );
    const lexicon = createDomainLexicon({ terms });

    expect(lexicon.normalizedTerms).toEqual(
      expect.arrayContaining(["oric pharmaceuticals", "oric-944", "eed", "信诺维医药"]),
    );
  });

  it("extracts mixed-case and title-case entities from note text", () => {
    const terms = extractTermsFromLexiconFile(
      [
        "companies:",
        "  - name: Acme Bio",
        "    targets:",
        "      - target: PRC2",
        "        note: siRNA and mRNA against Kras with EED, PD-1 for the study",
      ].join("\n"),
      "note_entities.yaml",
    );
    const lexicon = createDomainLexicon({ terms });

    expect(lexicon.normalizedTerms).toEqual(
      expect.arrayContaining(["sirna", "mrna", "kras", "eed", "pd-1"]),
    );
    // Guarded prose words must not leak in as domain terms.
    expect(lexicon.normalizedTerms).not.toContain("study");
    expect(lexicon.normalizedTerms).not.toContain("the");
    // `\b` anchoring must not slice "RNA" out of "siRNA" as a standalone term.
    expect(lexicon.normalizedTerms).not.toContain("rna");
  });

  it("parses json5 lexicon files with comments and trailing commas", () => {
    const terms = extractTermsFromLexiconFile(
      [
        "{",
        "  // JSON5 comments are valid in .json5 lexicons",
        "  companies: [",
        "    { name: 'ORIC Pharmaceuticals', targets: ['EED'], },",
        "  ],",
        "}",
      ].join("\n"),
      "companies_targets.json5",
    );

    expect(createDomainLexicon({ terms }).normalizedTerms).toEqual(
      expect.arrayContaining(["oric pharmaceuticals", "eed"]),
    );
  });

  it("does not inject default innovation-drug terms without configured terms", () => {
    const lexicon = createDomainLexicon();
    expect(lexicon.terms).toEqual([]);
  });
});
