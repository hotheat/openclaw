import { describe, expect, it } from "vitest";
import {
  HAN_SEARCH_STOP_TOKENS,
  SEARCH_WORD_STOP_TOKENS,
  STOP_WORDS_EN,
  STOP_WORDS_ZH,
} from "./stop-tokens.js";

describe("memory stop tokens", () => {
  it("shares generic query and search stop token lists", () => {
    expect(STOP_WORDS_EN.has("the")).toBe(true);
    expect(STOP_WORDS_ZH.has("昨天")).toBe(true);
    expect(SEARCH_WORD_STOP_TOKENS.has("the")).toBe(true);
    expect(SEARCH_WORD_STOP_TOKENS.has("昨天")).toBe(true);
    expect(HAN_SEARCH_STOP_TOKENS[0]).toBe("为什么");
  });
});
