import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { SessionsListResult } from "../types.ts";
import { renderSessions, type SessionsProps } from "./sessions.ts";

function buildResult(...sessions: SessionsListResult["sessions"]): SessionsListResult {
  return {
    ts: Date.now(),
    path: "(multiple)",
    count: sessions.length,
    defaults: { model: null, contextTokens: null },
    sessions,
  };
}

function buildProps(result: SessionsListResult): SessionsProps {
  return {
    loading: false,
    result,
    error: null,
    activeMinutes: "",
    limit: "120",
    includeGlobal: false,
    includeUnknown: false,
    basePath: "",
    onFiltersChange: () => undefined,
    onRefresh: () => undefined,
    onPatch: () => undefined,
    onDelete: () => undefined,
  };
}

describe("sessions view", () => {
  it("renders verbose=full without falling back to inherit", async () => {
    const container = document.createElement("div");
    render(
      renderSessions(
        buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
            verboseLevel: "full",
          }),
        ),
      ),
      container,
    );
    await Promise.resolve();

    const selects = container.querySelectorAll("select");
    const verbose = selects[1] as HTMLSelectElement | undefined;
    expect(verbose?.value).toBe("full");
    expect(Array.from(verbose?.options ?? []).some((option) => option.value === "full")).toBe(true);
  });

  it("keeps unknown stored values selectable instead of forcing inherit", async () => {
    const container = document.createElement("div");
    render(
      renderSessions(
        buildProps(
          buildResult({
            key: "agent:main:main",
            kind: "direct",
            updatedAt: Date.now(),
            reasoningLevel: "custom-mode",
          }),
        ),
      ),
      container,
    );
    await Promise.resolve();

    const selects = container.querySelectorAll("select");
    const reasoning = selects[2] as HTMLSelectElement | undefined;
    expect(reasoning?.value).toBe("custom-mode");
    expect(
      Array.from(reasoning?.options ?? []).some((option) => option.value === "custom-mode"),
    ).toBe(true);
  });

  it("does not render heartbeat-only sessions", async () => {
    const container = document.createElement("div");
    render(
      renderSessions(
        buildProps(
          buildResult(
            {
              key: "agent:ops:main",
              kind: "direct",
              displayName: "heartbeat",
              updatedAt: Date.now(),
              deliveryContext: { to: "heartbeat" },
              lastTo: "heartbeat",
              origin: {
                label: "heartbeat",
                provider: "heartbeat",
                from: "heartbeat",
                to: "heartbeat",
              },
            },
            {
              key: "agent:ops:feishu:direct:user",
              kind: "direct",
              displayName: "Feishu User",
              updatedAt: Date.now(),
            },
          ),
        ),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).not.toContain("agent:ops:main");
    expect(container.textContent).not.toContain("heartbeat");
    expect(container.textContent).toContain("agent:ops:feishu:direct:user");
  });

  it("keeps ordinary sessions whose display name is heartbeat", async () => {
    const container = document.createElement("div");
    render(
      renderSessions(
        buildProps(
          buildResult({
            key: "agent:ops:manual-heartbeat",
            kind: "direct",
            displayName: "heartbeat",
            updatedAt: Date.now(),
          }),
        ),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.textContent).toContain("agent:ops:manual-heartbeat");
    expect(container.textContent).toContain("heartbeat");
  });
});
