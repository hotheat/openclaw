import { describe, expect, it } from "vitest";
import { hasReliableSummaryAdditions, normalizeStructuredSummary } from "./summary-markdown.js";

describe("hasReliableSummaryAdditions", () => {
  it("ignores daily heartbeat and transport-error noise", () => {
    const summary = [
      "## Daily Structured Summary",
      "",
      "- **Generated At**: 2026-05-20 13:21:56 GMT+8",
      "- **Source**: daily-rollover",
      "- **Source Sessions**: test-session",
      "",
      "### 最终结论",
      "- 周一清晨例行心跳检查，无主动用户请求。",
      "",
      "### 稳定失败教训",
      "- 心跳检查期间出现 Connection error，连续重试后无法正常响应。",
    ].join("\n");

    expect(hasReliableSummaryAdditions(summary)).toBe(false);
  });

  it("keeps durable user-facing facts", () => {
    const summary = [
      "## Daily Structured Summary",
      "",
      "- **Generated At**: 2026-05-20 13:21:56 GMT+8",
      "- **Source**: daily-rollover",
      "- **Source Sessions**: test-session",
      "",
      "### 稳定约束 / 用户偏好 / 重要决策",
      "- 用户偏好官方资料。",
      "",
      "### 最终结论",
      "- 用 daily structured summary 替代 transcript capture。",
    ].join("\n");

    expect(hasReliableSummaryAdditions(summary)).toBe(true);
  });

  it("keeps explicit operational decisions instead of dropping every retry or gateway mention", () => {
    const summary = [
      "## Daily Structured Summary",
      "",
      "- **Generated At**: 2026-05-20 13:21:56 GMT+8",
      "- **Source**: reset",
      "- **Source Sessions**: test-session",
      "",
      "### 稳定约束 / 用户偏好 / 重要决策",
      "- 网关重试策略改为指数退避。",
    ].join("\n");

    expect(hasReliableSummaryAdditions(summary)).toBe(true);
  });

  it("keeps user layout preferences even when they mention ppt or page orientation", () => {
    const summary = [
      "## Daily Structured Summary",
      "",
      "- **Generated At**: 2026-05-20 13:21:56 GMT+8",
      "- **Source**: reset",
      "- **Source Sessions**: test-session",
      "",
      "### 稳定约束 / 用户偏好 / 重要决策",
      "- 以后 PPT 都要横版，不要竖版。",
    ].join("\n");

    expect(hasReliableSummaryAdditions(summary)).toBe(true);
  });

  it("keeps plain durable content that mentions presentation format or timeout settings", () => {
    const summary = [
      "## Daily Structured Summary",
      "",
      "- **Generated At**: 2026-05-20 13:21:56 GMT+8",
      "- **Source**: reset",
      "- **Source Sessions**: test-session",
      "",
      "### 已验证有效的方法",
      "- PPT 使用横版模板。",
      "- timeout 预算配置为 60 秒。",
    ].join("\n");

    expect(hasReliableSummaryAdditions(summary)).toBe(true);
  });

  it("drops empty sections during normalization", () => {
    const summary = normalizeStructuredSummary({
      rawSummary: [
        "### 最终结论",
        "- 已确认使用官方来源。",
        "",
        "### 待继续事项",
        "- 无可靠新增项。",
      ].join("\n"),
      generatedAt: "2026-05-20 13:21:56 GMT+8",
      source: "reset",
      sessionId: "test-session",
      researcherExports: [],
    });

    expect(summary).toContain("### 最终结论");
    expect(summary).not.toContain("### 待继续事项");
    expect(summary).not.toContain("- 无可靠新增项。");
  });

  it("maps legacy section headings into current summary buckets", () => {
    const summary = normalizeStructuredSummary({
      rawSummary: [
        "### 用户偏好",
        "- 偏好官方资料。",
        "",
        "### 自定义需求",
        "- 需要剂量可追溯。",
        "",
        "### 重要决策",
        "- 用 daily structured summary 替代 transcript capture。",
        "",
        "### 未完成事项",
        "- 继续核对剂量来源。",
        "",
        "### 失败经验 / 反模式",
        "- 不接受推断剂量。",
      ].join("\n"),
      generatedAt: "2026-05-20 13:21:56 GMT+8",
      source: "reset",
      sessionId: "test-session",
      researcherExports: [],
    });

    expect(summary).toContain("### 稳定约束 / 用户偏好 / 重要决策");
    expect(summary).toContain("- 偏好官方资料。");
    expect(summary).toContain("- 需要剂量可追溯。");
    expect(summary).toContain("- 用 daily structured summary 替代 transcript capture。");
    expect(summary).toContain("### 待继续事项");
    expect(summary).toContain("- 继续核对剂量来源。");
    expect(summary).toContain("### 稳定失败教训");
    expect(summary).toContain("- 不接受推断剂量。");
    expect(summary).not.toContain("### 用户偏好");
  });
});
