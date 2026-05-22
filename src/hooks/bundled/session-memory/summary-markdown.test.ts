import { describe, expect, it } from "vitest";
import { hasReliableSummaryAdditions } from "./summary-markdown.js";

describe("hasReliableSummaryAdditions", () => {
  it("ignores daily heartbeat and transport-error noise", () => {
    const summary = [
      "## Daily Structured Summary",
      "",
      "- **Generated At**: 2026-05-20 13:21:56 GMT+8",
      "- **Source**: daily-rollover",
      "- **Source Sessions**: test-session",
      "",
      "### 当前主问题 / 当天主线",
      "- 周一清晨例行心跳检查，无主动用户请求。",
      "",
      "### 主要任务推进",
      "- 无可靠新增项。",
      "",
      "### 负向反馈 / 失败信号",
      "- 心跳检查期间出现 Connection error，连续重试后无法正常响应。",
      "",
      "### 风险 / 注意点",
      "- 上游连接不稳定，可能影响后续心跳轮询。",
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
      "### 用户偏好",
      "- 用户偏好官方资料。",
      "",
      "### 重要决策",
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
      "### 重要决策",
      "- 网关重试策略改为指数退避。",
    ].join("\n");

    expect(hasReliableSummaryAdditions(summary)).toBe(true);
  });
});
